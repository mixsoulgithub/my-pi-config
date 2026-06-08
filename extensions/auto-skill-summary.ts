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
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

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

    // ── Tool: review skill summaries ─────────────────────────────────────
    pi.registerTool({
        name: "review_skill_summaries",
        label: "Review Summaries",
        description:
            "Review generated skill summary files. Shows each file to the user with [Y] Accept / [E] Edit / [R] Reject options. Call this after writing summary files.",
        parameters: Type.Object({
            summaryDir: Type.String({
                description:
                    "Absolute path to the date directory containing summary files, e.g. ~/projects/my-pi-config/skills/summaries/2026-06-08/",
            }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const dir = params.summaryDir.replace(/^~/, process.env.HOME || "/root");
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
                return {
                    content: [{ type: "text", text: `Directory not found: ${dir}` }],
                    details: {},
                    isError: true,
                };
            }

            const files = fs
                .readdirSync(dir)
                .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
                .sort();

            if (files.length === 0) {
                return {
                    content: [{ type: "text", text: `No .md files found in ${dir}` }],
                    details: {},
                };
            }

            const accepted: string[] = [];
            const edited: string[] = [];
            const rejected: string[] = [];

            for (const file of files) {
                const filePath = path.join(dir, file);
                const content = fs.readFileSync(filePath, "utf-8");
                const words = content.split(/\s+/).filter(Boolean).length;

                // Extract first heading as topic hint
                const headingMatch = content.match(/^# (.+)$/m);
                const topic = headingMatch ? headingMatch[1] : "(no heading)";

                // Show file info and wait for user choice
                const choice = await ctx.ui.select(
                    `Review: ${file} (${words}w) — ${topic}`,
                    [
                        "[Y] Accept",
                        "[E] Edit",
                        "[R] Reject",
                    ],
                );

                switch (choice) {
                    case "[Y] Accept":
                        accepted.push(file);
                        ctx.ui.notify(`Accepted: ${file}`, "info");
                        break;

                    case "[E] Edit": {
                        // Ask user what to change
                        const editPrompt = await ctx.ui.input(
                            `Edit ${file} — describe what to change:`,
                        );
                        if (!editPrompt) {
                            accepted.push(file); // empty = keep as-is
                            ctx.ui.notify(`Kept as-is: ${file}`, "info");
                            break;
                        }
                        // Queue an agent turn to apply the edit
                        pi.sendUserMessage(
                            `Edit the skill file ${filePath} according to: ${editPrompt}\n\n` +
                            `After editing, re-run validation, then tell me you're done.`,
                            { deliverAs: "followUp" },
                        );
                        edited.push(file);
                        ctx.ui.notify(`Edit queued for: ${file}`, "info");
                        break;
                    }

                    case "[R] Reject":
                        fs.unlinkSync(filePath);
                        rejected.push(file);
                        ctx.ui.notify(`Rejected: ${file}`, "warning");
                        break;
                }
            }

            // Build result message
            const lines: string[] = ["Skill summary review complete."];
            if (accepted.length) lines.push(`Accepted: ${accepted.join(", ")}`);
            if (edited.length) lines.push(`Edited (queued): ${edited.join(", ")}`);
            if (rejected.length) lines.push(`Rejected: ${rejected.join(", ")}`);

            // If any accepted, suggest git commit
            if (accepted.length > 0) {
                lines.push(
                    `\nTo commit accepted files:\n` +
                    `  cd ~/projects/my-pi-config && git add skills/summaries/ && git commit -m "skill-summary: ${accepted.join(", ")}"`,
                );
            }

            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { dir, accepted, edited, rejected },
            };
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
                "[Y] Summarize now",
                "[5] Remind in 5 turns",
                "[10] Remind in 10 turns",
                "[X] Skip this session",
            ],
        );

        switch (choice) {
            case "[Y] Summarize now": {
                lastSummaryTurn = turnCount;
                ctx.ui.notify("Triggering skill summary...", "info");
                pi.sendUserMessage("/skill:summarize-skill");
                break;
            }
            case "[5] Remind in 5 turns": {
                delayUntil = turnCount + 5;
                ctx.ui.notify(
                    `Delayed 5 turns -- will remind at turn ${delayUntil}`,
                    "info",
                );
                break;
            }
            case "[10] Remind in 10 turns": {
                delayUntil = turnCount + 10;
                ctx.ui.notify(
                    `Delayed 10 turns -- will remind at turn ${delayUntil}`,
                    "info",
                );
                break;
            }
            case "[X] Skip this session": {
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
