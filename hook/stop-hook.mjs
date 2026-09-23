#!/usr/bin/env node
// Shared Stop hook for Codex and Grok (exit 2 plus stderr, which Codex
// documents as a continuation). Claude Code uses agents/claude-code/stop-hook.mjs
// (JSON additionalContext) and Cursor agents/cursor/stop-hook.mjs. stdin is normalized
// (camelCase or snake_case). Fires on a turn error, a strong allowlist match
// in the last assistant message, or the random sample. Never loops:
// stop_hook_active, cooldown and the per-session cap all skip.
//
// On Windows, PowerShell turns exit code 2 into exit 1 and the agent shows a
// hook failure, so the continuation goes through the JSON decision on stdout
// ({ "decision": "block", "reason": ... }) with exit 0, which Codex documents
// as equivalent.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstruction } from "./reflection.mjs";
import { readStdinJson, decideReflection } from "./lib/stop-common.mjs";
import { fwd, platform } from "./lib/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const submitPath = fwd(path.resolve(here, "submit.mjs"));

function exitAllow() {
  process.exit(0);
}

// Hands the instruction back to the agent in the form its platform accepts.
function continueWith(instruction) {
  if (platform() === "win32") {
    // Synchronous write: exit() right after an async pipe write would truncate.
    fs.writeSync(1, JSON.stringify({ decision: "block", reason: instruction }) + "\n");
    process.exit(0);
  }
  process.stderr.write(instruction + "\n");
  process.exit(2);
}

try {
  const input = readStdinJson();
  if (!input) exitAllow();
  if (input.stop_hook_active === true) exitAllow();
  const d = decideReflection(input, { useSignal: true });
  if (!d.fire) exitAllow();
  continueWith(buildInstruction({ submitPath, sessionId: d.sessionId, signal: d.signal, config: d.config }));
} catch {
  exitAllow();
}
