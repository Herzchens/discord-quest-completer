/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CONSOLE_ONLY_KEYS, isConsoleOnly, selectTaskKey } from "../questConfig";

const PLAY = { match: (k: string) => k.startsWith("PLAY"), prefer: ["PLAY_ON_DESKTOP"] };
const VIDEO = { match: (k: string) => k.includes("VIDEO"), prefer: ["WATCH_VIDEO"] };
const STREAM = { match: (k: string) => k.startsWith("STREAM"), prefer: ["STREAM_ON_DESKTOP"] };
const ACTIVITY = { match: (k: string) => k === "PLAY_ACTIVITY" };

test("the desktop key wins whatever order the server listed the tasks in", () => {
    // The real shapes seen on a live account, and the same shapes reversed. Server key order is
    // not a contract, and relying on it is what this rule exists to stop.
    for (const keys of [
        ["PLAY_ON_DESKTOP", "PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"],
        ["PLAY_ON_PLAYSTATION", "PLAY_ON_XBOX", "PLAY_ON_DESKTOP"],
        ["PLAY_ON_XBOX", "PLAY_ON_DESKTOP"],
    ]) {
        assert.equal(selectTaskKey(keys, PLAY), "PLAY_ON_DESKTOP", keys.join(","));
    }
});

test("the desktop video key wins over the mobile one in either order", () => {
    assert.equal(selectTaskKey(["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE"], VIDEO), "WATCH_VIDEO");
    assert.equal(selectTaskKey(["WATCH_VIDEO_ON_MOBILE", "WATCH_VIDEO"], VIDEO), "WATCH_VIDEO");
});

test("a mobile-only video quest still resolves, because the endpoint is the same either way", () => {
    assert.equal(selectTaskKey(["WATCH_VIDEO_ON_MOBILE"], VIDEO), "WATCH_VIDEO_ON_MOBILE");
});

test("a console key is never selected, even when it is the only thing the rule matches", () => {
    assert.equal(selectTaskKey(["PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"], PLAY), undefined);
    assert.equal(selectTaskKey(["PLAY_ON_PLAYSTATION"], PLAY), undefined);
});

test("PLAY_ACTIVITY is not swallowed by the console exclusion", () => {
    assert.equal(selectTaskKey(["PLAY_ACTIVITY"], ACTIVITY), "PLAY_ACTIVITY");
    // and the PLAY rule would take it too, since it is a desktop-capable PLAY key
    assert.equal(selectTaskKey(["PLAY_ACTIVITY"], PLAY), "PLAY_ACTIVITY");
});

test("stream prefers the desktop key and ignores anything console-shaped", () => {
    assert.equal(selectTaskKey(["STREAM_ON_DESKTOP"], STREAM), "STREAM_ON_DESKTOP");
    assert.equal(selectTaskKey([], STREAM), undefined);
});

test("a rule with no prefer list still refuses console keys", () => {
    const bare = { match: (k: string) => k.startsWith("PLAY") };
    assert.equal(selectTaskKey(["PLAY_ON_XBOX", "PLAY_ON_DESKTOP"], bare), "PLAY_ON_DESKTOP");
    assert.equal(selectTaskKey(["PLAY_ON_XBOX"], bare), undefined);
});

test("console-only quests are identified so they can be skipped honestly", () => {
    assert.equal(isConsoleOnly(["PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"]), true);
    assert.equal(isConsoleOnly(["PLAY_ON_DESKTOP", "PLAY_ON_XBOX"]), false);
    assert.equal(isConsoleOnly(["WATCH_VIDEO"]), false);
    // an empty task list is a malformed quest, not a console one, and has its own handling
    assert.equal(isConsoleOnly([]), false);
});

test("the console set holds exactly the keys Discord groups as CONSOLE", () => {
    assert.deepEqual([...CONSOLE_ONLY_KEYS].sort(), ["PLAY_ON_PLAYSTATION", "PLAY_ON_XBOX"]);
});
