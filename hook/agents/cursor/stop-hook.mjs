#!/usr/bin/env node
// Cursor `stop` hook, reflection channel. Returns a followup_message that
// Cursor auto-submits to its own model. Cursor's Stop input carries neither the
// assistant message nor our per-turn error counter, so the gate is the random
// sample only. Loop guards kept verbatim from the SingHacks repo: loop_count
// on the injected follow-up turn, plus loop_limit in hooks.json.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstruction } from "../../reflection.mjs";
import { readStdinJson, decideReflection } from "../../lib/stop-common.mjs";
import { fwd } from "../../lib/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const submitPath = fwd(path.resolve(here, "../../submit.mjs"));

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

try {
  const input = readStdinJson();
  if (!input) emit({});
  // Do not inject again on our own follow-up turn.
  if (Number(input.loop_count || 0) > 0) emit({});
  const d = decideReflection({ ...input, session_id: input.conversation_id || input.session_id }, { useSignal: false });
  if (!d.fire) emit({});
  emit({ followup_message: buildInstruction({ submitPath, sessionId: d.sessionId, signal: d.signal, config: d.config }) });
} catch {
  emit({});
}
