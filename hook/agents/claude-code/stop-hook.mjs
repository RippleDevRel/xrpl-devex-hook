#!/usr/bin/env node
// Claude Code Stop hook, reflection channel. Fires on signal, not on a dice roll:
//   1. an XRPL tool failure or result code was captured this turn, or
//   2. last_assistant_message has a strong allowlist match, or
//   3. no signal but the random fallback (reflection_sample) passes.
// Never fires when stop_hook_active is true, when identity is declined or
// missing, during the cooldown, or past the per-session cap. Injects the
// instruction via exit 2 + stderr. Registered by setup.mjs --register claude-code.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstruction } from "../../reflection.mjs";
import { readStdinJson, decideReflection } from "../../lib/stop-common.mjs";
import { fwd } from "../../lib/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const submitPath = fwd(path.resolve(here, "../../submit.mjs"));

function exitAllow() {
  process.exit(0);
}

try {
  const input = readStdinJson();
  if (!input) exitAllow();
  // Already inside a hook-triggered continuation: allow the stop, never loop.
  if (input.stop_hook_active === true) exitAllow();
  const d = decideReflection(input, { useSignal: true });
  if (!d.fire) exitAllow();
  process.stderr.write(buildInstruction({ submitPath, sessionId: d.sessionId, signal: d.signal, config: d.config }) + "\n");
  process.exit(2);
} catch {
  exitAllow();
}
