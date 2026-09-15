import type { IpcMainInvokeEvent } from "electron";
import { execFile as execFileCallback } from "child_process";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

export type OrionUpdateStatus =
    | "updated"
    | "busy"
    | "unsupported-install"
    | "dirty"
    | "custom-checkout"
    | "source-mismatch"
    | "invalid-version"
    | "target-mismatch"
    | "build-failed"
    | "rollback-failed"
    | "failed";

export interface OrionUpdateResult {
    ok: boolean;
    status: OrionUpdateStatus;
    message: string;
    fromVersion?: string;
    toVersion?: string;
    fromCommit?: string;
    toCommit?: string;
    restartRequired?: boolean;
}

interface ParsedSemver {
    major: number;
    minor: number;
    patch: number;
    prerelease: readonly (string | number)[];
}

const execFile = promisify(execFileCallback);
const VENCORD_SRC_DIR = join(__dirname, "..");
const USERPLUGINS_DIR = join(VENCORD_SRC_DIR, "src", "userplugins");
const OFFICIAL_REPO = "https://github.com/nyxxbit/discord-quest-completer";
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MAX_BUFFER = 16 * 1024 * 1024;
let updateInFlight = false;

function normalizeRepoUrl(value: string): string {
    return value.trim()
        .replace(/^git@github\.com:/i, "https://github.com/")
        .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
        .replace(/\.git$/i, "")
        .replace(/\/$/, "")
        .toLowerCase();
}

function parseVersion(value: unknown): ParsedSemver | null {
    if (typeof value !== "string") return null;
    const match = VERSION_PATTERN.exec(value.trim());
    if (!match) return null;

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger)) return null;

    const prerelease = match[4]
        ? match[4].split(".").map(part => /^\d+$/.test(part) ? Number(part) : part)
        : [];
    return { major, minor, patch, prerelease };
}

function compareVersion(left: ParsedSemver, right: ParsedSemver): number {
    for (const key of ["major", "minor", "patch"] as const) {
        if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
    }

    if (left.prerelease.length === 0 || right.prerelease.length === 0) {
        if (left.prerelease.length === right.prerelease.length) return 0;
        return left.prerelease.length === 0 ? 1 : -1;
    }

    const count = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < count; index++) {
        const a = left.prerelease[index];
        const b = right.prerelease[index];
        if (a === undefined) return -1;
        if (b === undefined) return 1;
        if (a === b) continue;

        const aNumber = typeof a === "number";
        const bNumber = typeof b === "number";
        if (aNumber && bNumber) return a < b ? -1 : 1;
        if (aNumber !== bNumber) return aNumber ? -1 : 1;
        return String(a).localeCompare(String(b)) < 0 ? -1 : 1;
    }

    return 0;
}

function sourceVersion(source: string): string | null {
    return /export\s+const\s+PLUGIN_VERSION\s*=\s*["']([^"']+)["']/.exec(source)?.[1]?.trim() ?? null;
}

async function exists(path: string): Promise<boolean> {
    try { await stat(path); return true; }
    catch { return false; }
}

async function run(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; }> {
    const result = await execFile(command, args, {
        cwd,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8"
    });
    return {
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? "")
    };
}

async function gitText(dir: string, ...args: string[]): Promise<string> {
    return (await run("git", args, dir)).stdout.trim();
}

async function deleteRef(dir: string, ref: string): Promise<void> {
    try { await run("git", ["update-ref", "-d", ref], dir); } catch { }
}

async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
        await run("git", ["merge-base", "--is-ancestor", ancestor, descendant], dir);
        return true;
    } catch {
        return false;
    }
}

async function currentBranch(dir: string): Promise<string | null> {
    try {
        const branch = await gitText(dir, "symbolic-ref", "--quiet", "--short", "HEAD");
        return branch || null;
    } catch {
        return null;
    }
}

async function locateManagedCheckout(): Promise<string | null> {
    let names: string[];
    try { names = await readdir(USERPLUGINS_DIR); }
    catch { return null; }

    const matches: string[] = [];
    for (const name of names) {
        const dir = join(USERPLUGINS_DIR, name);
        const entry = join(dir, "index.tsx");
        if (!await exists(entry)) continue;

        let source = "";
        try { source = await readFile(entry, "utf8"); } catch { continue; }
        if (!/name\s*:\s*["']OrionQuests["']/.test(source) || !sourceVersion(source)) continue;

        let origin = "";
        try { origin = await gitText(dir, "remote", "get-url", "origin"); } catch { continue; }
        if (normalizeRepoUrl(origin) === OFFICIAL_REPO) matches.push(dir);
    }

    return matches.length === 1 ? matches[0] : null;
}

async function buildVencord(): Promise<void> {
    const args = ["scripts/build/build.mjs"];
    if (IS_DEV) args.push("--dev");

    const isFlatpak = process.platform === "linux" && Boolean(process.env.FLATPAK_ID);
    if (isFlatpak) await run("flatpak-spawn", ["--host", "node", ...args], VENCORD_SRC_DIR);
    else await run("node", args, VENCORD_SRC_DIR);
}

export async function updateOrionRelease(
    _: IpcMainInvokeEvent,
    runningVersionInput: string,
    targetVersionInput: string
): Promise<OrionUpdateResult> {
    if (updateInFlight) {
        return { ok: false, status: "busy", message: "An OrionQuests update is already running." };
    }

    const runningVersion = String(runningVersionInput ?? "").trim();
    const targetVersion = String(targetVersionInput ?? "").trim();
    const runningParsed = parseVersion(runningVersion);
    const targetParsed = parseVersion(targetVersion);
    if (!runningParsed || !targetParsed || !targetVersion.startsWith("v") || compareVersion(targetParsed, runningParsed) <= 0) {
        return {
            ok: false,
            status: "invalid-version",
            message: "OrionQuests refused an invalid or non-upgrade release target."
        };
    }

    updateInFlight = true;
    let checkout: string | null = null;
    let tagRef: string | null = null;
    try {
        checkout = await locateManagedCheckout();
        if (!checkout) {
            return {
                ok: false,
                status: "unsupported-install",
                message: "OrionQuests could not find exactly one managed checkout from nyxxbit/discord-quest-completer in this Vencord source tree."
            };
        }

        const branch = await currentBranch(checkout);
        if (branch !== "main") {
            return {
                ok: false,
                status: "custom-checkout",
                message: "Automatic OrionQuests updates only modify the clean official main checkout. This checkout was left untouched."
            };
        }

        const dirty = await gitText(checkout, "status", "--porcelain", "--untracked-files=all");
        if (dirty) {
            return {
                ok: false,
                status: "dirty",
                message: "OrionQuests has local file changes. Automatic update will not overwrite them."
            };
        }

        const worktreeSource = await readFile(join(checkout, "index.tsx"), "utf8");
        const checkoutVersion = sourceVersion(worktreeSource);
        if (checkoutVersion !== runningVersion) {
            return {
                ok: false,
                status: "source-mismatch",
                message: `The loaded OrionQuests version is ${runningVersion}, but its source checkout reports ${checkoutVersion ?? "an unknown version"}. Restart or repair Orion before updating.`,
                fromVersion: runningVersion,
                toVersion: targetVersion
            };
        }

        const currentHead = await gitText(checkout, "rev-parse", "HEAD");
        let previousRemoteMain: string | null = null;
        try { previousRemoteMain = await gitText(checkout, "rev-parse", "--verify", "refs/remotes/origin/main"); } catch { }

        const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        tagRef = `refs/orion-update/tag-${token}`;
        await run("git", [
            "fetch", "--atomic", "--force", "--no-tags", "origin",
            `refs/tags/${targetVersion}:${tagRef}`,
            "+refs/heads/main:refs/remotes/origin/main"
        ], checkout);

        const targetCommit = await gitText(checkout, "rev-parse", `${tagRef}^{}`);
        const remoteMain = await gitText(checkout, "rev-parse", "refs/remotes/origin/main");
        const targetSource = (await run("git", ["show", `${targetCommit}:index.tsx`], checkout)).stdout;
        if (sourceVersion(targetSource) !== targetVersion) {
            return {
                ok: false,
                status: "target-mismatch",
                message: `The ${targetVersion} tag does not declare the same OrionQuests plugin version.`,
                fromVersion: runningVersion,
                toVersion: targetVersion,
                fromCommit: currentHead,
                toCommit: targetCommit
            };
        }
        if (!await isAncestor(checkout, targetCommit, remoteMain)) {
            return {
                ok: false,
                status: "target-mismatch",
                message: `The ${targetVersion} release is not on OrionQuests' current official main history.`,
                fromVersion: runningVersion,
                toVersion: targetVersion,
                fromCommit: currentHead,
                toCommit: targetCommit
            };
        }

        const currentOnRemoteHistory = await isAncestor(checkout, currentHead, remoteMain);
        const rewriteSafe = previousRemoteMain != null && currentHead === previousRemoteMain;
        if (!currentOnRemoteHistory && !rewriteSafe) {
            return {
                ok: false,
                status: "custom-checkout",
                message: "OrionQuests has local/divergent commits. Automatic update will not reset them.",
                fromVersion: runningVersion,
                toVersion: targetVersion,
                fromCommit: currentHead,
                toCommit: targetCommit
            };
        }

        const statusBeforeReset = await gitText(checkout, "status", "--porcelain", "--untracked-files=all");
        const headBeforeReset = await gitText(checkout, "rev-parse", "HEAD");
        const branchBeforeReset = await currentBranch(checkout);
        if (statusBeforeReset || headBeforeReset !== currentHead || branchBeforeReset !== "main") {
            return {
                ok: false,
                status: "dirty",
                message: "OrionQuests checkout changed during update preflight. Nothing was overwritten."
            };
        }

        await run("git", ["reset", "--hard", targetCommit], checkout);
        try {
            await buildVencord();
        } catch {
            try {
                await run("git", ["reset", "--hard", currentHead], checkout);
                await buildVencord();
            } catch (rollbackError) {
                return {
                    ok: false,
                    status: "rollback-failed",
                    message: `The update build failed and OrionQuests could not fully rebuild the previous checkout: ${rollbackError instanceof Error ? rollbackError.message : "unknown rollback error"}`,
                    fromVersion: runningVersion,
                    toVersion: targetVersion,
                    fromCommit: currentHead,
                    toCommit: targetCommit
                };
            }

            return {
                ok: false,
                status: "build-failed",
                message: `The ${targetVersion} build failed. OrionQuests restored ${runningVersion} and rebuilt the previous checkout successfully.`,
                fromVersion: runningVersion,
                toVersion: targetVersion,
                fromCommit: currentHead,
                toCommit: targetCommit
            };
        }

        return {
            ok: true,
            status: "updated",
            message: `OrionQuests updated from ${runningVersion} to ${targetVersion}. Restart Discord to load the new build.`,
            fromVersion: runningVersion,
            toVersion: targetVersion,
            fromCommit: currentHead,
            toCommit: targetCommit,
            restartRequired: true
        };
    } catch (error) {
        return {
            ok: false,
            status: "failed",
            message: error instanceof Error ? error.message : "OrionQuests update failed before the checkout was changed."
        };
    } finally {
        if (checkout && tagRef) await deleteRef(checkout, tagRef);
        updateInFlight = false;
    }
}
