// Per-session local state in .xrpl-devex/state.json.
//
// Several Claude Code sessions can run in the same project, so the file holds
// one entry per session_id and prunes old ones. Writes are atomic (temp file
// plus rename). Concurrent hooks in one turn may race on a counter; the worst
// case is an undercounted turn, never a crash.

import fs from "node:fs";
import path from "node:path";
import { dataPaths, ensureDataDir } from "./paths.mjs";

export const RING_SIZE = 20;
const KEEP_SESSIONS = 6;

export function emptyState() {
  return { version: 2, current_session_id: null, sessions: {}, last_flush_at: null, last_flush_result: null };
}

export function newSession(sessionId, now = new Date()) {
  return {
    session_id: sessionId,
    session_started_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    turn: 0,
    turn_errors: 0,
    turn_result_codes: [],
    nudged: false,
    analysis_submitted: false,
    reflections_sent: 0,
    last_reflection_turn: null,
    recent_tool_results: [],
    compacted: false,
  };
}

export function loadState(hint) {
  try {
    const raw = fs.readFileSync(dataPaths(hint).state, "utf8");
    const s = JSON.parse(raw);
    if (s && typeof s === "object" && s.sessions && typeof s.sessions === "object") return s;
  } catch {
    // missing or corrupt: start fresh
  }
  return emptyState();
}

export function saveState(state, hint) {
  const p = ensureDataDir(hint);
  const tmp = p.state + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, p.state);
}

export function sessionOf(state, sessionId, now = new Date()) {
  const id = sessionId || "default";
  if (!state.sessions[id]) state.sessions[id] = newSession(id, now);
  state.current_session_id = id;
  state.sessions[id].last_seen_at = now.toISOString();
  pruneSessions(state);
  return state.sessions[id];
}

export function pruneSessions(state) {
  const ids = Object.keys(state.sessions);
  if (ids.length <= KEEP_SESSIONS) return;
  ids
    .sort((a, b) => String(state.sessions[b].last_seen_at).localeCompare(String(state.sessions[a].last_seen_at)))
    .slice(KEEP_SESSIONS)
    .forEach((id) => {
      if (id !== state.current_session_id) delete state.sessions[id];
    });
}

// Load, mutate, save. fn receives (state, session). Returns whatever fn returns.
export function updateState(hint, sessionId, fn) {
  const state = loadState(hint);
  const session = sessionOf(state, sessionId);
  const result = fn(state, session);
  saveState(state, hint);
  return result;
}

export function currentSession(state) {
  if (state.current_session_id && state.sessions[state.current_session_id]) return state.sessions[state.current_session_id];
  const ids = Object.keys(state.sessions);
  if (!ids.length) return null;
  ids.sort((a, b) => String(state.sessions[b].last_seen_at).localeCompare(String(state.sessions[a].last_seen_at)));
  return state.sessions[ids[0]];
}

export function pushRing(session, entry) {
  session.recent_tool_results.push(entry);
  if (session.recent_tool_results.length > RING_SIZE) {
    session.recent_tool_results.splice(0, session.recent_tool_results.length - RING_SIZE);
  }
}

export function statePath(hint) {
  return path.resolve(dataPaths(hint).state);
}
