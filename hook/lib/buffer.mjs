// Local event buffer: .xrpl-devex/buffer.jsonl, one event per line, flushed in
// batches to POST /ingest. Flushed lines are appended to sent.jsonl.
//
// Flush protocol (crash safe, tolerant of concurrent appends):
//   1. merge any leftover buffer.flushing.jsonl from an interrupted flush
//   2. rename buffer.jsonl to buffer.flushing.jsonl (new events keep appending
//      to a fresh buffer.jsonl meanwhile)
//   3. POST in chunks of at most 200 events; each successful chunk is appended
//      to sent.jsonl
//   4. on failure, prepend the unsent remainder back to buffer.jsonl
//   5. remove buffer.flushing.jsonl

import fs from "node:fs";
import path from "node:path";
import { dataPaths, ensureDataDir } from "./paths.mjs";
import { participantPayload, writeHeaders, isInviteReject } from "./identity.mjs";
import { postJson } from "./net.mjs";
import { debug } from "./log.mjs";

export const MAX_EVENTS_PER_CALL = 200;

export function appendEvents(events, hint) {
  if (!events || !events.length) return 0;
  const p = ensureDataDir(hint);
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(p.buffer, lines);
  return events.length;
}

export function readJsonl(file) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip a corrupt line rather than lose the whole buffer
    }
  }
  return out;
}

export function countJsonl(file) {
  return readJsonl(file).length;
}

export function oldestTimestamp(events) {
  let oldest = null;
  for (const e of events) {
    const t = Date.parse(e && e.ts);
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }
  return oldest;
}

function mergeLeftover(p) {
  if (!fs.existsSync(p.flushing)) return;
  const leftover = fs.readFileSync(p.flushing, "utf8");
  const current = fs.existsSync(p.buffer) ? fs.readFileSync(p.buffer, "utf8") : "";
  fs.writeFileSync(p.buffer, leftover + (leftover && !leftover.endsWith("\n") ? "\n" : "") + current);
  fs.unlinkSync(p.flushing);
}

function prependToBuffer(p, events) {
  if (!events.length) return;
  const current = fs.existsSync(p.buffer) ? fs.readFileSync(p.buffer, "utf8") : "";
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(p.buffer, lines + current);
}

// Returns { ok, sent, remaining, error, status }.
export async function flushBuffer({ config, identity, hint, timeoutMs }) {
  const p = ensureDataDir(hint);
  const to = timeoutMs || Math.max(500, (config.flush_timeout_seconds || 3) * 1000);
  mergeLeftover(p);
  if (!fs.existsSync(p.buffer)) return { ok: true, sent: 0, remaining: 0, error: null, status: 0 };

  try {
    fs.renameSync(p.buffer, p.flushing);
  } catch (err) {
    return { ok: false, sent: 0, remaining: countJsonl(p.buffer), error: String(err.message || err), status: 0 };
  }
  const events = readJsonl(p.flushing);
  if (!events.length) {
    fs.unlinkSync(p.flushing);
    return { ok: true, sent: 0, remaining: countJsonl(p.buffer), error: null, status: 0 };
  }

  const participant = participantPayload(identity, config);
  const url = config.endpoint + "/ingest";
  let sent = 0;
  let error = null;
  let status = 0;
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_CALL) {
    const chunk = events.slice(i, i + MAX_EVENTS_PER_CALL);
    const res = await postJson(url, { participant, events: chunk }, { headers: writeHeaders(identity, config), timeoutMs: to });
    status = res.status;
    if (!res.ok) {
      error = res.error + (res.body && res.body.error ? `: ${res.body.error}` : "");
      debug(hint, "flush failed", error, res.body);
      // A missing or rotated invite code is fixed by running the setup again:
      // keep everything buffered.
      if (isInviteReject(res)) {
        prependToBuffer(p, events.slice(i));
        break;
      }
      // Permanent rejections (bad payload, banned) must not clog the buffer
      // forever: park them in rejected.jsonl and move on.
      if (res.status === 400 || res.status === 403) {
        fs.appendFileSync(path.join(p.root, "rejected.jsonl"), chunk.map((e) => JSON.stringify({ rejected_at: new Date().toISOString(), status: res.status, reason: res.body, event: e })).join("\n") + "\n");
        continue;
      }
      prependToBuffer(p, events.slice(i));
      break;
    }
    fs.appendFileSync(p.sent, chunk.map((e) => JSON.stringify(e)).join("\n") + "\n");
    sent += chunk.length;
  }
  try {
    fs.unlinkSync(p.flushing);
  } catch {
    // already gone
  }
  return { ok: error === null, sent, remaining: countJsonl(p.buffer), error, status };
}

// Pending analyses saved by submit.mjs after a network failure. Each file holds
// the exact body for POST /analysis. Returns { sent, remaining, error }.
export async function flushPendingAnalyses({ config, identity, hint, timeoutMs }) {
  const p = dataPaths(hint);
  if (!fs.existsSync(p.pendingAnalyses)) return { sent: 0, remaining: 0, error: null };
  const files = fs.readdirSync(p.pendingAnalyses).filter((f) => f.endsWith(".json")).sort();
  const to = timeoutMs || Math.max(500, (config.flush_timeout_seconds || 3) * 1000);
  let sent = 0;
  let error = null;
  for (const f of files) {
    const full = path.join(p.pendingAnalyses, f);
    let body;
    try {
      body = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      fs.renameSync(full, full + ".corrupt");
      continue;
    }
    const res = await postJson(config.endpoint + "/analysis", body, { headers: writeHeaders(identity, config), timeoutMs: to });
    if (res.ok) {
      fs.unlinkSync(full);
      appendAnalysesLog(hint, { at: new Date().toISOString(), id: (res.body && res.body.id) || null, status: "sent_from_pending", file: f });
      sent += 1;
    } else if (isInviteReject(res)) {
      error = res.error + ": " + res.body.error;
      break;
    } else if (res.status === 400 || res.status === 403) {
      fs.renameSync(full, full + ".rejected");
      error = res.error;
    } else {
      error = res.error;
      break;
    }
  }
  const remaining = fs.existsSync(p.pendingAnalyses) ? fs.readdirSync(p.pendingAnalyses).filter((f) => f.endsWith(".json")).length : 0;
  return { sent, remaining, error };
}

export function appendAnalysesLog(hint, entry) {
  const p = ensureDataDir(hint);
  fs.appendFileSync(p.analysesLog, JSON.stringify(entry) + "\n");
}
