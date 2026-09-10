import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "hook");

function withProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-devex-"));
  fs.mkdirSync(path.join(dir, ".xrpl-devex"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".xrpl-devex", "identity.json"),
    JSON.stringify({
      participant_id: "test-ibex-1",
      team: "local-trial",
      team_display: "local-trial",
      consented_at: new Date().toISOString(),
      client_version: "2.0.0",
    }),
  );
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runNode(script, args, { dir, input }) {
  return spawnSync(process.execPath, [script, ...args], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, XRPL_DEVEX_PROJECT_DIR: dir },
  });
}

function buffer(dir) {
  const f = path.join(dir, ".xrpl-devex", "buffer.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
}

test("Grok camelCase PostToolUse is captured", () => {
  withProject((dir) => {
    const r = runNode(path.join(HOOK, "capture.mjs"), ["--event", "PostToolUse"], {
      dir,
      input: {
        sessionId: "grok-1",
        workspaceRoot: dir,
        toolName: "run_terminal_command",
        toolInput: { command: "node vault.js" },
        toolResult: { output_for_prompt: "VaultDeposit failed tecNO_PERMISSION" },
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const evs = buffer(dir);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, "tool_result");
    assert.equal(evs[0].tool_name, "Bash");
    assert.equal(evs[0].tx_type, "VaultDeposit");
    assert.equal(evs[0].result_code, "tecNO_PERMISSION");
    assert.equal(evs[0].failed, 1);
    assert.match(evs[0].text, /tecNO_PERMISSION/);
  });
});

test("Claude snake_case PostToolUse is still captured", () => {
  withProject((dir) => {
    const r = runNode(path.join(HOOK, "capture.mjs"), ["--event", "PostToolUse"], {
      dir,
      input: {
        session_id: "claude-1",
        cwd: dir,
        tool_name: "Bash",
        tool_input: { command: "node vault.js" },
        tool_response: { stdout: "VaultDeposit tesSUCCESS" },
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const evs = buffer(dir);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].tx_type, "VaultDeposit");
    assert.equal(evs[0].result_code, "tesSUCCESS");
    assert.equal(evs[0].failed, 0);
  });
});

test("non-XRPL Grok tool output is ignored", () => {
  withProject((dir) => {
    runNode(path.join(HOOK, "capture.mjs"), ["--event", "PostToolUse"], {
      dir,
      input: {
        sessionId: "grok-2",
        toolName: "run_terminal_command",
        toolInput: { command: "npm run lint" },
        toolResult: { output_for_prompt: "all files passed" },
      },
    });
    assert.equal(buffer(dir).length, 0);
  });
});

test("apply_patch stores the file name, not the patch body", () => {
  withProject((dir) => {
    const patch = "*** Begin Patch\n*** Update File: vault-deposit.js\n@@\n+VaultCreate()\n*** End Patch\n";
    runNode(path.join(HOOK, "capture.mjs"), ["--event", "PostToolUse"], {
      dir,
      input: {
        session_id: "codex-1",
        tool_name: "apply_patch",
        tool_input: { command: patch },
        tool_response: "Success. Updated the following files:\nA vault-deposit.js",
      },
    });
    const evs = buffer(dir);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].tx_type, "VaultCreate");
    assert.equal(evs[0].payload.file, "vault-deposit.js");
    assert.equal(evs[0].text, null);
    assert.ok(!JSON.stringify(evs[0]).includes("+VaultCreate()"));
  });
});

test("Grok stop-hook.mjs injects on camelCase XRPL error", () => {
  withProject((dir) => {
    const r = runNode(path.join(HOOK, "agents/grok/stop-hook.mjs"), [], {
      dir,
      input: {
        hookEventName: "stop",
        stopHookActive: false,
        sessionId: "grok-stop-own",
        cwd: dir,
        lastAssistantMessage: "VaultDeposit failed with tecNO_PERMISSION",
      },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /XRPL developer experience check/);
  });
});

test("Grok Stop camelCase injects reflection on an XRPL error", () => {
  withProject((dir) => {
    const r = runNode(path.join(HOOK, "agents/claude-code/stop-hook.mjs"), [], {
      dir,
      input: {
        hookEventName: "stop",
        hook_event_name: "Stop",
        stopHookActive: false,
        sessionId: "grok-stop",
        cwd: dir,
        lastAssistantMessage: "VaultDeposit failed with tecNO_PERMISSION",
      },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /XRPL developer experience check/);
  });
});

test("Grok stopHookActive true does not inject", () => {
  withProject((dir) => {
    const r = runNode(path.join(HOOK, "agents/claude-code/stop-hook.mjs"), [], {
      dir,
      input: {
        hook_event_name: "Stop",
        stopHookActive: true,
        lastAssistantMessage: "VaultDeposit failed with tecNO_PERMISSION",
        cwd: dir,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  });
});
