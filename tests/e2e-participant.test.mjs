import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETUP = path.join(ROOT, "hook", "setup.mjs");
const STATUS = path.join(ROOT, "hook", "status.mjs");
const SUBMIT = path.join(ROOT, "hook", "submit.mjs");

function withProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-devex-e2e-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function hookEnv(dir) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, GROK_WORKSPACE_ROOT: dir };
  delete env.XRPL_DEVEX_PROJECT_DIR;
  return env;
}

function setupConsent(dir, { team = "hackathon-team", consent = "yes" } = {}) {
  return spawnSync(process.execPath, [SETUP, "--non-interactive", "--project", dir], {
    encoding: "utf8",
    env: { ...process.env, CONSENT: consent, TEAM_NAME: team },
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function buffer(dir) {
  const f = path.join(dir, ".xrpl-devex", "buffer.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function sent(dir) {
  const f = path.join(dir, ".xrpl-devex", "sent.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function grokHandlers(dir, eventName) {
  const hooks = readJson(path.join(dir, ".grok", "hooks", "xrpl-devex.json")).hooks[eventName];
  return hooks.flatMap((g) => g.hooks);
}

function runShellHook(command, dir, payload) {
  return spawnSync(command, {
    shell: true,
    cwd: dir,
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: hookEnv(dir),
  });
}

function runClaudeHandler(handler, dir, payload) {
  const args = handler.args || [];
  return spawnSync(handler.command, args, {
    cwd: dir,
    encoding: "utf8",
    input: JSON.stringify(payload),
    env: hookEnv(dir),
  });
}

test("hackathon e2e: consent, Grok/Claude/Codex commands, local buffer, no ingest", () => {
  withProject((dir) => {
    const setup = setupConsent(dir);
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    assert.match(setup.stdout, /Pseudonym:/);
    assert.equal(fs.existsSync(path.join(dir, ".xrpl-devex", "identity.json")), true);
    assert.equal(fs.existsSync(path.join(dir, ".grok", "hooks", "xrpl-devex.json")), true);
    assert.equal(fs.existsSync(path.join(dir, ".codex", "hooks.json")), true);
    assert.equal(fs.existsSync(path.join(dir, ".claude", "settings.json")), true);
    assert.equal(fs.existsSync(path.join(dir, ".cursor", "hooks.json")), true);
    assert.equal(fs.existsSync(path.join(dir, ".grok", "skills", "xrpl-status", "SKILL.md")), true);
    assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /\.xrpl-devex\//);

    const grokPost = grokHandlers(dir, "PostToolUse")[0].command;
    assert.match(grokPost, /capture\.mjs" --event PostToolUse$/);

    const start = runShellHook(grokHandlers(dir, "SessionStart")[0].command, dir, {
      hookEventName: "session_start",
      sessionId: "hack-1",
      workspaceRoot: dir,
      source: "startup",
    });
    assert.equal(start.status, 0, start.stderr);

    const xrplPrompt = runShellHook(grokHandlers(dir, "UserPromptSubmit")[0].command, dir, {
      hookEventName: "user_prompt_submit",
      sessionId: "hack-1",
      workspaceRoot: dir,
      prompt: "VaultDeposit returns tecNO_PERMISSION on xls-65",
    });
    assert.equal(xrplPrompt.status, 0, xrplPrompt.stderr);

    const lintPrompt = runShellHook(grokHandlers(dir, "UserPromptSubmit")[0].command, dir, {
      hookEventName: "user_prompt_submit",
      sessionId: "hack-1",
      workspaceRoot: dir,
      prompt: "please run npm run lint",
    });
    assert.equal(lintPrompt.status, 0, lintPrompt.stderr);

    const grokFail = runShellHook(grokPost, dir, {
      hookEventName: "post_tool_use",
      sessionId: "hack-1",
      workspaceRoot: dir,
      toolName: "run_terminal_command",
      toolInput: { command: "node vault.js" },
      toolResult: {
        output_for_prompt:
          "VaultDeposit failed tecNO_PERMISSION SECRET=supersecret Bearer faketoken123456",
      },
    });
    assert.equal(grokFail.status, 0, grokFail.stderr);

    const grokOk = runShellHook(grokPost, dir, {
      hookEventName: "post_tool_use",
      sessionId: "hack-1",
      workspaceRoot: dir,
      toolName: "run_terminal_command",
      toolInput: { command: "node vault.js" },
      toolResult: { output_for_prompt: "VaultDeposit tesSUCCESS" },
    });
    assert.equal(grokOk.status, 0, grokOk.stderr);

    const installCmd = grokHandlers(dir, "PostToolUse")[1].command;
    const install = runShellHook(installCmd, dir, {
      hookEventName: "post_tool_use",
      sessionId: "hack-1",
      toolName: "run_terminal_command",
      toolInput: { command: "npm install xrpl" },
    });
    assert.equal(install.status, 0, install.stderr);

    const cursorHooksFile = readJson(path.join(dir, ".cursor", "hooks.json"));
    const cursorShell = cursorHooksFile.hooks.afterShellExecution[0].command;
    const cursor = runShellHook(cursorShell, dir, {
      hook_event_name: "afterShellExecution",
      conversation_id: "hack-1",
      workspace_roots: [dir],
      command: "node vault.js",
      output: "VaultDeposit tecNO_PERMISSION",
    });
    assert.equal(cursor.status, 0, cursor.stderr);

    const cursorPrompt = runShellHook(cursorHooksFile.hooks.beforeSubmitPrompt[0].command, dir, {
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "hack-1",
      workspace_roots: [dir],
      prompt: "how do I call VaultWithdraw on xls-65",
    });
    assert.equal(cursorPrompt.status, 0, cursorPrompt.stderr);

    const claudeSettings = readJson(path.join(dir, ".claude", "settings.json"));
    const claudePost = claudeSettings.hooks.PostToolUse[0].hooks[0];
    const claude = runClaudeHandler(claudePost, dir, {
      hook_event_name: "PostToolUse",
      session_id: "hack-1",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command: "node loan.js" },
      tool_response: { stdout: "LoanSet tesSUCCESS" },
    });
    assert.equal(claude.status, 0, claude.stderr);

    const codexHooks = readJson(path.join(dir, ".codex", "hooks.json"));
    const codexPost = codexHooks.hooks.PostToolUse[0].hooks[0].command;
    const patch = "*** Begin Patch\n*** Update File: vault-deposit.js\n@@\n+VaultCreate()\n*** End Patch\n";
    const codex = runShellHook(codexPost, dir, {
      hook_event_name: "PostToolUse",
      session_id: "hack-1",
      cwd: dir,
      tool_name: "apply_patch",
      tool_input: { command: patch },
      tool_response: "Success. Updated the following files:\nA vault-deposit.js",
    });
    assert.equal(codex.status, 0, codex.stderr);

    const stopHandlers = grokHandlers(dir, "Stop");
    const stopFlush = runShellHook(stopHandlers[0].command, dir, {
      hookEventName: "stop",
      sessionId: "hack-1",
      workspaceRoot: dir,
      stopHookActive: false,
    });
    assert.equal(stopFlush.status, 0, stopFlush.stderr);

    const stopReflect = runShellHook(stopHandlers[1].command, dir, {
      hookEventName: "stop",
      sessionId: "hack-1",
      workspaceRoot: dir,
      stopHookActive: false,
      lastAssistantMessage: "VaultDeposit failed with tecNO_PERMISSION",
    });
    assert.equal(stopReflect.status, 2, stopReflect.stderr);
    assert.match(stopReflect.stderr, /XRPL developer experience check/);

    const bad = spawnSync(
      process.execPath,
      [SUBMIT, "--local", "--project", dir, "--json", '{"surface":"backend","friction_type":"doc_gap","summary":"x","text":"y"}'],
      { encoding: "utf8", env: hookEnv(dir) },
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /surface must be one of/);

    const ok = spawnSync(
      process.execPath,
      [
        SUBMIT,
        "--local",
        "--channel",
        "feedback",
        "--project",
        dir,
        "--json",
        JSON.stringify({
          surface: "docs",
          friction_type: "doc_gap",
          feature: "xls-65",
          tx_type: "VaultDeposit",
          result_code: "tecNO_PERMISSION",
          summary: "VaultDeposit returns tecNO_PERMISSION and the doc does not say why",
          text: "VaultDeposit returns tecNO_PERMISSION even though I am the vault owner, the doc says nothing about this",
        }),
      ],
      { encoding: "utf8", env: hookEnv(dir) },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /buffered: feedback docs\/doc_gap/);

    const events = buffer(dir);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("session_start"));
    assert.ok(kinds.includes("prompt"));
    assert.ok(kinds.includes("tool_result"));
    assert.ok(kinds.includes("package_install"));
    assert.ok(kinds.includes("feedback"));
    assert.ok(events.some((e) => e.tx_type === "VaultDeposit" && e.result_code === "tecNO_PERMISSION"));
    assert.ok(events.some((e) => e.kind === "package_install" && e.payload && e.payload.packages && e.payload.packages.includes("xrpl")));
    assert.ok(events.some((e) => e.tx_type === "LoanSet"));
    assert.ok(events.some((e) => e.payload && e.payload.file === "vault-deposit.js"));
    const leaked = JSON.stringify(events);
    assert.equal(leaked.includes("supersecret"), false);
    assert.equal(leaked.includes("faketoken123456"), false);
    assert.match(leaked, /\[redacted:/);
    assert.ok(events.filter((e) => e.kind === "prompt").length >= 2);
    assert.equal(sent(dir).length, 0);

    const status = spawnSync(process.execPath, [STATUS, "--project", dir], { encoding: "utf8", env: hookEnv(dir) });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Team: hackathon-team/);
    assert.match(status.stdout, /registered in /);
    assert.match(status.stdout, /Sent:\s+0 event/);
    assert.match(status.stdout, /Last flush:\s+never/);

    const off = spawnSync(process.execPath, [SETUP, "--unregister", "--project", dir], { encoding: "utf8" });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(fs.existsSync(path.join(dir, ".grok", "hooks", "xrpl-devex.json")), false);
  });
});

test("hackathon e2e: declined consent captures nothing", () => {
  withProject((dir) => {
    const setup = setupConsent(dir, { consent: "no" });
    assert.equal(setup.status, 0, setup.stderr + setup.stdout);
    spawnSync(process.execPath, [SETUP, "--register", "grok", "--project", dir], { encoding: "utf8" });
    const cmd = grokHandlers(dir, "PostToolUse")[0].command;
    const r = runShellHook(cmd, dir, {
      hookEventName: "post_tool_use",
      sessionId: "declined",
      toolName: "run_terminal_command",
      toolInput: { command: "node vault.js" },
      toolResult: { output_for_prompt: "VaultDeposit tecNO_PERMISSION" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(buffer(dir).length, 0);
    assert.equal(sent(dir).length, 0);
  });
});
