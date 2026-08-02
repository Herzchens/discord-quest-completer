/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Plugin entry. Registers metadata, the start/stop lifecycle, and
 * the /orion slash command (start | stop | status).
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import definePlugin from "@utils/types";

import { isEngineRunning, readDashboard, startOrion, stopOrion } from "./orion";
import { settings } from "./settings";

// No local `isRunning` mirror: a second flag can disagree with the engine, and when it did,
// /orion stop refused to stop an engine that was still up. startOrion() sets the engine flag
// synchronously before its first await, so this reads true immediately after the call below.
async function ensureStart(): Promise<string> {
    if (isEngineRunning()) return "Already running.";
    // fire and forget. The main loop awaits internally, teardown is handled by startOrion's finally
    startOrion();
    return "Started.";
}

function ensureStop(): string {
    if (!isEngineRunning()) return "Not running.";
    stopOrion();
    return "Stopped.";
}

function statusSummary(): string {
    const running = isEngineRunning();
    const entries = readDashboard();
    if (!running && entries.length === 0) return "Idle. Use `/orion start` to begin.";
    if (entries.length === 0) return running ? "Running. No active tasks yet." : "Idle.";
    const lines = entries.map(e => {
        const pct = e.max > 0 ? Math.min(100, (e.cur / e.max) * 100).toFixed(0) : "?";
        // The userscript parks a quest as PENDING and its dashboard draws an ENROLL button.
        // There is no dashboard here, so a bare "PENDING (0%)" would read as a stall with no
        // way to tell what unblocks it. Say what the quest is waiting for instead.
        const waiting = e.actionRequired === "ENROLL"
            ? ", waiting for you to accept it in Discord's Quests page"
            : "";
        return `• ${e.name}: ${e.status} (${pct}%)${waiting}`;
    });
    return [`${running ? "Running" : "Stopped"}, ${entries.length} task(s):`, ...lines].join("\n");
}

export default definePlugin({
    name: "OrionQuests",
    description:
        "Auto-completes Discord Quests: game, video, stream, activity, and achievement.",
    authors: [{ name: "syntt_", id: 1419678867005767783n }],
    // UserSettingsAPI is not enabled by default, and getUserSetting() throws outright
    // for plugins that don't declare it. patcher.ts needs it to flip showCurrentGame
    // off for the hideActivity setting.
    dependencies: ["UserSettingsAPI"],
    settings,

    commands: [
        {
            name: "orion",
            description: "Control the OrionQuests engine",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "action",
                    description: "Action to perform",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                    choices: [
                        { name: "start", value: "start", label: "Start the engine" },
                        { name: "stop", value: "stop", label: "Stop the engine" },
                        { name: "status", value: "status", label: "Show running tasks" },
                    ],
                },
            ],
            execute: async (args, ctx) => {
                const action = args.find(a => a.name === "action")?.value;
                let response: string;
                if (action === "start") response = await ensureStart();
                else if (action === "stop") response = ensureStop();
                else response = statusSummary();
                sendBotMessage(ctx.channel.id, { content: `**Orion**\n\`\`\`\n${response}\n\`\`\`` });
            },
        },
    ],

    async start() {
        try {
            if (settings.store.autoStart) {
                await ensureStart();
            } else {
                console.log("[OrionQuests] Plugin loaded. Use `/orion start` to begin (or enable Auto Start in settings).");
            }
        } catch (e) {
            console.error("[OrionQuests] Failed to start:", e);
        }
    },

    stop() {
        try { ensureStop(); }
        catch (e) { console.error("[OrionQuests] Failed to stop cleanly:", e); }
    },
});
