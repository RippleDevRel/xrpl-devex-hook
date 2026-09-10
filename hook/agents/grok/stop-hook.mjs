#!/usr/bin/env node
// Grok Stop hook, reflection channel. Grok's Stop gate honors exit 2 + stderr
// the same way Claude Code does, so the inject path is identical. stdin is
// camelCase (stopHookActive, lastAssistantMessage); readStdinJson normalizes
// it. Fires on signal (turn error, allowlist match, or the random sample).

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
  const d = decideReflection(input, { useSignal: true });
  if (!d.fire) exitAllow();
  process.stderr.write(buildInstruction({ submitPath, sessionId: d.sessionId, signal: d.signal, config: d.config }) + "\n");
  process.exit(2);
} catch {
  exitAllow();
}
