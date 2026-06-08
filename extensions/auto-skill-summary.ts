/**
 * Auto Skill-Summary Reminder Extension
 *
 * Every 5 turns (starting after turn 7), reminds the user that a
 * skill-summary checkpoint may be useful. The user can accept (runs
 * /skill:summarize-skill), delay (postpone N turns), or dismiss.
 *
 * Also detects /goal mode and enables more frequent reminders.
 *
 * Criteria for reminder:
 *   1. Turn count modulo 5 === 0 (primary cadence)
 *   2. Turn >= 8 (skip first 7 turns)
 *   3. Not already in cooldown/delay period
 *   4. At least 3 turns since last reminder or summary
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Configuration ────────────────────────────────────────────────────────────

const CHECK_INTERVAL = 5; // Remind every N turns
const MIN_TURNS_BEFORE_FIRST = 7; // Skip first N turns
const COOLDOWN_TURNS = 3; // Minimum turns between reminders

// ── State ────────────────────────────────────────────────────────────────────

let turnCount = 0;
let lastReminderTurn = -Infinity;
let lastSummaryTurn = -Infinity;
let delayUntil = 0; // Turn number to delay reminder until
let goalModeActive = false;
let enabled = true;

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    // ── Command: toggle auto-reminder ────────────────────────────────────
    pi.registerCommand("auto-summary-toggle", {
        description: "Toggle automatic skill-summary reminders on/off",
        handler: async (_args, ctx) => {
            enabled = !enabled;
            if (ctx.hasUI) {
                ctx.ui.notify(
                    `Skill-summary reminders: ${enabled ? "ON" : "OFF"}`,
                    enabled ? "info" : "warning",
                );
            }
        },
    });

    // ── Command: show status ─────────────────────────────────────────────
    pi.registerCommand("auto-summary-status", {
        description: "Show skill-summary reminder state",
        handler: async (_args, ctx) => {
            const usage = ctx.getContextUsage();
            const lines = [
                `Reminders: ${enabled ? "ON" : "OFF"}`,
                `Goal mode: ${goalModeActive ? "active" : "inactive"}`,
                `Current turn: ${turnCount}`,
                `Next check at turn: ${Math.ceil(turnCount / CHECK_INTERVAL) * CHECK_INTERVAL}`,
                `Last reminder: ${lastReminderTurn === -Infinity ? "never" : String(lastReminderTurn)}`,
                `Last summary: ${lastSummaryTurn === -Infinity ? "never" : String(lastSummaryTurn)}`,
                `Delay until turn: ${delayUntil > turnCount ? String(delayUntil) : "none"}`,
                `Context: ${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} tokens`,
            ];
            if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
        },
    });

    // ── Command: manual trigger ──────────────────────────────────────────
    pi.registerCommand("summarize-now", {
        description: "Trigger skill-summary immediately",
        handler: async (_args, ctx) => {
            lastSummaryTurn = turnCount;
            lastReminderTurn = turnCount;
            if (ctx.hasUI) ctx.ui.notify("Triggering skill summary...", "info");
            pi.sendUserMessage("/skill:summarize-skill");
        },
    });

    // ── Detect /goal mode from user input ────────────────────────────────
    pi.on("input", (_event) => {
        // Check if user typed /goal (prompt template)
        if (_event.text.trim().startsWith("/goal")) {
            goalModeActive = true;
        }
    });

    // ── Main loop: check every turn ──────────────────────────────────────
    pi.on("turn_end", async (_event, ctx) => {
        if (!enabled) return;

        turnCount += 1;

        // Skip first N turns
        if (turnCount <= MIN_TURNS_BEFORE_FIRST) return;

        // Only check on interval cadence
        if (turnCount % CHECK_INTERVAL !== 0) return;

        // Respect user delay
        if (turnCount < delayUntil) return;

        // Cooldown after last reminder or summary
        const turnsSinceLastAction = Math.min(
            turnCount - lastReminderTurn,
            turnCount - lastSummaryTurn,
        );
        if (turnsSinceLastAction < COOLDOWN_TURNS) return;

        // ── Show reminder ──────────────────────────────────────────────
        lastReminderTurn = turnCount;

        const modeTag = goalModeActive ? " [GOAL]" : "";

        if (!ctx.hasUI) {
            // Non-interactive: auto-trigger
            lastSummaryTurn = turnCount;
            pi.sendUserMessage("/skill:summarize-skill");
            return;
        }

        const choice = await ctx.ui.select(
            `Turn ${turnCount}${modeTag} -- Summarize skills?`,
            [
                { value: "yes", label: "[Y] Summarize now" },
                { value: "delay5", label: "[5] Remind in 5 turns" },
                { value: "delay10", label: "[10] Remind in 10 turns" },
                { value: "no", label: "[X] Skip this session" },
            ],
        );

        switch (choice) {
            case "yes": {
                lastSummaryTurn = turnCount;
                ctx.ui.notify("Triggering skill summary...", "info");
                pi.sendUserMessage("/skill:summarize-skill");
                break;
            }
            case "delay5": {
                delayUntil = turnCount + 5;
                ctx.ui.notify(
                    `Delayed 5 turns -- will remind at turn ${delayUntil}`,
                    "info",
                );
                break;
            }
            case "delay10": {
                delayUntil = turnCount + 10;
                ctx.ui.notify(
                    `Delayed 10 turns -- will remind at turn ${delayUntil}`,
                    "info",
                );
                break;
            }
            case "no": {
                // Disable for rest of session
                delayUntil = Infinity;
                ctx.ui.notify(
                    "Skill-summary reminders disabled for this session. Use /auto-summary-toggle to re-enable.",
                    "warning",
                );
                break;
            }
        }
    });

    // ── Reset state on new session ───────────────────────────────────────
    pi.on("session_start", () => {
        turnCount = 0;
        lastReminderTurn = -Infinity;
        lastSummaryTurn = -Infinity;
        delayUntil = 0;
        goalModeActive = false;
    });
}
