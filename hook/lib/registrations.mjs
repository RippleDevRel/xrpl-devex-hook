// Hook registrations for every supported agent, with absolute paths so a
// vendored install (this repo as a subfolder of a larger project) still works.
// Ported from the SingHacks repo's setup.mjs --emit-hooks and extended to the
// full v2 hook set for Claude Code.

import path from "node:path";
import { HOOK_DIR, fwd } from "./paths.mjs";

export const MARKER = "xrpl-devex-capture";

function abs(rel) {
  return fwd(path.join(HOOK_DIR, rel));
}

function capture(eventName, extraArgs = [], timeout = 10) {
  return {
    type: "command",
    command: "node",
    args: [abs("capture.mjs"), "--event", eventName, ...extraArgs],
    timeout,
  };
}

// Grok and Codex take a single command string, not command+args.
function shellArg(a) {
  return /[\s"]/.test(a) || a.includes("/") || a.includes("\\") ? `"${a}"` : a;
}

function shellNode(rel, extra = [], timeout = 10) {
  const command = `node ${[abs(rel), ...extra].map(shellArg).join(" ")}`;
  return { type: "command", command, timeout };
}

function shellCapture(eventName, extraArgs = [], timeout = 10) {
  return shellNode("capture.mjs", ["--event", eventName, ...extraArgs], timeout);
}

const GROK_TOOLS = "Bash|Write|Edit|Read|WebFetch|WebSearch|run_terminal_command|write|search_replace|read_file|web_search|web_fetch|open_page";
const GROK_BASH = "Bash|run_terminal_command";
const CODEX_TOOLS = "Bash|apply_patch|Write|Edit";

// The install patterns that get a package_install event. Each needs its own
// handler because the "if" field takes exactly one permission rule.
export const INSTALL_PATTERNS = ["npm install *", "npm i *", "pip install *", "pip3 install *", "yarn add *", "pnpm add *"];

export function claudeCodeHooks() {
  return {
    hooks: {
      SessionStart: [{ matcher: "", hooks: [capture("SessionStart")] }],
      UserPromptSubmit: [{ hooks: [capture("UserPromptSubmit")] }],
      PostToolUse: [
        { matcher: "Bash|Write|Edit|Read|WebFetch|WebSearch", hooks: [capture("PostToolUse")] },
        {
          matcher: "Bash",
          hooks: INSTALL_PATTERNS.map((p) => ({ ...capture("PostToolUse", ["--package-install"]), if: `Bash(${p})` })),
        },
      ],
      PostToolUseFailure: [{ matcher: "Bash|Write|Edit", hooks: [capture("PostToolUseFailure")] }],
      Stop: [
        {
          hooks: [
            capture("Stop", [], 20),
            { type: "command", command: "node", args: [abs("agents/claude-code/stop-hook.mjs")], timeout: 15 },
          ],
        },
      ],
      PreCompact: [{ matcher: "", hooks: [capture("PreCompact")] }],
      SessionEnd: [{ matcher: "", hooks: [capture("SessionEnd", [], 10)] }],
    },
  };
}

export function cursorHooks() {
  return { version: 1, hooks: { stop: [{ command: `node "${abs("agents/cursor/stop-hook.mjs")}"`, loop_limit: 2 }] } };
}

export function grokHooks() {
  return {
    hooks: {
      SessionStart: [{ matcher: "", hooks: [shellCapture("SessionStart")] }],
      UserPromptSubmit: [{ hooks: [shellCapture("UserPromptSubmit")] }],
      PostToolUse: [
        { matcher: GROK_TOOLS, hooks: [shellCapture("PostToolUse")] },
        { matcher: GROK_BASH, hooks: [shellCapture("PostToolUse", ["--package-install"])] },
      ],
      PostToolUseFailure: [{ matcher: `${GROK_BASH}|Write|Edit|write|search_replace`, hooks: [shellCapture("PostToolUseFailure")] }],
      Stop: [
        {
          hooks: [
            shellCapture("Stop", [], 20),
            shellNode("agents/grok/stop-hook.mjs", [], 15),
          ],
        },
      ],
      PreCompact: [{ matcher: "", hooks: [shellCapture("PreCompact")] }],
      SessionEnd: [{ matcher: "", hooks: [shellCapture("SessionEnd", [], 10)] }],
    },
  };
}

export function codexHooks() {
  return {
    description: "XRPL DevEx Capture: passive capture and reflection.",
    hooks: {
      SessionStart: [{ matcher: "", hooks: [shellCapture("SessionStart")] }],
      UserPromptSubmit: [{ hooks: [shellCapture("UserPromptSubmit")] }],
      PostToolUse: [
        { matcher: CODEX_TOOLS, hooks: [shellCapture("PostToolUse")] },
        { matcher: "Bash", hooks: [shellCapture("PostToolUse", ["--package-install"])] },
      ],
      Stop: [
        {
          hooks: [
            shellCapture("Stop", [], 20),
            shellNode("agents/codex/stop-hook.mjs", [], 60),
          ],
        },
      ],
      PreCompact: [{ matcher: "", hooks: [shellCapture("PreCompact")] }],
      SessionEnd: [{ matcher: "", hooks: [shellCapture("SessionEnd", [], 3)] }],
    },
  };
}

export function codexToml() {
  const stop = abs("agents/codex/stop-hook.mjs");
  const cap = abs("capture.mjs");
  return [
    "# Alternative to hooks.json: put this in the project's .codex/config.toml (not the global ~/.codex/config.toml).",
    "# Prefer: node hook/setup.mjs --register codex",
    "[[hooks.SessionStart]]",
    'matcher = ""',
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = "node \\"${cap}\\" --event SessionStart"`,
    "timeout = 10",
    "",
    "[[hooks.UserPromptSubmit]]",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = "node \\"${cap}\\" --event UserPromptSubmit"`,
    "timeout = 10",
    "",
    "[[hooks.PostToolUse]]",
    `matcher = "${CODEX_TOOLS}"`,
    "[[hooks.PostToolUse.hooks]]",
    'type = "command"',
    `command = "node \\"${cap}\\" --event PostToolUse"`,
    "timeout = 10",
    "",
    "[[hooks.Stop]]",
    'matcher = ""',
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = "node \\"${cap}\\" --event Stop"`,
    "timeout = 20",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = "node \\"${stop}\\""`,
    "timeout = 60",
    "",
    "[[hooks.PreCompact]]",
    'matcher = ""',
    "[[hooks.PreCompact.hooks]]",
    'type = "command"',
    `command = "node \\"${cap}\\" --event PreCompact"`,
    "timeout = 10",
    "",
    "[[hooks.SessionEnd]]",
    'matcher = ""',
    "[[hooks.SessionEnd.hooks]]",
    'type = "command"',
    `command = "node \\"${cap}\\" --event SessionEnd"`,
    "timeout = 3",
    "",
  ].join("\n");
}

export function vscodeHooks() {
  return { hooks: { Stop: [{ type: "command", command: `node "${abs("agents/vscode-copilot/stop-hook.mjs")}"`, timeout: 60 }] } };
}

// True when a hook handler object was emitted by us.
export function isOurs(handler) {
  const parts = [handler && handler.command, ...((handler && handler.args) || [])].filter((x) => typeof x === "string");
  return parts.some((s) => s.includes(fwd(HOOK_DIR)) || /capture\.mjs|stop-hook\.mjs/.test(s));
}

function stripOurs(existing) {
  const out = existing && typeof existing === "object" ? { ...existing } : {};
  const hooks = { ...(out.hooks && typeof out.hooks === "object" ? out.hooks : {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups
      .map((g) => ({ ...g, hooks: Array.isArray(g.hooks) ? g.hooks.filter((h) => !isOurs(h)) : g.hooks }))
      .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (!hooks[event].length) delete hooks[event];
  }
  out.hooks = hooks;
  return out;
}

export function mergeHookConfig(existing, oursHooks) {
  const out = stripOurs(existing);
  const hooks = out.hooks;
  for (const [event, groups] of Object.entries(oursHooks)) {
    hooks[event] = [...(hooks[event] || []), ...groups];
  }
  out.hooks = hooks;
  return out;
}

export function mergeClaudeSettings(existing) {
  return mergeHookConfig(existing, claudeCodeHooks().hooks);
}

export function mergeCodexSettings(existing) {
  const out = mergeHookConfig(existing, codexHooks().hooks);
  if (!out.description) out.description = codexHooks().description;
  return out;
}

export function removeClaudeSettings(existing) {
  const out = stripOurs(existing);
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}
