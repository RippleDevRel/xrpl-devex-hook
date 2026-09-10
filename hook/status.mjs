#!/usr/bin/env node
// Local status, no network. What a participant runs (or /xrpl-status runs for
// them) to see that the hook is alive.
//   node hook/status.mjs [--json] [--project <dir>]

import fs from "node:fs";
import path from "node:path";
import { loadConfig, isConfigured, configPath } from "./lib/config.mjs";
import { loadIdentity, isActive } from "./lib/identity.mjs";
import { loadState, currentSession } from "./lib/state.mjs";
import { readJsonl } from "./lib/buffer.mjs";
import { dataPaths, projectDir, HOOK_DIR } from "./lib/paths.mjs";
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

function count(file) {
  return readJsonl(file).length;
}

function hooksRegistered() {
  const candidates = [
    path.join(project, ".claude", "settings.json"),
    path.join(project, ".grok", "hooks", "xrpl-devex.json"),
    path.join(project, ".codex", "hooks.json"),
    path.join(project, ".cursor", "hooks.json"),
  ];
  const found = [];
  let reflection = false;
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const text = fs.readFileSync(file, "utf8");
      if (text.includes("capture.mjs") || text.includes("stop-hook.mjs")) {
        found.push(file);
        if (text.includes("stop-hook.mjs")) reflection = true;
      }
    } catch (err) {
      return { file, registered: false, reason: err.message };
    }
  }
  if (!found.length) {
    return { file: candidates[0], registered: false, reason: "no project hook file contains capture.mjs" };
  }
  return { file: found.join(", "), registered: true, reflection };
}

const pending = fs.existsSync(p.pendingAnalyses) ? fs.readdirSync(p.pendingAnalyses).filter((f) => f.endsWith(".json")).length : 0;
const analyses = readJsonl(p.analysesLog);
const sent = readJsonl(p.sent);
const buffered = readJsonl(p.buffer);
const hooks = hooksRegistered();

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
  hooks_registered: hooks.registered === true,
  reflection_hook_registered: hooks.reflection === true,
  settings_file: hooks.file,
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
        nudged: session.nudged,
        compacted: session.compacted,
      }
    : null,
  analyses_submitted: analyses.length,
  pending_analyses: pending,
  last_flush_at: state.last_flush_at,
  last_flush_result: state.last_flush_result,
  passive_capture_note: "Passive hooks (prompts, tool results) run in Claude Code, Grok, Codex and Cursor.",
};

if (argv.includes("--json")) {
  process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  process.exit(0);
}

const lines = [];
lines.push(`XRPL DevEx Capture ${CLIENT_VERSION}`);
lines.push(`Project:        ${project}`);
if (!identity) lines.push("Identity:       not set up (run /xrpl-setup or node hook/setup.mjs). Nothing is captured.");
else if (identity.declined) lines.push("Identity:       declined. Nothing is captured. Delete .xrpl-devex/identity.json to change your mind.");
else lines.push(`Participant:    ${identity.participant_id}   Team: ${identity.team_display || identity.team} (${identity.team})`);
lines.push(`Event:          ${config.event}${config.focus_features.length ? "   focus: " + config.focus_features.join(", ") : ""}`);
lines.push(`Endpoint:       ${isConfigured(config) ? config.endpoint : "not configured (REPLACE-ME in " + configPath() + "), events stay local"}`);
lines.push(`Hooks:          ${hooks.registered ? "registered in " + hooks.file : "NOT registered (" + (hooks.reason || "capture.mjs not found in " + hooks.file) + ")"}`);
lines.push(`Reflection:     ${hooks.reflection ? "registered" : "not registered"}`);
lines.push(`Buffered:       ${buffered.length} event(s)${buffered.length ? " " + JSON.stringify(status.buffered_by_kind) : ""}`);
lines.push(`Sent:           ${sent.length} event(s)${sent.length ? " " + JSON.stringify(status.sent_by_channel) : ""}`);
if (session) {
  lines.push(`Session:        ${session.session_id} started ${session.session_started_at}, ${session.turn} turn(s), ${session.reflections_sent} reflection(s) sent, ${session.reflection_prompts || 0} reflection prompt(s)`);
}
lines.push(`Analyses:       ${analyses.length} submitted, ${pending} pending`);
lines.push(`Last flush:     ${state.last_flush_at ? state.last_flush_at + " " + state.last_flush_result : "never"}`);
lines.push(`Note:           ${status.passive_capture_note}`);
process.stdout.write(lines.join("\n") + "\n");
