#!/usr/bin/env node
// Local status, no network. What a participant runs (or /xrpl-status runs for
// them) to see that the hook is alive.
//   node hook/status.mjs [--json] [--project <dir>]
//
// Ends with a verdict. "Capturing: yes" only when the identity is active, the
// agent running this process (from its environment markers) has its hooks
// registered here, every registered hook path still exists, and the agent was
// opened in this project. Otherwise "not capturing" with the reason (T06, T13).

import fs from "node:fs";
import path from "node:path";
import { loadConfig, isConfigured, configPath } from "./lib/config.mjs";
import { loadIdentity } from "./lib/identity.mjs";
import { loadState, currentSession } from "./lib/state.mjs";
import { readJsonl } from "./lib/buffer.mjs";
import { dataPaths, projectDir, normalizeRoot, HOOK_DIR } from "./lib/paths.mjs";
import { PROJECT_AGENTS, registrations, runningAgents, agentWorkspace } from "./lib/install.mjs";
import { CLIENT_VERSION } from "./version.mjs";

const argv = process.argv.slice(2);
const val = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : undefined;
};
if (val("--project")) process.env.XRPL_DEVEX_PROJECT_DIR = path.resolve(val("--project"));

const project = projectDir();
const p = dataPaths();
const config = loadConfig();
const identity = loadIdentity();
const state = loadState();
const session = currentSession(state);

const agents = registrations(project);
const registeredAgents = PROJECT_AGENTS.filter((a) => agents[a].registered);
const runningAgent = runningAgents()[0] || null;

function samePath(a, b) {
  const real = (x) => {
    try {
      return fs.realpathSync(x);
    } catch {
      return path.resolve(x);
    }
  };
  return real(normalizeRoot(a)) === real(b);
}

// An identity one level below: the agent was opened in the parent folder.
function childWithIdentity() {
  try {
    return (
      fs
        .readdirSync(project, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => path.join(project, d.name))
        .find((d) => fs.existsSync(path.join(d, ".xrpl-devex", "identity.json"))) || null
    );
  } catch {
    return null;
  }
}

// Why nothing is captured, or null when everything lines up.
function notCapturingReason() {
  if (!identity) {
    const child = childWithIdentity();
    return `no identity in ${p.identity}` + (child ? `; found one in ${child}, open your agent from ${child}` : "; run /xrpl-setup");
  }
  if (identity.declined) return "consent declined; delete .xrpl-devex/identity.json to change your mind";
  if (!registeredAgents.length) return `no agent hooks registered in ${project}; run node hook/setup.mjs --register <agent>`;
  const missing = registeredAgents.flatMap((a) => agents[a].missing.map((m) => `${a}: ${m}`));
  if (missing.length) return `a registered hook path does not exist (${missing.join("; ")}); re-run node hook/setup.mjs --register`;
  if (runningAgent && !agents[runningAgent].registered) {
    return `${runningAgent} is running but its hooks are not registered here (registered: ${registeredAgents.join(", ")}); run node hook/setup.mjs --register ${runningAgent}`;
  }
  const opened = agentWorkspace();
  if (opened && !samePath(opened, project)) return `the agent was opened in ${opened} but the hooks are registered in ${project}; open it from ${project}`;
  return null;
}

const reason = notCapturingReason();
const pending = fs.existsSync(p.pendingAnalyses) ? fs.readdirSync(p.pendingAnalyses).filter((f) => f.endsWith(".json")).length : 0;
const analyses = readJsonl(p.analysesLog);
const sent = readJsonl(p.sent);
const buffered = readJsonl(p.buffer);
const registeredFiles = registeredAgents.map((a) => agents[a].file);

const status = {
  client_version: CLIENT_VERSION,
  project,
  hook_dir: HOOK_DIR,
  data_dir: p.root,
  config_file: configPath(),
  event: config.event,
  focus_features: config.focus_features,
  endpoint_configured: isConfigured(config),
  identity: identity ? (identity.declined ? { declined: true } : { participant_id: identity.participant_id, team: identity.team, team_display: identity.team_display, consented_at: identity.consented_at }) : null,
  invite: identity && !identity.declined ? { required: identity.invite_only === true, stored: Boolean(identity.invite_code) } : null,
  hooks_registered: registeredAgents.length > 0,
  reflection_hook_registered: registeredAgents.some((a) => agents[a].reflection),
  settings_file: registeredFiles.length ? registeredFiles.join(", ") : agents["claude-code"].file,
  agents,
  running_agent: runningAgent,
  capturing: reason === null,
  not_capturing_reason: reason,
  buffered_events: buffered.length,
  sent_events: sent.length,
  buffered_by_kind: buffered.reduce((acc, e) => ((acc[e.kind] = (acc[e.kind] || 0) + 1), acc), {}),
  sent_by_channel: sent.reduce((acc, e) => ((acc[e.channel] = (acc[e.channel] || 0) + 1), acc), {}),
  session: session
    ? {
        session_id: session.session_id,
        started_at: session.session_started_at,
        turns: session.turn,
        reflections_sent: session.reflections_sent,
        reflection_prompts: session.reflection_prompts || 0,
        analysis_submitted: session.analysis_submitted,
        checkpoints_submitted: session.checkpoints_submitted || 0,
        last_analysis_at: session.last_analysis_at || null,
        xrpl_events_since_analysis: session.xrpl_events_since_analysis || 0,
        nudged: session.nudged,
        compacted: session.compacted,
      }
    : null,
  analyses_submitted: analyses.length,
  pending_analyses: pending,
  last_flush_at: state.last_flush_at,
  last_flush_result: state.last_flush_result,
  passive_capture_note: "Passive hooks verified against the docs for Claude Code, Cursor and Codex; Copilot and Grok are best effort (Grok does not document tool results).",
};

if (argv.includes("--json")) {
  process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  process.exit(0);
}

function capturingLine() {
  if (reason) return `NO (not capturing: ${reason})`;
  if (runningAgent) return `yes (${runningAgent})`;
  return `yes for ${registeredAgents.join(", ")} (no agent detected from this shell)`;
}

const lines = [];
lines.push(`XRPL DevEx Capture ${CLIENT_VERSION}`);
lines.push(`Project:        ${project}`);
if (!identity) lines.push("Identity:       not set up (run /xrpl-setup or node hook/setup.mjs). Nothing is captured.");
else if (identity.declined) lines.push("Identity:       declined. Nothing is captured. Delete .xrpl-devex/identity.json to change your mind.");
else lines.push(`Participant:    ${identity.participant_id}   Team: ${identity.team_display || identity.team} (${identity.team})`);
lines.push(`Event:          ${config.event}${config.focus_features.length ? "   focus: " + config.focus_features.join(", ") : ""}`);
lines.push(`Endpoint:       ${isConfigured(config) ? config.endpoint : "not configured (REPLACE-ME in " + configPath() + "), events stay local"}`);
if (status.invite) {
  if (status.invite.required && !status.invite.stored) lines.push("Invite code:    REQUIRED and missing. Run /xrpl-setup invite <code> (or node hook/setup.mjs --invite <code>); events stay buffered until then.");
  else if (status.invite.stored) lines.push(`Invite code:    stored${status.invite.required ? " (required by this event)" : ""}`);
}
if (state.last_flush_result && /invite_(required|invalid)/.test(state.last_flush_result)) lines.push("Invite code:    the last flush was refused (" + state.last_flush_result.replace(/^failed: /, "") + "). Ask the organizer for the current code and run /xrpl-setup invite <code>.");
lines.push(`Hooks:          ${status.hooks_registered ? "registered in " + status.settings_file : "NOT registered (no project hook file contains capture.mjs)"}`);
lines.push(`Agents:         ${PROJECT_AGENTS.map((a) => `${a} ${agents[a].registered ? "registered" : "not registered"}`).join(", ")}`);
lines.push(`Reflection:     ${status.reflection_hook_registered ? "registered" : "not registered"}`);
lines.push(`Capturing:      ${capturingLine()}`);
lines.push(`Buffered:       ${buffered.length} event(s)${buffered.length ? " " + JSON.stringify(status.buffered_by_kind) : ""}`);
lines.push(`Sent:           ${sent.length} event(s)${sent.length ? " " + JSON.stringify(status.sent_by_channel) : ""}`);
if (session) {
  lines.push(`Session:        ${session.session_id} started ${session.session_started_at}, ${session.turn} turn(s), ${session.reflections_sent} reflection(s) sent, ${session.reflection_prompts || 0} reflection prompt(s)`);
}
lines.push(`Analyses:       ${analyses.length} submitted (${analyses.filter((a) => a.trigger === "checkpoint").length} automatic checkpoint(s)), ${pending} pending${Number(config.analysis_checkpoint_hours) > 0 ? `, next checkpoint after ${config.analysis_checkpoint_hours} h of XRPL activity` : ""}`);
lines.push(`Last flush:     ${state.last_flush_at ? state.last_flush_at + " " + state.last_flush_result : "never"}`);
lines.push(`Note:           ${status.passive_capture_note}`);
process.stdout.write(lines.join("\n") + "\n");
