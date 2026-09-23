// Install-time facts shared by setup.mjs and status.mjs: which agent is
// running this process, which agents have a config dir in the project, what
// each agent's hook file registers (and whether those paths still exist), and
// which skills installer fits the platform.

import fs from "node:fs";
import path from "node:path";
import { REPO_DIR, platform } from "./paths.mjs";
import { isOurs } from "./registrations.mjs";

export const PROJECT_AGENTS = ["claude-code", "grok", "codex", "cursor", "vscode-copilot"];

// Environment markers each agent sets in the processes it starts.
export const AGENT_ENV_MARKERS = {
  "claude-code": ["CLAUDECODE", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_SESSION_ID"],
  cursor: ["CURSOR_AGENT", "CURSOR_TRACE_ID", "CURSOR_WORKSPACE_ROOTS"],
  codex: ["CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_HOME"],
  grok: ["GROK_WORKSPACE_ROOT", "GROK_SESSION_ID", "GROK_HOME"],
  "vscode-copilot": ["COPILOT_AGENT", "COPILOT_SESSION_ID", "GITHUB_COPILOT_CLI"],
};

// The directory whose presence means the agent is used in this project.
export const AGENT_CONFIG_DIR = {
  "claude-code": ".claude",
  grok: ".grok",
  codex: ".codex",
  cursor: ".cursor",
  "vscode-copilot": path.join(".github", "hooks"),
};

// The project files setup writes for each agent, first one preferred.
export const AGENT_HOOK_FILES = {
  "claude-code": [path.join(".claude", "settings.local.json"), path.join(".claude", "settings.json")],
  grok: [path.join(".grok", "hooks", "xrpl-devex.json")],
  codex: [path.join(".codex", "hooks.json")],
  cursor: [path.join(".cursor", "hooks.json")],
  "vscode-copilot": [path.join(".github", "hooks", "xrpl-devex.json")],
};

export function normalizeAgentName(n) {
  return n === "copilot" || n === "vscode" ? "vscode-copilot" : n === "claude" ? "claude-code" : n;
}

// Agents whose environment markers are set: the ones running this process.
export function runningAgents(env = process.env) {
  return PROJECT_AGENTS.filter((a) => AGENT_ENV_MARKERS[a].some((v) => env[v]));
}

// True when the folder exists and holds anything besides the skills folder
// our own installer creates (an empty folder counts: the agent made it).
function inUse(dir) {
  try {
    const entries = fs.readdirSync(dir);
    return !(entries.length === 1 && entries[0] === "skills");
  } catch {
    return false;
  }
}

// Agents whose config directory exists in the project.
export function presentAgents(project) {
  return PROJECT_AGENTS.filter((a) => inUse(path.join(project, AGENT_CONFIG_DIR[a])));
}

// The directory the running agent was opened in, from its own marker, or null.
export function agentWorkspace(env = process.env) {
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  if (env.GROK_WORKSPACE_ROOT) return env.GROK_WORKSPACE_ROOT;
  if (env.CURSOR_WORKSPACE_ROOTS) {
    try {
      const parsed = JSON.parse(env.CURSOR_WORKSPACE_ROOTS);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
    } catch {
      // a plain path or a delimited list
    }
    return env.CURSOR_WORKSPACE_ROOTS.split(/[;\n]/)[0].trim() || null;
  }
  return null;
}

// Script paths named by one hook handler: exec-form args or a command string
// with the path quoted or bare.
export function handlerScripts(handler) {
  const out = [];
  if (Array.isArray(handler.args)) for (const a of handler.args) if (typeof a === "string" && a.endsWith(".mjs")) out.push(a);
  for (const s of [handler.command, handler.bash, handler.powershell]) {
    if (typeof s !== "string") continue;
    const re = /"([^"]+\.mjs)"|(?:^|\s)([^\s"]+\.mjs)(?=\s|$)/g;
    let m;
    while ((m = re.exec(s))) out.push(m[1] || m[2]);
  }
  return out;
}

// Every handler in a hook file, whatever the agent's shape: Claude-style
// groups ({ event: [{ hooks: [...] }] }) or the flat Cursor and Copilot lists.
function handlersIn(body) {
  const out = [];
  const hooks = body && typeof body === "object" && body.hooks && typeof body.hooks === "object" ? body.hooks : {};
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (g && Array.isArray(g.hooks)) out.push(...g.hooks);
      else if (g && typeof g === "object") out.push(g);
    }
  }
  return out;
}

// Registration state of one agent in the project:
// { registered, file, reflection, missing } where missing lists registered
// script paths that no longer exist.
export function agentRegistration(project, agent) {
  for (const rel of AGENT_HOOK_FILES[agent]) {
    const file = path.join(project, rel);
    if (!fs.existsSync(file)) continue;
    let body;
    try {
      body = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      return { registered: false, file, reflection: false, missing: [], reason: `not valid JSON: ${err.message}` };
    }
    const ours = handlersIn(body).filter((h) => h && isOurs(h));
    if (!ours.length) continue;
    const scripts = ours.flatMap(handlerScripts);
    const missing = [...new Set(scripts.filter((s) => !fs.existsSync(s)))];
    return { registered: true, file, reflection: scripts.some((s) => /stop-hook\.mjs$/.test(s)), missing };
  }
  return { registered: false, file: path.join(project, AGENT_HOOK_FILES[agent][0]), reflection: false, missing: [] };
}

export function registrations(project) {
  return Object.fromEntries(PROJECT_AGENTS.map((a) => [a, agentRegistration(project, a)]));
}

// The skills installer for the platform: install.ps1 through PowerShell on
// win32, install.sh through bash elsewhere.
export function skillsInstallCommand(project, plat = platform()) {
  if (plat === "win32") {
    const ps1 = path.join(REPO_DIR, "skills", "install.ps1");
    return { cmd: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Project", project], display: `powershell -ExecutionPolicy Bypass -File "${ps1}" -Project "${project}"` };
  }
  const sh = path.join(REPO_DIR, "skills", "install.sh");
  return { cmd: "bash", args: [sh, "--project", project], display: `bash "${sh}" --project "${project}"` };
}
