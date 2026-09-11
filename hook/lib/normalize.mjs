// Normalize hook stdin from Claude Code, Grok, Codex and Cursor into the
// Claude-shaped fields capture.mjs and the stop hooks already read.

const TOOL_NAME_ALIASES = {
  run_terminal_command: "Bash",
  bash: "Bash",
  shell: "Bash",
  Shell: "Bash",
  local_shell: "Bash",
  exec_command: "Bash",
  write: "Write",
  search_replace: "Edit",
  multiedit: "Edit",
  apply_patch: "Edit",
  run_in_terminal: "Bash",
  runTerminalCommand: "Bash",
  editFiles: "Edit",
  createFile: "Write",
  create_file: "Write",
  replace_string_in_file: "Edit",
  read_file: "Read",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  open_page: "WebFetch",
  open_page_with_find: "WebFetch",
};

function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

export function canonicalToolName(name) {
  if (typeof name !== "string" || !name) return name;
  if (TOOL_NAME_ALIASES[name]) return TOOL_NAME_ALIASES[name];
  const aliased = TOOL_NAME_ALIASES[name.toLowerCase()];
  return aliased || name;
}

const EVENT_ALIASES = {
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  beforeSubmitPrompt: "UserPromptSubmit",
  afterShellExecution: "PostToolUse",
  afterMCPExecution: "PostToolUse",
  afterFileEdit: "PostToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  preCompact: "PreCompact",
  stop: "Stop",
  userPromptSubmitted: "UserPromptSubmit",
  agentStop: "Stop",
  errorOccurred: "PostToolUseFailure",
};

export function toPascalEventName(name) {
  if (typeof name !== "string" || !name) return name;
  if (EVENT_ALIASES[name]) return EVENT_ALIASES[name];
  if (/^[A-Z][A-Za-z0-9]+$/.test(name)) return name;
  return name
    .split(/[_-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("");
}

export function patchFilePaths(text) {
  if (typeof text !== "string" || !text) return [];
  const files = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m;
  while ((m = re.exec(text))) files.push(m[1].trim());
  return files;
}

export function normalizeToolInput(input, rawName) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  const filePath = firstDefined(src, ["file_path", "target_file", "filePath", "path"]);
  if (typeof filePath === "string" && !src.file_path) src.file_path = filePath;
  if (!src.file_path && Array.isArray(src.files) && src.files[0]) {
    src.file_path = typeof src.files[0] === "string" ? src.files[0] : src.files[0].path || src.files[0].filePath;
  }
  if (rawName === "apply_patch") {
    const patchText = typeof src.command === "string" ? src.command : typeof src.patch === "string" ? src.patch : "";
    if (patchText) {
      const files = patchFilePaths(patchText);
      if (files[0] && !src.file_path) src.file_path = files[0];
      if (!src.new_string) src.new_string = patchText;
    }
  }
  return src;
}

export function normalizeToolResponse(response) {
  if (response == null || typeof response !== "object" || Array.isArray(response)) return response;
  const out = { ...response };
  if (typeof out.stdout !== "string" && typeof out.output_for_prompt === "string") {
    out.stdout = out.output_for_prompt;
  }
  return out;
}

export function normalizeHookInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out = { ...input };
  const sessionId = firstDefined(input, ["session_id", "sessionId", "conversation_id", "thread_id"]);
  if (typeof sessionId === "string" && sessionId) out.session_id = sessionId;
  const cwd = firstDefined(input, ["cwd", "workspaceRoot", "workspace_root"]);
  if (typeof cwd === "string" && cwd) out.cwd = cwd;
  else if (Array.isArray(input.workspace_roots) && typeof input.workspace_roots[0] === "string") {
    out.cwd = input.workspace_roots[0];
  }
  out.stop_hook_active = firstDefined(input, ["stop_hook_active", "stopHookActive"]) === true;
  const msg = firstDefined(input, ["last_assistant_message", "lastAssistantMessage"]);
  if (typeof msg === "string") out.last_assistant_message = msg;
  const eventName = firstDefined(input, ["hook_event_name", "hookEventName"]);
  if (typeof eventName === "string" && eventName) out.hook_event_name = toPascalEventName(eventName);
  const prompt = firstDefined(input, ["prompt", "user_prompt", "userPrompt"]);
  if (typeof prompt === "string") out.prompt = prompt;
  let rawTool = firstDefined(input, ["tool_name", "toolName"]);
  let toolInput = firstDefined(input, ["tool_input", "toolInput", "toolArgs", "tool_args", "input"]);
  if (!rawTool && typeof input.command === "string" && !out.prompt) {
    rawTool = "Bash";
    toolInput = { ...(toolInput && typeof toolInput === "object" ? toolInput : {}), command: input.command };
  }
  if (!rawTool && typeof input.file_path === "string" && Array.isArray(input.edits)) {
    rawTool = "Edit";
    const olds = input.edits.map((e) => e && e.old_string).filter((s) => typeof s === "string").join("\n");
    const news = input.edits.map((e) => e && e.new_string).filter((s) => typeof s === "string").join("\n");
    toolInput = { file_path: input.file_path, old_string: olds, new_string: news };
  }
  if (typeof rawTool === "string" && rawTool) out.tool_name = canonicalToolName(rawTool);
  if (toolInput !== undefined) out.tool_input = normalizeToolInput(toolInput, rawTool);
  const toolResponse = firstDefined(input, ["tool_response", "toolResult", "tool_result"]);
  if (toolResponse !== undefined) out.tool_response = normalizeToolResponse(toolResponse);
  else if (typeof input.output === "string") out.tool_response = { stdout: input.output };
  else if (typeof input.tool_output === "string") out.tool_response = { stdout: input.tool_output };
  else if (input.result_json !== undefined) out.tool_response = typeof input.result_json === "string" ? { stdout: input.result_json } : input.result_json;
  if (typeof input.error !== "string") {
    const err = firstDefined(input, ["errorDetails", "error_details", "error_message", "errorMessage"]);
    if (typeof err === "string") out.error = err;
  }
  return out;
}
