// Path resolution shared by every script in hook/.
//
// Two roots matter:
//   HOOK_DIR     where these scripts live (this repo's hook/ directory), used to
//                find devex.config.json and xrpl-allowlist.json.
//   projectDir() the participant's project root, where hooks are registered and
//                where the local .xrpl-devex/ data directory lives.
//
// projectDir() resolution order:
//   1. XRPL_DEVEX_PROJECT_DIR   explicit override, used as is by tests and organizers
//   2. CLAUDE_PROJECT_DIR       set by Claude Code when running a hook
//   3. the cwd field from the hook stdin JSON, when the caller passes it
//   4. process.cwd()            skills run scripts from the project root
// Starting points 2 to 4 are walked up to the nearest directory holding
// .xrpl-devex/ (an existing install), else the nearest one holding an agent
// config dir, never reaching the home directory. Windows roots handed over in
// POSIX form by Cursor (/c:/Users/...) are normalised first.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = path.resolve(HOOK_DIR, "..");

// Directories that mark a project root for one of the supported agents.
export const AGENT_CONFIG_DIRS = [".claude", ".cursor", ".codex", ".grok", path.join(".github", "hooks")];

// The platform the scripts behave as; XRPL_DEVEX_PLATFORM lets tests exercise
// the Windows branches on any machine.
export function platform() {
  return process.env.XRPL_DEVEX_PLATFORM || process.platform;
}

// "/c:/Users/dev/proj" and "C:/Users/dev/proj" become "C:\Users\dev\proj" on
// win32; other platforms and shapes are returned unchanged.
export function normalizeRoot(p, plat = platform()) {
  if (typeof p !== "string" || !p || plat !== "win32") return p;
  const m = p.match(/^\/?([A-Za-z]):[\\/](.*)$/);
  if (!m) return p;
  const rest = m[2].replace(/\//g, "\\").replace(/\\+$/, "");
  return `${m[1].toUpperCase()}:\\${rest}`;
}

// The path module matching platform(), so a normalised Windows root is walked
// with Windows rules even when the override runs on another machine.
function pathFor(plat) {
  return plat === "win32" ? path.win32 : path;
}

function hasAny(P, dir, names) {
  return names.some((n) => fs.existsSync(P.join(dir, n)));
}

// Walks up from start and returns the nearest ancestor (start included) that
// holds one of the marker names, stopping before the home directory.
function nearestWith(P, start, names, home) {
  let dir = start;
  for (;;) {
    if (dir === home) return null;
    if (hasAny(P, dir, names)) return dir;
    const parent = P.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The project root for a starting directory: an existing .xrpl-devex/ wins
// over a nearer agent config dir, and the start itself is kept when nothing
// is found (first setup in a fresh project).
export function findProjectRoot(start, { home = os.homedir(), plat = platform() } = {}) {
  const P = pathFor(plat);
  const from = P.resolve(start);
  return nearestWith(P, from, [".xrpl-devex"], home) || nearestWith(P, from, AGENT_CONFIG_DIRS, home) || from;
}

export function projectDir(hint) {
  if (process.env.XRPL_DEVEX_PROJECT_DIR) return normalizeRoot(process.env.XRPL_DEVEX_PROJECT_DIR);
  const start = process.env.CLAUDE_PROJECT_DIR || (typeof hint === "string" && hint ? hint : "") || process.cwd();
  return findProjectRoot(normalizeRoot(start));
}

export function dataDir(hint) {
  return path.join(projectDir(hint), ".xrpl-devex");
}

export function dataPaths(hint) {
  const root = dataDir(hint);
  return {
    root,
    identity: path.join(root, "identity.json"),
    state: path.join(root, "state.json"),
    buffer: path.join(root, "buffer.jsonl"),
    flushing: path.join(root, "buffer.flushing.jsonl"),
    sent: path.join(root, "sent.jsonl"),
    pendingAnalyses: path.join(root, "pending-analyses"),
    reports: path.join(root, "reports"),
    analysesLog: path.join(root, "analyses.log"),
    submitState: path.join(root, "submit-state.json"),
    debugLog: path.join(root, "debug.log"),
  };
}

export function ensureDataDir(hint) {
  const p = dataPaths(hint);
  fs.mkdirSync(p.root, { recursive: true });
  return p;
}

// Forward slashes keep emitted JSON valid on every platform.
export function fwd(p) {
  return p.split(path.sep).join("/");
}
