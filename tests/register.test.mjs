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

function withProject(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrpl-devex-reg-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(script, args, dir) {
  return spawnSync(process.execPath, [script, ...args, "--project", dir], { encoding: "utf8" });
}

test("--register grok writes command-string hooks, not command+args", () => {
  withProject((dir) => {
    const r = run(SETUP, ["--register", "grok"], dir);
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(dir, ".grok", "hooks", "xrpl-devex.json");
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    const post = body.hooks.PostToolUse[0].hooks[0];
    assert.equal(post.type, "command");
    assert.equal(post.args, undefined);
    assert.match(post.command, /^node "/);
    assert.match(post.command, /capture\.mjs" --event PostToolUse$/);
    assert.match(body.hooks.PostToolUse[0].matcher, /run_terminal_command/);
    const stop = body.hooks.Stop[0].hooks.map((h) => h.command).join("\n");
    assert.match(stop, /agents\/grok\/stop-hook\.mjs/);
  });
});

test("--register codex writes UserPromptSubmit and apply_patch capture", () => {
  withProject((dir) => {
    const r = run(SETUP, ["--register", "codex"], dir);
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(dir, ".codex", "hooks.json");
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(body.hooks.UserPromptSubmit);
    assert.match(body.hooks.PostToolUse[0].matcher, /apply_patch/);
    assert.equal(body.hooks.SessionEnd[0].hooks[0].timeout, 3);
  });
});

test("status sees grok registration", () => {
  withProject((dir) => {
    run(SETUP, ["--register", "grok"], dir);
    const r = run(STATUS, [], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /registered in /);
    assert.match(r.stdout, /\.grok\/hooks\/xrpl-devex\.json/);
  });
});

test("--unregister grok deletes the dedicated file", () => {
  withProject((dir) => {
    run(SETUP, ["--register", "grok"], dir);
    const file = path.join(dir, ".grok", "hooks", "xrpl-devex.json");
    assert.equal(fs.existsSync(file), true);
    const r = run(SETUP, ["--unregister", "grok"], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(file), false);
  });
});

test("--register keeps existing Codex hooks that are not ours", () => {
  withProject((dir) => {
    const file = path.join(dir, ".codex", "hooks.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: "command", command: "echo keep-me" }] }],
        },
      }),
    );
    run(SETUP, ["--register", "codex"], dir);
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(body.hooks.PreToolUse[0].hooks[0].command, "echo keep-me");
    assert.ok(body.hooks.Stop);
  });
});
