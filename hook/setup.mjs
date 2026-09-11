#!/usr/bin/env node
// First-run setup: consent, team name, pseudonym, hook registration.
//
//   node hook/setup.mjs                      interactive
//   TEAM_NAME="zetlar" CONSENT=yes node hook/setup.mjs --non-interactive
//   CONSENT=no node hook/setup.mjs --non-interactive        records the refusal
//   node hook/setup.mjs --emit-hooks         print registrations, absolute paths
//   node hook/setup.mjs --emit-hooks --agent claude-code --json
//   node hook/setup.mjs --register               project hooks for the agent detected from the environment
//   node hook/setup.mjs --register grok          one agent (claude-code, cursor, codex, grok, vscode-copilot)
//   node hook/setup.mjs --register all           every supported agent
//   node hook/setup.mjs --non-interactive --agent cursor   consent plus registration for one agent
//   node hook/setup.mjs --unregister             remove every project hook this setup wrote
//
// Generated hook files carry absolute local paths, so they must not be committed:
// Claude Code hooks go to .claude/settings.local.json (ignored by convention) and
// the dedicated Grok and Copilot files are added to the project .gitignore.
//   node hook/setup.mjs --show-consent
//   node hook/setup.mjs --project /path/to/project   (default: CLAUDE_PROJECT_DIR or cwd)
//
// Writes .xrpl-devex/identity.json: { participant_id, team, team_display,
// consented_at, client_version } or { declined: true }. No real name, ever.
// Also appends .xrpl-devex/ to the project's .gitignore.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadConfig, isConfigured } from "./lib/config.mjs";
import { consentText } from "./lib/consent.mjs";
import { projectDir, dataPaths, HOOK_DIR, REPO_DIR, fwd } from "./lib/paths.mjs";
import { loadIdentity, saveIdentity, createIdentity, declinedIdentity, normalizeTeam, isActive } from "./lib/identity.mjs";
import { claudeCodeHooks, cursorHooks, grokHooks, codexHooks, codexToml, vscodeHooks, mergeClaudeSettings, mergeCodexSettings, mergeCursorSettings, removeClaudeSettings, removeCursorSettings } from "./lib/registrations.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  const n = i !== -1 ? argv[i + 1] : undefined;
  if (!n || n.startsWith("-")) return undefined;
  return n;
};

if (val("--project")) process.env.XRPL_DEVEX_PROJECT_DIR = path.resolve(val("--project"));
const project = projectDir();
const config = loadConfig();

// A closed pipe (for example an agent reading only the first lines) must not
// turn a successful setup into a stack trace.
process.stdout.on("error", () => {});

function out(s = "") {
  process.stdout.write(s + "\n");
}

// Adds lines to the project .gitignore when missing. Returns the lines added.
function ensureGitignore(lines = [".xrpl-devex/"]) {
  const gi = path.join(project, ".gitignore");
  try {
    let current = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
    const present = new Set(current.split(/\r?\n/).map((l) => l.trim().replace(/\/$/, "")));
    const added = lines.filter((l) => !present.has(l.replace(/\/$/, "")));
    if (!added.length) return [];
    current += (current && !current.endsWith("\n") ? "\n" : "") + added.join("\n") + "\n";
    fs.writeFileSync(gi, current);
    return added;
  } catch {
    return [];
  }
}

// Which agent is running this setup. Explicit --agent or XRPL_DEVEX_AGENT wins
// (comma separated, or "all"); otherwise environment markers set by each agent.
const AGENT_ENV_MARKERS = [
  ["claude-code", ["CLAUDECODE", "CLAUDE_PROJECT_DIR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_SESSION_ID"]],
  ["cursor", ["CURSOR_AGENT", "CURSOR_TRACE_ID", "CURSOR_WORKSPACE_ROOTS"]],
  ["codex", ["CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_HOME"]],
  ["grok", ["GROK_WORKSPACE_ROOT", "GROK_SESSION_ID", "GROK_HOME"]],
  ["vscode-copilot", ["COPILOT_AGENT", "COPILOT_SESSION_ID", "GITHUB_COPILOT_CLI"]],
];

function detectAgents() {
  return AGENT_ENV_MARKERS.filter(([, vars]) => vars.some((v) => process.env[v])).map(([name]) => name);
}

function normalizeAgentName(n) {
  return n === "copilot" || n === "vscode" ? "vscode-copilot" : n === "claude" ? "claude-code" : n;
}

function requestedAgents(explicit) {
  const raw = explicit || process.env.XRPL_DEVEX_AGENT || "";
  if (raw.trim()) {
    const names = raw.split(",").map((s) => normalizeAgentName(s.trim())).filter(Boolean);
    return names.includes("all") ? PROJECT_AGENTS.slice() : names;
  }
  return detectAgents();
}

function emitHooks({ agent, asJson }) {
  const all = {
    "claude-code": { target: ".claude/settings.local.json", body: claudeCodeHooks() },
    grok: { target: ".grok/hooks/xrpl-devex.json", body: grokHooks() },
    cursor: { target: ".cursor/hooks.json", body: cursorHooks() },
    codex: { target: ".codex/hooks.json", body: codexHooks() },
    "vscode-copilot": { target: ".github/hooks/xrpl-devex.json", body: vscodeHooks() },
  };
  if (agent) {
    if (!all[agent]) {
      process.stderr.write(`unknown agent ${agent}. Use one of: ${Object.keys(all).join(", ")}\n`);
      process.exit(1);
    }
    out(JSON.stringify(all[agent].body, null, 2));
    return;
  }
  if (asJson) {
    out(JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.body])), null, 2));
    return;
  }
  out("");
  out(`Hook registrations with absolute resolved paths (hook dir: ${fwd(HOOK_DIR)}).`);
  out("These stay correct even if this repo is vendored inside a larger project.");
  out("Paste into the PROJECT-scoped config for your agent, never the global one.");
  for (const [k, v] of Object.entries(all)) {
    out("");
    out(`${k}  ->  ${v.target}`);
    out(JSON.stringify(v.body, null, 2));
  }
  out("");
  out("Codex alternative  ->  .codex/config.toml");
  out(codexToml());
  out("Register shortcut: node hook/setup.mjs --register <agent> writes the file for that agent with absolute paths (or --register all).");
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    process.stderr.write(`${file} is not valid JSON, fix it first: ${err.message}\n`);
    process.exit(1);
  }
}

function writeJsonFile(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
}

function registerMerged(file, merge, remove, strip = removeClaudeSettings) {
  const existing = readJsonFile(file);
  const next = remove ? strip(existing) : merge(existing);
  writeJsonFile(file, next);
  return file;
}

function registerDedicated(file, body, remove) {
  if (remove) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return file;
  }
  writeJsonFile(file, body);
  return file;
}

// Claude Code reads both files; we write .claude/settings.local.json because it
// is meant to stay out of git and our registrations carry absolute local paths.
// Unregister also strips older registrations from .claude/settings.json.
function registerClaude(remove) {
  const local = path.join(project, ".claude", "settings.local.json");
  const shared = path.join(project, ".claude", "settings.json");
  if (remove && fs.existsSync(shared) && fs.readFileSync(shared, "utf8").includes("capture.mjs")) {
    registerMerged(shared, mergeClaudeSettings, true);
  }
  if (!remove && fs.existsSync(shared) && fs.readFileSync(shared, "utf8").includes("capture.mjs")) {
    registerMerged(shared, mergeClaudeSettings, true);
  }
  return registerMerged(local, mergeClaudeSettings, remove);
}

const REGISTERED_AGENTS = {
  "claude-code": (remove) => registerClaude(remove),
  grok: (remove) =>
    registerDedicated(path.join(project, ".grok", "hooks", "xrpl-devex.json"), grokHooks(), remove),
  codex: (remove) =>
    registerMerged(path.join(project, ".codex", "hooks.json"), mergeCodexSettings, remove),
  cursor: (remove) =>
    registerMerged(path.join(project, ".cursor", "hooks.json"), mergeCursorSettings, remove, removeCursorSettings),
  "vscode-copilot": (remove) =>
    registerDedicated(path.join(project, ".github", "hooks", "xrpl-devex.json"), vscodeHooks(), remove),
};

const PROJECT_AGENTS = Object.keys(REGISTERED_AGENTS);
// Files we own outright, safe to ignore in git. Merged files (.codex/hooks.json,
// .cursor/hooks.json) may hold the participant's own hooks, so we only warn.
const IGNORABLE = { "claude-code": ".claude/settings.local.json", grok: ".grok/hooks/xrpl-devex.json", "vscode-copilot": ".github/hooks/xrpl-devex.json" };
const MERGED = { codex: ".codex/hooks.json", cursor: ".cursor/hooks.json" };

function registerAgents(names, remove) {
  for (const name of names) {
    if (!REGISTERED_AGENTS[name]) {
      process.stderr.write(`unknown agent ${name}. Use one of: all, ${PROJECT_AGENTS.join(", ")}.\n`);
      process.exit(1);
    }
  }
  const files = names.map((name) => REGISTERED_AGENTS[name](remove));
  const verb = remove ? "Removed" : "Registered";
  out(`${verb} project hooks (${names.join(", ")}):`);
  for (const file of files) out(`  ${file}`);
  if (!remove) {
    const added = ensureGitignore([".xrpl-devex/", ...names.map((n) => IGNORABLE[n]).filter(Boolean)]);
    if (added.length) out(`Added to the project .gitignore: ${added.join(", ")}`);
    const merged = names.map((n) => MERGED[n]).filter(Boolean);
    if (merged.length) out(`Note: ${merged.join(" and ")} now contain absolute local paths. Keep them out of git, or have each teammate run --register on their machine.`);
    out("Trust the project hooks before they run: /hooks in Claude Code, Codex and Cursor, /hooks-trust in Grok.");
  }
}

function installSkills() {
  const sh = path.join(REPO_DIR, "skills", "install.sh");
  const r = spawnSync("bash", [sh, "--project", project], { encoding: "utf8" });
  if (r.status !== 0) {
    out("Skills were not installed. Run: bash skills/install.sh --project " + project);
    if (r.stderr) out(r.stderr.trim());
    return;
  }
  if (r.stdout) out(r.stdout.trim());
}

function enableProject() {
  const agents = requestedAgents(val("--agent"));
  if (agents.length) {
    registerAgents(agents, false);
  } else {
    out("No coding agent detected from the environment, so no hook file was written.");
    out(`Register the agent you use: node hook/setup.mjs --register <${PROJECT_AGENTS.join("|")}>   (or --register all)`);
  }
  installSkills();
}

function finish(identity) {
  const p = dataPaths();
  out("");
  if (identity.declined) {
    out(`Recorded your decision to not participate in ${p.identity}. Nothing will be captured.`);
    out("Delete that file if you change your mind.");
    return;
  }
  out(`Saved ${p.identity}`);
  out(`Pseudonym: ${identity.participant_id}   Team: ${identity.team_display} (${identity.team})   Event: ${config.event}`);
  if (ensureGitignore().length) out("Added .xrpl-devex/ to the project .gitignore.");
  if (!isConfigured(config)) out("Note: hook/devex.config.json still has REPLACE-ME values. Events will buffer locally until the organizer fills in endpoint and ingest_key.");
  out("");
  enableProject();
  out("");
  out("Check with: node hook/status.mjs");
  out("Disable with: node hook/setup.mjs --unregister");
}

function nonInteractive() {
  const consent = String(process.env.CONSENT || "").trim().toLowerCase();
  const existing = loadIdentity();
  if (["no", "n", "false", "0", "decline", "declined"].includes(consent)) {
    saveIdentity(declinedIdentity());
    finish({ declined: true });
    return;
  }
  if (!["yes", "y", "true", "1", "accept", "accepted"].includes(consent)) {
    process.stderr.write("CONSENT must be yes or no. Show the consent text to the developer first (node hook/setup.mjs --show-consent) and do not continue until they answer.\n");
    process.exit(1);
  }
  const teamDisplay = (process.env.TEAM_NAME || (existing && existing.team_display) || "").trim();
  if (!normalizeTeam(teamDisplay)) {
    process.stderr.write('TEAM_NAME is required, for example: TEAM_NAME="zetlar" CONSENT=yes node hook/setup.mjs --non-interactive\n');
    process.exit(1);
  }
  const identity = createIdentity({ teamDisplay, pseudonym: isActive(existing) ? existing.participant_id : undefined });
  if (isActive(existing)) identity.consented_at = existing.consented_at;
  saveIdentity(identity);
  finish(identity);
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a)));
  const existing = loadIdentity();
  out("");
  out("XRPL DevEx Capture setup");
  out("");
  out(consentText(config));
  out("");
  let answer = "";
  while (!["yes", "y", "no", "n"].includes(answer)) {
    answer = (await ask("Do you consent? (yes/no): ")).trim().toLowerCase();
  }
  if (answer.startsWith("n")) {
    rl.close();
    saveIdentity(declinedIdentity());
    finish({ declined: true });
    return;
  }
  let teamDisplay = "";
  while (!normalizeTeam(teamDisplay)) {
    const def = existing && existing.team_display ? ` [${existing.team_display}]` : "";
    teamDisplay = (await ask(`Team name${def}: `)).trim() || (existing && existing.team_display) || "";
  }
  rl.close();
  const identity = createIdentity({ teamDisplay, pseudonym: isActive(existing) ? existing.participant_id : undefined });
  if (isActive(existing)) identity.consented_at = existing.consented_at;
  saveIdentity(identity);
  finish(identity);
}

if (has("--show-consent")) {
  out(consentText(config));
} else if (has("--emit-hooks")) {
  emitHooks({ agent: val("--agent"), asJson: has("--json") });
} else if (has("--unregister")) {
  const names = val("--unregister") ? requestedAgents(val("--unregister")) : PROJECT_AGENTS.slice();
  registerAgents(names, true);
} else if (has("--register")) {
  const names = requestedAgents(val("--register") || val("--agent"));
  if (!names.length) {
    process.stderr.write(`No coding agent detected. Name it: node hook/setup.mjs --register <${PROJECT_AGENTS.join("|")}|all>\n`);
    process.exit(1);
  }
  registerAgents(names, false);
  installSkills();
} else if (has("--non-interactive")) {
  nonInteractive();
} else if (!process.stdin.isTTY) {
  process.stderr.write("No TTY. Use --non-interactive with TEAM_NAME and CONSENT=yes|no after showing the consent text (--show-consent).\n");
  process.exit(1);
} else {
  interactive().catch((err) => {
    process.stderr.write(String(err && err.message ? err.message : err) + "\n");
    process.exit(1);
  });
}
