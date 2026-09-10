import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalToolName,
  normalizeHookInput,
  patchFilePaths,
  toPascalEventName,
} from "../hook/lib/normalize.mjs";

test("canonicalToolName maps Grok and Codex tools onto Claude names", () => {
  assert.equal(canonicalToolName("run_terminal_command"), "Bash");
  assert.equal(canonicalToolName("search_replace"), "Edit");
  assert.equal(canonicalToolName("write"), "Write");
  assert.equal(canonicalToolName("read_file"), "Read");
  assert.equal(canonicalToolName("web_fetch"), "WebFetch");
  assert.equal(canonicalToolName("open_page"), "WebFetch");
  assert.equal(canonicalToolName("web_search"), "WebSearch");
  assert.equal(canonicalToolName("apply_patch"), "Edit");
  assert.equal(canonicalToolName("Bash"), "Bash");
  assert.equal(canonicalToolName("Write"), "Write");
});

test("toPascalEventName accepts Grok snake_case and Claude PascalCase", () => {
  assert.equal(toPascalEventName("Stop"), "Stop");
  assert.equal(toPascalEventName("stop"), "Stop");
  assert.equal(toPascalEventName("post_tool_use"), "PostToolUse");
  assert.equal(toPascalEventName("UserPromptSubmit"), "UserPromptSubmit");
  assert.equal(toPascalEventName("session_start"), "SessionStart");
});

test("Grok camelCase PostToolUse becomes Claude-shaped", () => {
  const n = normalizeHookInput({
    hookEventName: "post_tool_use",
    sessionId: "abc",
    workspaceRoot: "/tmp/proj",
    toolName: "run_terminal_command",
    toolInput: { command: "node vault.js" },
    toolResult: { type: "Bash", output_for_prompt: "VaultDeposit failed tecNO_PERMISSION" },
  });
  assert.equal(n.hook_event_name, "PostToolUse");
  assert.equal(n.session_id, "abc");
  assert.equal(n.cwd, "/tmp/proj");
  assert.equal(n.tool_name, "Bash");
  assert.equal(n.tool_input.command, "node vault.js");
  assert.equal(n.tool_response.stdout, "VaultDeposit failed tecNO_PERMISSION");
});

test("Grok camelCase Stop maps stopHookActive and lastAssistantMessage", () => {
  const n = normalizeHookInput({
    hookEventName: "stop",
    hook_event_name: "Stop",
    stopHookActive: false,
    sessionId: "s1",
    lastAssistantMessage: "VaultDeposit failed with tecNO_PERMISSION",
  });
  assert.equal(n.stop_hook_active, false);
  assert.equal(n.last_assistant_message, "VaultDeposit failed with tecNO_PERMISSION");
  assert.equal(n.session_id, "s1");
  assert.equal(n.hook_event_name, "Stop");
});

test("stopHookActive true wins", () => {
  const n = normalizeHookInput({ stopHookActive: true });
  assert.equal(n.stop_hook_active, true);
});

test("Claude snake_case input is unchanged", () => {
  const src = {
    hook_event_name: "PostToolUse",
    session_id: "s",
    cwd: "/p",
    tool_name: "Bash",
    tool_input: { command: "node x.js" },
    tool_response: { stdout: "tesSUCCESS" },
    stop_hook_active: false,
    last_assistant_message: "ok",
  };
  const n = normalizeHookInput(src);
  assert.equal(n.tool_name, "Bash");
  assert.equal(n.tool_input.command, "node x.js");
  assert.equal(n.tool_response.stdout, "tesSUCCESS");
  assert.equal(n.session_id, "s");
  assert.equal(n.last_assistant_message, "ok");
});

test("read_file target_file becomes file_path", () => {
  const n = normalizeHookInput({
    toolName: "read_file",
    toolInput: { target_file: "/tmp/vault-deposit.js" },
  });
  assert.equal(n.tool_name, "Read");
  assert.equal(n.tool_input.file_path, "/tmp/vault-deposit.js");
});

test("apply_patch command is treated as an Edit of the first file", () => {
  const patch = "*** Begin Patch\n*** Update File: src/vault-deposit.js\n@@\n-a\n+VaultCreate\n*** End Patch\n";
  const n = normalizeHookInput({
    tool_name: "apply_patch",
    tool_input: { command: patch },
  });
  assert.equal(n.tool_name, "Edit");
  assert.equal(n.tool_input.file_path, "src/vault-deposit.js");
  assert.equal(n.tool_input.new_string, patch);
  assert.deepEqual(patchFilePaths(patch), ["src/vault-deposit.js"]);
});

test("Cursor conversation_id becomes session_id", () => {
  const n = normalizeHookInput({ conversation_id: "cursor-1" });
  assert.equal(n.session_id, "cursor-1");
});
