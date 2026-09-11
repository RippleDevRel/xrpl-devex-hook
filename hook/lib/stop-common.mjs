// Shared pieces for the per-agent stop hooks: stdin parsing, identity gate,
// session guards (cooldown and per-session cap) and the signal decision used
// by the Claude Code hook.

import fs from "node:fs";
import { loadConfig } from "./config.mjs";
import { loadIdentity, isActive } from "./identity.mjs";
import { loadState, saveState, sessionOf } from "./state.mjs";
import { loadAllowlist, compileAllowlist, matchText } from "./matcher.mjs";
import { passesSampling } from "../sampling.mjs";
import { normalizeHookInput } from "./normalize.mjs";

export function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? normalizeHookInput(JSON.parse(raw)) : {};
  } catch {
    return null;
  }
}

// Returns { fire: boolean, signal, sessionId, config } and records the
// decision in state so cooldown and the per-session cap hold even when the
// model decides not to submit anything.
export function decideReflection(input, { useSignal = true } = {}) {
  const hint = typeof input.cwd === "string" ? input.cwd : undefined;
  const identity = loadIdentity(hint);
  if (!isActive(identity)) return { fire: false, reason: "no identity" };
  const config = loadConfig();
  const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : "default";
  const state = loadState(hint);
  const session = sessionOf(state, sessionId);

  if (session.skill_turn) return { fire: false, reason: "skill turn" };
  if (session.checkpoint_turn === session.turn) return { fire: false, reason: "checkpoint turn" };
  if (session.reflections_sent >= config.reflection_max_per_session) return { fire: false, reason: "max per session" };
  const inCooldown = session.last_reflection_turn !== null && session.turn - session.last_reflection_turn < config.reflection_cooldown_turns;

  // A real signal (an XRPL error captured this turn, or a strong XRPL mention in
  // the answer) fires even during the cooldown: the cooldown only paces the
  // random fallback, so a lucky sample on a quiet turn can never silence the
  // error turn that follows. One prompt per turn and the per-session cap still hold.
  let signal = null;
  if (useSignal) {
    if (session.turn_errors > 0) signal = "error";
    else if (typeof input.last_assistant_message === "string" && input.last_assistant_message) {
      const m = matchText(input.last_assistant_message, compileAllowlist(loadAllowlist()));
      if (m.strong) signal = "match";
    }
  }
  if (session.last_reflection_turn === session.turn) return { fire: false, reason: "already prompted this turn" };
  if (!signal && !inCooldown && passesSampling(config)) signal = "sample";
  if (!signal) return { fire: false, reason: inCooldown ? "cooldown" : "no signal" };

  session.last_reflection_turn = session.turn;
  session.reflection_prompts = (session.reflection_prompts || 0) + 1;
  saveState(state, hint);
  return { fire: true, signal, sessionId, config, hint };
}
