#!/usr/bin/env node
// Validated submission. The only scripts that talk to the network are this one
// and the flush in capture.mjs, and both only talk to our Worker.
//
//   node hook/submit.mjs --channel reflection --json '<event fields>'   validate, POST /ingest (falls back to the buffer on network failure)
//   node hook/submit.mjs --local --json '<event fields>'                validate, append to .xrpl-devex/buffer.jsonl (used by /xrpl-feedback)
//   printf '%s' '<json>' | node hook/submit.mjs --channel reflection --json -
//   node hook/submit.mjs --analysis <report.json> --markdown <report.md> [--session <id>]
//   node hook/submit.mjs --session <id> ...                             attach a session id (Claude Code exposes ${CLAUDE_SESSION_ID} to skills)
//
// Event fields accepted from the caller: surface, friction_type, feature,
// tx_type, result_code, summary, text. Everything else (id, ts, participant,
// team, event, channel, kind, evidence) is filled in here so nothing
// hand-writes the buffer.
//
// Exit codes: 0 sent, buffered or skipped as duplicate; 1 validation or config
// error (message on stderr); 3 network error that could not be buffered.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig, isConfigured } from "./lib/config.mjs";
import { loadIdentity, isActive, participantPayload } from "./lib/identity.mjs";
import { makeEvent, redactEvent } from "./lib/events.mjs";
import { validateEvent, validateAnalysis, FEATURE_RE } from "./lib/taxonomy.mjs";
import { appendEvents, appendAnalysesLog } from "./lib/buffer.mjs";
import { loadAllowlist, compileAllowlist, normalizeResultCode } from "./lib/matcher.mjs";
import { postJson } from "./lib/net.mjs";
import { dataPaths, ensureDataDir, projectDir } from "./lib/paths.mjs";
import { updateState } from "./lib/state.mjs";
import { redactDeep } from "./lib/redact.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : undefined;
};

if (val("--project")) process.env.XRPL_DEVEX_PROJECT_DIR = path.resolve(val("--project"));

function fail(msg, code = 1) {
  process.stderr.write("xrpl-devex submit: " + msg + "\n");
  process.exit(code);
}

function say(msg) {
  process.stdout.write(msg + "\n");
}

function readJsonArg(raw) {
  let text = raw;
  if (raw === "-" || raw === undefined) {
    try {
      text = fs.readFileSync(0, "utf8");
    } catch {
      text = "";
    }
  }
  if (!text || !text.trim()) fail("no JSON provided. Pass --json '<object>' or pipe it with --json -");
  try {
    return JSON.parse(text);
  } catch (err) {
    fail("invalid JSON: " + err.message);
  }
}

function normalizeForDedup(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Normalized dedup hash with a capped state file, from the SingHacks submit.mjs.
function isDuplicate(text, hint) {
  try {
    const p = ensureDataDir(hint);
    const hash = crypto.createHash("sha256").update(normalizeForDedup(text)).digest("hex");
    let seen = [];
    if (fs.existsSync(p.submitState)) seen = JSON.parse(fs.readFileSync(p.submitState, "utf8"));
    if (!Array.isArray(seen)) seen = [];
    if (seen.includes(hash)) return true;
    seen.push(hash);
    fs.writeFileSync(p.submitState, JSON.stringify(seen.slice(-200)));
    return false;
  } catch {
    return false;
  }
}

function normalizeFeature(f) {
  if (f === undefined || f === null || f === "") return null;
  const s = String(f).trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  return s || null;
}

function canonicalTxType(tx, compiled) {
  if (tx === undefined || tx === null || tx === "") return null;
  const key = String(tx).trim().toLowerCase();
  const hit = compiled.txTypes && compiled.txTypes.canon.get(key);
  if (!hit) fail(`tx_type "${tx}" is not a known XRPL transaction type. Use the canonical name from the XRPL transaction reference, or null.`);
  return hit;
}

async function submitEvent() {
  const identity = loadIdentity();
  if (!identity) fail("identity is not set up. Run node hook/setup.mjs (or /xrpl-setup) first.");
  if (!isActive(identity)) fail("the participant declined data capture; nothing is submitted.");
  const config = loadConfig();
  const compiled = compileAllowlist(loadAllowlist());
  const local = has("--local");
  const channel = val("--channel") || (local ? "feedback" : "reflection");
  if (!["reflection", "feedback"].includes(channel)) fail("--channel must be reflection or feedback");
  const input = readJsonArg(val("--json"));
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("the JSON must be an object");

  const sessionId = val("--session") || process.env.CLAUDE_SESSION_ID || null;
  const rc = input.result_code === undefined || input.result_code === null || input.result_code === "" ? null : normalizeResultCode(String(input.result_code), compiled);
  if (input.result_code && !rc) fail(`result_code "${input.result_code}" does not look like an XRPL result code (tec, tem, ter, tef, tel, tes prefix), use null.`);

  let ev = makeEvent({
    identity,
    config,
    channel,
    kind: channel,
    session_id: sessionId,
    surface: input.surface,
    friction_type: input.friction_type,
    feature: normalizeFeature(input.feature),
    tx_type: canonicalTxType(input.tx_type, compiled),
    result_code: rc,
    evidence: channel === "reflection" ? "inferred" : "reported",
    summary: typeof input.summary === "string" ? input.summary.trim().replace(/\s*\n\s*/g, " ") : null,
    text: typeof input.text === "string" ? input.text.trim() : null,
    payload: input.payload && typeof input.payload === "object" ? input.payload : null,
  });
  if (typeof ev.text === "string" && ev.text.length > 2000) ev.text = ev.text.slice(0, 2000);
  ev = redactEvent(ev);

  const v = validateEvent(ev);
  if (!v.ok) fail("invalid event:\n  - " + v.errors.join("\n  - "));

  if (isDuplicate(ev.text)) {
    say("skipped: duplicate item already submitted in this project");
    process.exit(0);
  }

  const label = `${channel} ${ev.surface}/${ev.friction_type}`;
  // A reflection counts against the per-session cap as soon as it is accepted
  // locally, whether it is sent now or buffered for the next flush.
  const countReflection = () => {
    if (channel !== "reflection") return;
    updateState(undefined, sessionId || "default", (state, session) => {
      session.reflections_sent += 1;
    });
  };
  if (local || !isConfigured(config)) {
    appendEvents([ev]);
    countReflection();
    say(`buffered: ${label}${local ? "" : " (endpoint not configured yet, will flush later)"}`);
    process.exit(0);
  }

  const res = await postJson(config.endpoint + "/ingest", { participant: participantPayload(identity, config), events: [ev] }, { headers: { "x-ingest-key": config.ingest_key }, timeoutMs: Math.max(1000, config.flush_timeout_seconds * 1000) });
  if (res.ok) {
    fs.appendFileSync(ensureDataDir().sent, JSON.stringify(ev) + "\n");
    countReflection();
    say(`submitted: ${label}`);
    process.exit(0);
  }
  if (res.status === 400 || res.status === 403) {
    fail(`server rejected the item (${res.status}): ${JSON.stringify(res.body)}`);
  }
  appendEvents([ev]);
  countReflection();
  say(`buffered: ${label} (network: ${res.error}; it will be sent at the next flush)`);
  process.exit(0);
}

async function submitAnalysis() {
  const identity = loadIdentity();
  if (!identity) fail("identity is not set up. Run node hook/setup.mjs (or /xrpl-setup) first.");
  if (!isActive(identity)) fail("the participant declined data capture; nothing is submitted.");
  const config = loadConfig();
  const jsonPath = val("--analysis");
  const mdPath = val("--markdown");
  if (!jsonPath || !mdPath) fail("--analysis <report.json> and --markdown <report.md> are both required");
  let block;
  try {
    block = JSON.parse(fs.readFileSync(path.resolve(jsonPath), "utf8"));
  } catch (err) {
    fail("could not read the analysis JSON: " + err.message);
  }
  let markdown;
  try {
    markdown = fs.readFileSync(path.resolve(mdPath), "utf8");
  } catch (err) {
    fail("could not read the markdown report: " + err.message);
  }
  block = { ...block, participant: identity.participant_id, team: identity.team, event: config.event };
  if (block.friction) {
    block.friction = block.friction.map((f) => ({ ...f, feature: normalizeFeature(f.feature) }));
  }
  const v = validateAnalysis(block);
  if (!v.ok) fail("invalid analysis JSON:\n  - " + v.errors.join("\n  - "));
  const found = new Set();
  block = redactDeep(block, found);
  markdown = redactDeep(markdown, found);
  if (found.size) block.redacted = [...new Set([...(block.redacted || []), ...[...found].map((t) => `auto:${t}`)])];

  const sessionId = val("--session") || process.env.CLAUDE_SESSION_ID || null;
  const id = typeof block.analysis_id === "string" && /^[A-Za-z0-9._:-]{8,80}$/.test(block.analysis_id) ? block.analysis_id : crypto.randomUUID();
  const body = { participant: participantPayload(identity, config), analysis: { id, ts: new Date().toISOString(), session_id: sessionId, json: block, markdown } };

  const markSubmitted = (status) => {
    appendAnalysesLog(undefined, { at: new Date().toISOString(), id, status, coverage: block.coverage, json: path.resolve(jsonPath), markdown: path.resolve(mdPath) });
    updateState(undefined, sessionId || "default", (state, session) => {
      session.analysis_submitted = true;
    });
  };

  if (!isConfigured(config)) {
    const p = ensureDataDir();
    fs.mkdirSync(p.pendingAnalyses, { recursive: true });
    const file = path.join(p.pendingAnalyses, `${Date.now()}-${id}.json`);
    fs.writeFileSync(file, JSON.stringify(body));
    markSubmitted("pending");
    say(`saved for later: endpoint not configured yet. ${file}`);
    process.exit(0);
  }

  const res = await postJson(config.endpoint + "/analysis", body, { headers: { "x-ingest-key": config.ingest_key }, timeoutMs: Math.max(3000, config.flush_timeout_seconds * 2000) });
  if (res.ok) {
    markSubmitted("sent");
    say(`submitted analysis ${id} (${res.body && res.body.exploded !== undefined ? res.body.exploded + " friction rows" : "ok"})`);
    process.exit(0);
  }
  if (res.status === 400 || res.status === 403) fail(`server rejected the analysis (${res.status}): ${JSON.stringify(res.body)}`);
  const p = ensureDataDir();
  fs.mkdirSync(p.pendingAnalyses, { recursive: true });
  const file = path.join(p.pendingAnalyses, `${Date.now()}-${id}.json`);
  fs.writeFileSync(file, JSON.stringify(body));
  markSubmitted("pending");
  say(`network error (${res.error}). Saved to ${file}; it is retried at the next flush, or run: node hook/submit.mjs --retry-pending`);
  process.exit(0);
}

async function retryPending() {
  const { flushPendingAnalyses, flushBuffer } = await import("./lib/buffer.mjs");
  const identity = loadIdentity();
  if (!isActive(identity)) fail("identity is not set up or declined.");
  const config = loadConfig();
  if (!isConfigured(config)) fail("endpoint not configured in hook/devex.config.json");
  const b = await flushBuffer({ config, identity });
  const a = await flushPendingAnalyses({ config });
  say(`buffer: sent ${b.sent}, remaining ${b.remaining}${b.error ? ", error " + b.error : ""}`);
  say(`pending analyses: sent ${a.sent}, remaining ${a.remaining}${a.error ? ", error " + a.error : ""}`);
  process.exit(b.ok && !a.error ? 0 : 3);
}

if (has("--text")) {
  fail("v2 takes structured JSON, not --text. Example: --channel reflection --json '{\"surface\":\"docs\",\"friction_type\":\"doc_gap\",\"feature\":null,\"tx_type\":null,\"result_code\":null,\"summary\":\"...\",\"text\":\"...\"}'");
} else if (has("--analysis")) {
  submitAnalysis().catch((err) => fail(String((err && err.message) || err)));
} else if (has("--retry-pending")) {
  retryPending().catch((err) => fail(String((err && err.message) || err), 3));
} else if (has("--json")) {
  submitEvent().catch((err) => fail(String((err && err.message) || err)));
} else {
  fail("usage: --json '<fields>' [--channel reflection|feedback] [--local] [--session <id>] | --analysis <json> --markdown <md> | --retry-pending. Project: " + projectDir());
}
