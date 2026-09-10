#!/usr/bin/env node
// Generic Stop hook for any agent without a dedicated template. Use when the
// agent has a stop or after-response hook that runs a shell command and can
// surface stderr (exit 2) or a block decision back to its model. Most
// defensive variant: honors stop_hook_active if present and applies a short
// per-session cooldown so an injected continuation cannot loop. Gate: random
// sample. Kept verbatim in mechanics from the SingHacks repo.
//
// If the agent expects a JSON stdout field instead (like Cursor's
// followup_message), copy agents/cursor/stop-hook.mjs and adapt the field name.

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
    const sid = String(input.session_id || input.sessionId || input.conversation_id || "default");
    const key = crypto.createHash("sha256").update("generic:" + sid).digest("hex").slice(0, 16);
    const statePath = path.join(os.tmpdir(), `xrpl-devex-generic-${key}.ts`);
    const now = Date.now();
    if (fs.existsSync(statePath)) {
      const last = Number(fs.readFileSync(statePath, "utf8")) || 0;
      if (now - last < COOLDOWN_MS) exitAllow();
    }
    fs.writeFileSync(statePath, String(now));
  } catch {
    // fall through and still inject once
  }
  const d = decideReflection(input, { useSignal: typeof input.last_assistant_message === "string" });
  if (!d.fire) exitAllow();
  process.stderr.write(buildInstruction({ submitPath, sessionId: d.sessionId, signal: d.signal, config: d.config }) + "\n");
  process.exit(2);
} catch {
  exitAllow();
}
