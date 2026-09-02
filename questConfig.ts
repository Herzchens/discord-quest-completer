/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Pure helpers for Discord's legacy taskConfig and current taskConfigV2 shapes.
 */

import type { TaskType } from "./types";

export function taskEntries(tasks: unknown): Array<[string, any]> {
    if (!tasks) return [];
    if (tasks instanceof Map) return Array.from(tasks.entries()) as Array<[string, any]>;
    if (typeof tasks === "object") return Object.entries(tasks as Record<string, any>);
    return [];
}

export function taskForKey(config: any, key: string): any | undefined {
    const tasks = config?.tasks;
    if (tasks instanceof Map) return tasks.get(key);
    return tasks?.[key];
}

/**
 * Discord's current taskConfigV2 is authoritative when it contains tasks. Some payloads keep
 * the legacy taskConfig beside it for compatibility, so nullish-coalescing legacy first can
 * silently route a quest through stale task/app metadata. Fall back to legacy only when V2 is
 * absent or carries no task entries.
 */
export function selectQuestTaskConfig(config: any): any | null {
    const current = config?.taskConfigV2;
    if (taskEntries(current?.tasks).length > 0) return current;

    const legacy = config?.taskConfig;
    if (taskEntries(legacy?.tasks).length > 0) return legacy;

    return current ?? legacy ?? null;
}

/** Console task keys. Discord groups these as CONSOLE and no desktop client can drive them. */
export const CONSOLE_ONLY_KEYS = new Set(["PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"]);

export interface TaskKeyRule {
    match: (key: string) => boolean;
    /** Exact keys that win outright, whatever order the server listed them in. */
    prefer?: string[];
}

/**
 * Pick which task key of a quest this client should drive.
 *
 * Most quests offer several: 38 of the 66 on a live account carry two or three, always a desktop
 * key beside console or mobile variants. Matching by prefix and taking whichever the server
 * happened to list first works only for as long as the server keeps listing the desktop one
 * first. If that order ever changes, Orion picks PLAY_ON_XBOX, injects a desktop process for it,
 * reads progress under a key Discord never credits, and looks healthy until it times out
 * 25 minutes later. So prefer the exact key and never match a console one.
 */
export function selectTaskKey(keys: string[], rule: TaskKeyRule): string | undefined {
    if (rule.prefer) {
        const exact = keys.find(key => rule.prefer!.includes(key));
        if (exact) return exact;
    }
    return keys.find(key => rule.match(key) && !CONSOLE_ONLY_KEYS.has(key));
}

/** True when a quest offers nothing but console tasks, so this client cannot run it at all. */
export function isConsoleOnly(keys: string[]): boolean {
    return keys.length > 0 && keys.every(key => CONSOLE_ONLY_KEYS.has(key));
}

export interface TaskFamilyRule extends TaskKeyRule {
    type: TaskType;
}

/**
 * Which family of task to drive when a quest offers more than one, in priority order.
 *
 * STREAM comes after GAME and VIDEO because STREAM cannot finish. Discord's
 * getActivelyProgressingStreamOnDesktopQuests requires a real Go Live and a second person in the
 * voice channel before it reads the stream metadata the engine fakes, so a STREAM task only ever
 * reaches its no-heartbeat watchdog. Read off Stable 1.0.9255 and Canary 1.0.1148; the working
 * through is in docs/ARCHITECTURE.md and issue #75. Ordering it above GAME sent a quest offering
 * both to the one path that cannot complete.
 *
 * The two exact rules stay in front: ACHIEVEMENT_IN_ACTIVITY and PLAY_ACTIVITY would otherwise be
 * swallowed by the PLAY prefix and run as a game.
 */
export const TASK_FAMILY_ORDER: TaskFamilyRule[] = [
    { match: key => key === "ACHIEVEMENT_IN_ACTIVITY", type: "ACHIEVEMENT" },
    { match: key => key === "PLAY_ACTIVITY", type: "ACTIVITY" },
    { match: key => key.includes("VIDEO"), type: "WATCH_VIDEO", prefer: ["WATCH_VIDEO"] },
    { match: key => key.startsWith("PLAY"), type: "GAME", prefer: ["PLAY_ON_DESKTOP"] },
    { match: key => key.startsWith("STREAM"), type: "STREAM", prefer: ["STREAM_ON_DESKTOP"] },
    { match: key => key.includes("ACTIVITY"), type: "ACTIVITY" },
];

/** The family and key this client should drive for a quest, or undefined if it can drive none. */
export function selectTaskFamily(keys: string[]): { type: TaskType; keyName: string; } | undefined {
    for (const rule of TASK_FAMILY_ORDER) {
        const keyName = selectTaskKey(keys, rule);
        if (keyName) return { type: rule.type, keyName };
    }
    return undefined;
}
