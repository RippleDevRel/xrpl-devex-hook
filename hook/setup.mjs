#!/usr/bin/env node
// First-run setup: consent, team name, pseudonym, hook registration.
//
//   node hook/setup.mjs                      interactive
//   TEAM_NAME="zetlar" CONSENT=yes node hook/setup.mjs --non-interactive
//   CONSENT=no node hook/setup.mjs --non-interactive        records the refusal
//   node hook/setup.mjs --emit-hooks         print registrations, absolute paths
//   node hook/setup.mjs --emit-hooks --agent claude-code --json
//   node hook/setup.mjs --register               project hooks for Claude Code, Grok and Codex
//   node hook/setup.mjs --register grok          one agent only
//   node hook/setup.mjs --unregister             remove the project hooks this setup wrote
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
import { claudeCodeHooks, cursorHooks, grokHooks, codexHooks, codexToml, vscodeHooks, mergeClaudeSettings, mergeCodexSettings, removeClaudeSettings } from "./lib/registrations.mjs";

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

function ensureGitignore() {
  const gi = path.join(project, ".gitignore");
  try {
    const current = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
    if (current.split(/\r?\n/).some((l) => l.trim() === ".xrpl-devex/" || l.trim() === ".xrpl-devex")) return false;
    fs.writeFileSync(gi, current + (current && !current.endsWith("\n") ? "\n" : "") + ".xrpl-devex/\n");
    return true;
  } catch {
    return false;
  }
}

function emitHooks({ agent, asJson }) {
  const all = {
    "claude-code": { target: ".claude/settings.json", body: claudeCodeHooks() },
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
  out("Register shortcut: node hook/setup.mjs --register writes Claude Code, Grok and Codex project files.");
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

function registerMerged(file, merge, remove) {
  const existing = readJsonFile(file);
  const next = remove ? removeClaudeSettings(existing) : merge(existing);
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

const REGISTERED_AGENTS = {
  "claude-code": (remove) =>
    registerMerged(path.join(project, ".claude", "settings.json"), mergeClaudeSettings, remove),
  grok: (remove) =>
    registerDedicated(path.join(project, ".grok", "hooks", "xrpl-devex.json"), grokHooks(), remove),
  codex: (remove) =>
    registerMerged(path.join(project, ".codex", "hooks.json"), mergeCodexSettings, remove),
};

const PROJECT_AGENTS = Object.keys(REGISTERED_AGENTS);

function registerAgent(agent, remove) {
  const names = !agent || agent === "all" ? PROJECT_AGENTS : [agent];
  for (const name of names) {
    if (!REGISTERED_AGENTS[name]) {
      process.stderr.write(`unknown agent ${name}. Use one of: all, ${PROJECT_AGENTS.join(", ")}. For cursor and vscode-copilot use --emit-hooks and paste the block.\n`);
      process.exit(1);
    }
  }
  const files = names.map((name) => REGISTERED_AGENTS[name](remove));
  const verb = remove ? "Removed" : "Registered";
  out(`${verb} project hooks (${names.join(", ")}):`);
  for (const file of files) out(`  ${file}`);
  if (!remove) {
    out("These files stay inside the project. Trust the folder before they run (/hooks-trust or /hooks).");
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
  registerAgent("all", false);
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
  if (ensureGitignore()) out("Added .xrpl-devex/ to the project .gitignore.");
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
} else if (has("--register") || has("--unregister")) {
  const remove = has("--unregister");
  const flag = remove ? "--unregister" : "--register";
  registerAgent(val(flag) || "all", remove);
  if (!remove && (!val(flag) || val(flag) === "all")) installSkills();
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
