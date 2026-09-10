#!/usr/bin/env node
// VS Code (Copilot) Stop hook, reflection channel. Mirrors Claude Code's
// mechanics (JSON on stdin, exit 2 + stderr) but VS Code does not document
// stop_hook_active or a block cap, so on top of that check a short per-session
// cooldown file guards against loops. Gate: random sample only. Loop guards
// kept verbatim from the SingHacks repo.

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
  const d = decideReflection(input, { useSignal: false });
  if (!d.fire) exitAllow();
  process.stderr.write(buildInstruction({ submitPath, sessionId: d.sessionId, signal: d.signal, config: d.config }) + "\n");
  process.exit(2);
} catch {
  exitAllow();
}
