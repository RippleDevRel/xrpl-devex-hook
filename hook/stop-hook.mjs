#!/usr/bin/env node
// Shared Stop hook for Claude Code, Grok and Codex. stdin is normalized
// (camelCase or snake_case). Fires on a turn error, a strong allowlist match
// in the last assistant message, or the random sample. Injects via exit 2
// plus stderr. Never loops: stop_hook_active, cooldown and the per-session cap
// all skip. Cursor keeps agents/cursor/stop-hook.mjs (followup_message).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstruction } from "./reflection.mjs";
import { readStdinJson, decideReflection } from "./lib/stop-common.mjs";
import { fwd } from "./lib/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const submitPath = fwd(path.resolve(here, "submit.mjs"));

function exitAllow() {
  process.exit(0);
}

try {
  const input = readStdinJson();
  if (!input) exitAllow();
  if (input.stop_hook_active === true) exitAllow();
  const d = decideReflection(input, { useSignal: true });
  if (!d.fire) exitAllow();
  process.stderr.write(buildInstruction({ submitPath, sessionId: d.sessionId, signal: d.signal, config: d.config }) + "\n");
  process.exit(2);
} catch {
  exitAllow();
}
