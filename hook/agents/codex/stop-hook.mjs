#!/usr/bin/env node
// Codex Stop hook, reflection channel. Codex sends the event as JSON on stdin
// (stop_hook_active, and last_assistant_message on recent versions) and lets
// the hook inject via exit 2 + stderr. Passive capture does not run in Codex,
// so the per-turn error counter is never set here; the gate is the assistant
// message match when the field is present, otherwise the random sample.
// Loop guard (stop_hook_active) kept verbatim from the SingHacks repo.

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
  if (input.stop_hook_active === true) exitAllow();
  const d = decideReflection(input, { useSignal: typeof input.last_assistant_message === "string" });
  if (!d.fire) exitAllow();
  process.stderr.write(buildInstruction({ submitPath, sessionId: d.sessionId, signal: d.signal, config: d.config }) + "\n");
  process.exit(2);
} catch {
  exitAllow();
}
