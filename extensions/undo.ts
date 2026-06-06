/**
 * /undo — Jump back to a previous user prompt.
 *
 * Shows a searchable list of all user messages in the current branch,
 * newest first. Selecting one navigates the session tree to that point,
 * restoring the prompt and discarding everything after.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("undo", {
    description: "Jump back to a previous user prompt",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      // Collect all user messages on the current branch (newest first)
      const entries = ctx.sessionManager.getEntries();
      const userEntries: Array<{
        id: string;
        text: string;
        timestamp: number;
        index: number;
      }> = [];

      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.type !== "message") continue;
        const msg = (entry as any).message;
        if (msg.role !== "user") continue;
        const text = extractText(msg.content);
        userEntries.push({
          id: entry.id,
          text: text,
          timestamp: msg.timestamp ?? entry.timestamp ?? 0,
          index: i,
        });
      }

      if (userEntries.length === 0) {
        ctx.ui.notify("No user messages to undo to.", "info");
        return;
      }

      // Build select items
      const items: SelectItem[] = userEntries.map((u, idx) => ({
        value: u.id,
        label: truncate(u.text, 80),
        description: idx === 0 ? "← current position" : `turn ${u.index}`,
      }));

      const chosen = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const container = new Container();

          container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
          );
          container.addChild(
            new Text(
              theme.fg("accent", theme.bold("Undo — pick a prompt to revert to")),
              1,
              0,
            ),
          );

          const list = new SelectList(items, Math.min(items.length, 15), {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          });
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(null);
          container.addChild(list);

          container.addChild(
            new Text(
              theme.fg("dim", "↑↓ navigate • enter select • esc cancel • type to filter"),
              1,
              0,
            ),
          );
          container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
          );

          return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data) => {
              list.handleInput(data);
              tui.requestRender();
            },
          };
        },
      );

      if (!chosen) return; // cancelled

      // Navigate to the chosen entry
      const result = await ctx.navigateTree(chosen, { summarize: false });
      if (result.cancelled) {
        ctx.ui.notify("Undo was cancelled by another extension.", "warning");
      }
    },
  });
}

/** Pull plain text from message content (string or content array) */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ");
  }
  return String(content ?? "");
}

function truncate(text: string, max: number): string {
  const firstLine = text.split("\n")[0] ?? "";
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 1) + "…";
}
