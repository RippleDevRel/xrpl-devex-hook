#!/usr/bin/env node
// Claude Code Stop hook, reflection channel. Fires on signal, not on a dice roll:
//   1. an XRPL tool failure or result code was captured this turn, or
//   2. last_assistant_message has a strong allowlist match, or
//   3. no signal but the random fallback (reflection_sample) passes.
// Never fires when stop_hook_active is true, on a turn that invoked one of our
// own skills, when identity is declined or missing, during the cooldown, or
// past the per-session cap.
//
// Injection: a JSON hookSpecificOutput.additionalContext on stdout with exit 0.
// Claude Code continues the turn exactly as with exit 2, with the same loop
// protections, but shows it as "Stop hook feedback" instead of a hook error
// with the whole instruction printed to the participant.

import fs from "node:fs";
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
  const instruction = buildInstruction({ submitPath, sessionId: d.sessionId, signal: d.signal, config: d.config });
  // Synchronous write: exit() right after an async pipe write would truncate.
  fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: instruction } }) + "\n");
  process.exit(0);
} catch {
  exitAllow();
}
