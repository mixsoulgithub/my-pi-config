/**
 * Sliding Context — Keep only head + tail of conversation, drop the middle.
 *
 * Simple v1: non-destructive filtering via the `context` event.
 * The LLM sees only the first turn + last N turns. Everything between is dropped.
 * Full history stays on disk for /tree, /fork, etc.
 *
 * v2 (later): auto-summarize the middle instead of dropping it entirely.
 *
 * Config in ~/.pi/agent/settings.json:
 *   { "slidingContext": { "headTurns": 1, "tailTurns": 3 } }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface SlidingConfig {
  /** How many initial user→assistant turns to keep verbatim (default 1) */
  headTurns: number;
  /** How many recent user→assistant turns to keep verbatim (default 3) */
  tailTurns: number;
}

const DEFAULTS: SlidingConfig = { headTurns: 1, tailTurns: 3 };

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
    } catch { /* file missing or invalid, try next */ }
  }
  return DEFAULTS;
}

export default function (pi: ExtensionAPI) {
  let config = DEFAULTS;

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    ctx.ui.setStatus("sliding-context", `ctx: h${config.headTurns}/t${config.tailTurns}`);
  });

  pi.on("context", async (event) => {
    const messages = event.messages;
    if (messages.length === 0) return;

    // Find turn boundaries (user messages start a new turn)
    const turnStarts: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === "user") {
        turnStarts.push(i);
      }
    }

    const totalTurns = turnStarts.length;
    const keep = config.headTurns + config.tailTurns;

    // Small conversation — keep everything
    if (totalTurns <= keep + 1) return; // +1 for some slack

    // Which turns to keep
    const headEnd = Math.min(config.headTurns, totalTurns);
    const tailStart = Math.max(headEnd, totalTurns - config.tailTurns);

    // Build filtered messages
    const kept: typeof messages = [];

    // Head: messages from turn 0 up to (but not including) tailStart
    const headCutoff = turnStarts[headEnd] ?? messages.length;
    for (let i = 0; i < headCutoff; i++) {
      kept.push(messages[i]!);
    }

    // Gap marker (helps the LLM understand context was dropped)
    if (headEnd < tailStart) {
      const droppedTurns = tailStart - headEnd;
      kept.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `[${droppedTurns} earlier turns omitted — ` +
              `keeping first ${config.headTurns} and last ${config.tailTurns} of ${totalTurns} total turns]`,
          },
        ],
        timestamp: Date.now(),
      } as any);
    }

    // Tail: everything from tailStart onward
    const tailCutoff = turnStarts[tailStart] ?? messages.length;
    for (let i = tailCutoff; i < messages.length; i++) {
      kept.push(messages[i]!);
    }

    return { messages: kept };
  });

}
