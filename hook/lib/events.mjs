// Builds wire-shaped events (section 6 of the brief). One shape for every
// channel so the buffer, submit.mjs and the Worker all speak the same thing.

import crypto from "node:crypto";
import { redactDeep } from "./redact.mjs";

const NULLABLE = ["session_id", "feature", "tx_type", "result_code", "attempts", "elapsed_seconds", "failed", "tool_name", "text", "summary", "payload", "author", "agent", "tx_hash"];

export function makeEvent({ identity, config, channel, kind, session_id = null, ts = null, ...fields }) {
  const ev = {
    id: crypto.randomUUID(),
    event: config.event,
    team: identity.team,
    participant_id: identity.participant_id,
    session_id,
    ts: ts || new Date().toISOString(),
    channel,
    kind,
    surface: fields.surface || "unknown",
    friction_type: fields.friction_type || "raw",
    feature: fields.feature ?? null,
    tx_type: fields.tx_type ?? null,
    result_code: fields.result_code ?? null,
    evidence: fields.evidence || "observed",
    attempts: fields.attempts ?? null,
    elapsed_seconds: fields.elapsed_seconds ?? null,
    failed: fields.failed === undefined || fields.failed === null ? null : fields.failed ? 1 : 0,
    tool_name: fields.tool_name ?? null,
    text: fields.text ?? null,
    summary: fields.summary ?? null,
    payload: fields.payload ?? null,
    author: fields.author ?? null,
    // which coding agent produced the row, and the first validated hash when a
    // transaction result was captured (public, kept for on-chain verification)
    agent: fields.agent ?? null,
    tx_hash: fields.tx_hash ?? null,
  };
  for (const k of NULLABLE) if (ev[k] === undefined) ev[k] = null;
  return ev;
}

// Redacts text, summary and payload strings in place of the original.
export function redactEvent(ev) {
  const found = new Set();
  const out = { ...ev };
  out.text = redactDeep(ev.text, found);
  out.summary = redactDeep(ev.summary, found);
  out.payload = redactDeep(ev.payload, found);
  // validated transaction hashes extracted on purpose are public and kept
  if (ev.payload && Array.isArray(ev.payload.tx_hashes)) out.payload = { ...out.payload, tx_hashes: ev.payload.tx_hashes.slice() };
  if (found.size) {
    out.payload = { ...(out.payload && typeof out.payload === "object" ? out.payload : {}), redacted: [...found] };
  }
  return out;
}

export function truncate(text, max) {
  if (typeof text !== "string") return text;
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 15)) + " [truncated]";
}
