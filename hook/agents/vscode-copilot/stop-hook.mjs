#!/usr/bin/env node
// GitHub Copilot Stop hook (VS Code agent hooks and Copilot CLI agentStop).
// Both continue the agent through a JSON decision on stdout, not through exit
// code 2 (which VS Code shows as an error and the CLI treats as a warning):
//   { "decision": "block", "reason": "<instruction>" } plus the same inside
//   hookSpecificOutput for the VS Code schema. stop_hook_active is documented
// on both; a short cooldown file remains as a second loop guard. Gate is
// signal-first once passive capture fills the per-turn error counter.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildInstruction } from "../../reflection.mjs";
import { readStdinJson, decideReflection } from "../../lib/stop-common.mjs";
import { fwd } from "../../lib/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const submitPath = fwd(path.resolve(here, "../../submit.mjs"));
const COOLDOWN_MS = 8000;

function exitAllow() {
  process.exit(0);
}

try {
  const input = readStdinJson();
  if (!input) exitAllow();
  if (input.stop_hook_active === true) exitAllow();
  try {
    const sid = String(input.session_id || input.sessionId || "default");
    const key = crypto.createHash("sha256").update("vscode:" + sid).digest("hex").slice(0, 16);
    const statePath = path.join(os.tmpdir(), `xrpl-devex-vscode-${key}.ts`);
    const now = Date.now();
    if (fs.existsSync(statePath)) {
      const last = Number(fs.readFileSync(statePath, "utf8")) || 0;
      if (now - last < COOLDOWN_MS) exitAllow();
    }
    fs.writeFileSync(statePath, String(now));
  } catch {
    // if the guard cannot write, fall through and still inject once
  }
  const d = decideReflection(input, { useSignal: true });
  if (!d.fire) exitAllow();
  const reason = buildInstruction({ submitPath, sessionId: d.sessionId, signal: d.signal, config: d.config });
  // Synchronous write: a pipe on stdout is asynchronous in Node and exit()
  // right after process.stdout.write truncates anything past the pipe buffer.
  fs.writeSync(1, JSON.stringify({ decision: "block", reason, hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason } }) + "\n");
  process.exit(0);
} catch {
  exitAllow();
}
