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

export function codexHooks() {
  return {
    description: "XRPL DevEx Capture reflection Stop hook.",
    hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: `node "${abs("agents/codex/stop-hook.mjs")}"`, timeout: 60 }] }] },
  };
}

export function codexToml() {
  return [
    "# Alternative to hooks.json: put this in the project's .codex/config.toml (not the global ~/.codex/config.toml)",
    "[[hooks.Stop]]",
    'matcher = ""',
    "",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = "node \\"${abs("agents/codex/stop-hook.mjs")}\\""`,
    "timeout = 60",
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

// Merges our Claude Code hooks into an existing settings object, replacing any
// previous registration of ours and leaving other hooks untouched.
export function mergeClaudeSettings(existing) {
  const out = existing && typeof existing === "object" ? { ...existing } : {};
  const ours = claudeCodeHooks().hooks;
  const hooks = { ...(out.hooks && typeof out.hooks === "object" ? out.hooks : {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups
      .map((g) => ({ ...g, hooks: Array.isArray(g.hooks) ? g.hooks.filter((h) => !isOurs(h)) : g.hooks }))
      .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (!hooks[event].length) delete hooks[event];
  }
  for (const [event, groups] of Object.entries(ours)) {
    hooks[event] = [...(hooks[event] || []), ...groups];
  }
  out.hooks = hooks;
  return out;
}

export function removeClaudeSettings(existing) {
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
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}
