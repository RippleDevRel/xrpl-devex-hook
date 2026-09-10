// Path resolution shared by every script in hook/.
//
// Two roots matter:
//   HOOK_DIR     where these scripts live (this repo's hook/ directory), used to
//                find devex.config.json and xrpl-allowlist.json.
//   projectDir() the participant's project root, where hooks are registered and
//                where the local .xrpl-devex/ data directory lives.
//
// projectDir() resolution order:
//   1. XRPL_DEVEX_PROJECT_DIR   explicit override, used by tests and by organizers
//   2. CLAUDE_PROJECT_DIR       set by Claude Code when running a hook
//   3. the cwd field from the hook stdin JSON, when the caller passes it
//   4. process.cwd()            skills run scripts from the project root

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = path.resolve(HOOK_DIR, "..");

export function projectDir(hint) {
  return (
    process.env.XRPL_DEVEX_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof hint === "string" && hint ? hint : "") ||
    process.cwd()
  );
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
