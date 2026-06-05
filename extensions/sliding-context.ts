/**
 * Sliding Context v2 — Summarize middle turns, keep head + summary + tail.
 *
 * How it works:
 * 1. On `turn_end`: when middle turns exceed threshold, summarize the new ones
 *    using the same model (or a cheaper one) via `complete()`.
 * 2. Summary is stored as a custom entry in the session.
 * 3. On `context`: the LLM sees head + summary + tail.
 * 4. On `session_start`: restore the running summary from session.
 *
 * Full history stays on disk for /tree, /fork, etc.
 *
 * Config in ~/.pi/agent/settings.json:
 *   { "slidingContext": { "headTurns": 1, "tailTurns": 3 } }
 */

import { complete } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface SlidingConfig {
  headTurns: number;
  tailTurns: number;
}

const DEFAULTS: SlidingConfig = { headTurns: 1, tailTurns: 3 };
const CUSTOM_TYPE = "sliding-context-summary";

function loadConfig(cwd: string): SlidingConfig {
  const sources = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];
  for (const path of sources) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const cfg = raw?.slidingContext;
      if (cfg && typeof cfg === "object") {
        return {
          headTurns: typeof cfg.headTurns === "number" ? cfg.headTurns : DEFAULTS.headTurns,
          tailTurns: typeof cfg.tailTurns === "number" ? cfg.tailTurns : DEFAULTS.tailTurns,
        };
      }
    } catch { /* skip */ }
  }
  return DEFAULTS;
}

/** Find indices of user messages (turn starts) in a message array */
function turnStarts(msgs: Message[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]!.role === "user") starts.push(i);
  }
  return starts;
}

export default function (pi: ExtensionAPI) {
  let config = DEFAULTS;
  /** Running summary text, restored from session on start */
  let runningSummary = "";

  // ── Restore summary from session ──────────────────────────────────
  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    runningSummary = "";
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
        runningSummary = (entry.data?.summary as string) ?? "";
      }
    }
    ctx.ui.setStatus("sliding-context", `sum: ${runningSummary ? "✓" : "—"} h${config.headTurns}/t${config.tailTurns}`);
  });

  // ── After each turn, summarize new middle entries ─────────────────
  pi.on("turn_end", async (event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const ts = turnStarts(entries as unknown as Message[]);

    const totalTurns = ts.length;
    const keep = config.headTurns + config.tailTurns;
    if (totalTurns <= keep + 1) return; // too small, skip

    const headEnd = Math.min(config.headTurns, totalTurns);
    const tailStart = Math.max(headEnd, totalTurns - config.tailTurns);

    // Extract messages from entries for summarization
    const middleMessages = entries
      .slice(ts[headEnd]!, ts[tailStart]!)
      .filter((e) => e.type === "message")
      .map((e) => (e as any).message);
    if (middleMessages.length === 0) return;

    // Only summarize if there are actual assistant messages
    const hasNewContent = middleMessages.some(
      (m: any) => m.role === "assistant",
    );
    if (!hasNewContent) return;

    // Use the active model for summarization
    const model = ctx.model;
    if (!model) return;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      ctx.ui.notify("sliding-context: no API key for summarization", "warning");
      return;
    }

    ctx.ui.notify(
      `sliding-context: summarizing ${middleMessages.length} middle messages…`,
      "info",
    );

    const conversationText = serializeConversation(
      convertToLlm(middleMessages),
    );

    const previousCtx = runningSummary
      ? `\nPrevious summary for continuity:\n${runningSummary}\n`
      : "";

    const summaryMessages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `Summarize this conversation segment concisely. Focus on:
- Key decisions, code changes, and their rationale
- Current state of work and open issues
- Next steps planned${previousCtx}

${conversationText}

Write the summary in plain paragraphs (no markdown headings).`,
          },
        ],
        timestamp: Date.now(),
      },
    ];

    try {
      const response = await complete(model, { messages: summaryMessages }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 4096,
      });

      const newSummary = response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");

      if (!newSummary.trim()) return;

      // Append to running summary
      runningSummary = runningSummary
        ? `${runningSummary}\n\n---\n\n${newSummary}`
        : newSummary;

      // Persist in session (non-destructive — never touches LLM context)
      pi.appendEntry(CUSTOM_TYPE, { summary: runningSummary });

      ctx.ui.setStatus("sliding-context", `sum: ✓ h${config.headTurns}/t${config.tailTurns}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`sliding-context: ${msg}`, "error");
    }
  });

  // ── Filter what the LLM sees ──────────────────────────────────────
  pi.on("context", async (event) => {
    const messages = event.messages;
    if (messages.length === 0) return;

    const ts = turnStarts(messages);
    const totalTurns = ts.length;
    const keep = config.headTurns + config.tailTurns;
    if (totalTurns <= keep + 1) return;

    const headEnd = Math.min(config.headTurns, totalTurns);
    const tailStart = Math.max(headEnd, totalTurns - config.tailTurns);

    const headCutoff = ts[headEnd] ?? messages.length;

    // Build filtered view: head + summary + tail
    const filtered: typeof messages = [];

    // Head
    for (let i = 0; i < headCutoff; i++) {
      filtered.push(messages[i]!);
    }

    // Running summary (inserted as a synthetic user message)
    if (runningSummary) {
      filtered.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `[Summary of previous ${tailStart - headEnd} turns:]\n${runningSummary}`,
          },
        ],
        timestamp: Date.now(),
      } as any);
    }

    // Tail
    const tailCutoff = ts[tailStart] ?? messages.length;
    for (let i = tailCutoff; i < messages.length; i++) {
      filtered.push(messages[i]!);
    }

    return { messages: filtered };
  });
}
