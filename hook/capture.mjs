#!/usr/bin/env node
// Passive capture hook for Claude Code. One script serves every hook event:
//
//   node capture.mjs --event SessionStart|UserPromptSubmit|PostToolUse|PostToolUseFailure|Stop|PreCompact|SessionEnd
//   node capture.mjs --event PostToolUse --package-install     (handlers gated by "if": "Bash(npm install *)" etc.)
//
// Contract: read stdin JSON, match against the XRPL allowlist, append one JSON
// line to .xrpl-devex/buffer.jsonl, exit 0. Always exit 0, never print to the
// participant. Network only on Stop (opportunistic flush) and SessionEnd
// (final flush), with a hard timeout. Stdout is used only where Claude Code
// feeds it back as context: SessionStart (plain text or JSON) and Stop (JSON
// hookSpecificOutput.additionalContext for the analysis nudge).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, isConfigured } from "./lib/config.mjs";
import { loadIdentity, isActive } from "./lib/identity.mjs";
import { loadState, saveState, sessionOf, newSession, pushRing } from "./lib/state.mjs";
import { appendEvents, flushBuffer, flushPendingAnalyses, readJsonl, oldestTimestamp } from "./lib/buffer.mjs";
import { makeEvent, redactEvent, truncate } from "./lib/events.mjs";
import { loadAllowlist, compileAllowlist, matchText, parseInstallCommand } from "./lib/matcher.mjs";
import { dataPaths, fwd } from "./lib/paths.mjs";
import { debug } from "./lib/log.mjs";
import { normalizeHookInput } from "./lib/normalize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const eventArg = argv[argv.indexOf("--event") + 1];
const packageInstall = argv.includes("--package-install");

function exit0() {
  process.exit(0);
}

function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? normalizeHookInput(JSON.parse(raw)) : {};
  } catch {
    return null;
  }
}

let compiledCache = null;
function compiled() {
  if (!compiledCache) compiledCache = compileAllowlist(loadAllowlist());
  return compiledCache;
}

function isInstallCommand(command) {
  return typeof command === "string" && /(^|[;&|]\s*)(npm|npx|yarn|pnpm|bun|pip|pip3|python3? -m pip|uv|poetry)\s+(install|i|add)\b/.test(command);
}

// "node /abs/path/loanSet.js --x # comment" -> "node loanSet.js --x"
export function normalizeCommand(command) {
  if (typeof command !== "string") return "";
  return command
    .split("#")[0]
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => (tok.includes("/") && !tok.startsWith("-") && !/^https?:/i.test(tok) ? path.basename(tok) : tok))
    .join(" ")
    .trim()
    .slice(0, 200);
}

function ageSeconds(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : 0;
}

function toolHaystack(toolName, input, response) {
  const inp = input && typeof input === "object" ? input : {};
  let resp = response;
  if (resp && typeof resp === "object") {
    const parts = [];
    for (const k of ["stdout", "stderr", "output", "output_for_prompt", "content", "result", "error", "message"]) if (typeof resp[k] === "string") parts.push(resp[k]);
    if (Array.isArray(resp.content)) for (const c of resp.content) if (c && typeof c.text === "string") parts.push(c.text);
    resp = parts.join("\n");
  }
  if (typeof resp !== "string") resp = "";
  switch (toolName) {
    case "Bash":
      return { subject: String(inp.command || ""), output: resp, url: null, filePath: null };
    case "Write":
      return { subject: String(inp.file_path || ""), output: String(inp.content || ""), url: null, filePath: inp.file_path || null };
    case "Edit":
      return { subject: String(inp.file_path || ""), output: [inp.old_string, inp.new_string].filter((s) => typeof s === "string").join("\n"), url: null, filePath: inp.file_path || null };
    case "Read":
      return { subject: String(inp.file_path || ""), output: resp, url: null, filePath: inp.file_path || null };
    case "WebFetch":
      return { subject: String(inp.url || ""), output: "", url: inp.url || null, filePath: null };
    case "WebSearch":
      return { subject: String(inp.query || ""), output: "", url: null, filePath: null, query: inp.query || null };
    default:
      return { subject: JSON.stringify(inp).slice(0, 4000), output: resp, url: null, filePath: null };
  }
}

function isErrorCode(code) {
  return typeof code === "string" && code !== "tesSUCCESS";
}

// Our own scripts print XRPL terms by design (status, setup); never capture them.
function isOwnCommand(command, output) {
  return (
    (typeof command === "string" && /\b(capture|status|setup|submit|stop-hook|print-instruction|report|export)\.mjs\b/.test(command)) ||
    (typeof output === "string" && /^\s*XRPL DevEx Capture \d/.test(output))
  );
}

// Reading a spec, a reference page or type definitions produces output that
// lists dozens of transaction types and result codes. That is documentation
// being consulted, not an error: no tx_type, no result_code, no failure, no
// retry tracking, and no text stored (only the URL when the command fetched one).
const DOC_LIKE = { result_codes: 3, tx_types: 6, matches: 20 };
function looksLikeDocs(m) {
  const distinct = (kind) => new Set(m.matches.filter((x) => x.kind === kind).map((x) => x.canonical)).size;
  return distinct("result_code") > DOC_LIKE.result_codes || distinct("tx_type") > DOC_LIKE.tx_types || m.matches.length > DOC_LIKE.matches;
}

// Payload matches are capped; the count is kept.
const MAX_MATCHES = 15;
function matchSummary(m) {
  return m.matches.length > MAX_MATCHES ? { matches: m.matches.slice(0, MAX_MATCHES), match_count: m.matches.length } : { matches: m.matches };
}

// Does a prompt read like a question or a problem report? Used with
// prompt_text = "signal" together with tx_type and result_code hits.
const PROBLEM_RE = /\?|\b(why|how|what|which|fail(s|ed|ing|ure)?|error|errors|doesn'?t|does not|didn'?t|can'?t|cannot|won'?t|not work(ing)?|stuck|wrong|issue|problem|reject(ed|s)?|unexpected|invalid|missing|broken|bug|pourquoi|comment|erreur|marche pas|fonctionne pas|bloqu\w*|impossible)\b/i;
function promptHasSignal(prompt, m) {
  return Boolean(m.tx_type || m.result_code || PROBLEM_RE.test(prompt));
}

// Our own repo and data directory show up in commands and listings ("git pull
// xrpl-devex-hook", "ls .xrpl-devex"): the "xrpl" inside must not count as a hit.
function stripOwn(text) {
  return typeof text === "string" ? text.replace(/\.?xrpl-devex[\w.-]*/gi, " ").replace(/XRPL DevEx Capture/gi, " ") : text;
}

// SDK exceptions without a result code, as printed when thrown ("Name: message"
// or "Name(...)" in a Python traceback), not as read in source code
// ("new errors_1.XRPLFaucetError("). Counts as a failure for the turn.
const ERROR_CLASS_RE = /(?<![\w.])((?:XRPL|Xrpl|Rippled)\w*(?:Error|Exception)|ValidationError|NotConnectedError|DisconnectedError|ResponseFormatError|XRPLFaucetError)(?::\s|\s*\(|\s+-\s)/;
function detectErrorClass(output) {
  if (typeof output !== "string") return null;
  const m = output.match(ERROR_CLASS_RE);
  return m ? m[1] : null;
}

function firstUrl(text) {
  const u = typeof text === "string" ? text.match(/https?:\/\/[^\s"'<>)]+/) : null;
  return u ? u[0] : null;
}

// Retry-loop bookkeeping on the session ring. Returns { attempt, first_attempt_at, resolved }.
function retryTrack(session, entry) {
  const key = entry.tx_type ? (e) => e.tx_type === entry.tx_type : (e) => e.normalized_command && e.normalized_command === entry.normalized_command;
  const previousFailed = [...session.recent_tool_results].reverse().find((e) => e.failed && key(e) && !e.resolved);
  let attempt = 1;
  let firstAttemptAt = entry.ts;
  let resolved = null;
  if (previousFailed) {
    attempt = (previousFailed.attempt || 1) + 1;
    firstAttemptAt = previousFailed.first_attempt_at || previousFailed.ts;
    if (!entry.failed) {
      resolved = {
        tx_type: entry.tx_type || previousFailed.tx_type || null,
        attempts: attempt,
        elapsed_seconds: Math.max(0, Math.round((Date.parse(entry.ts) - Date.parse(firstAttemptAt)) / 1000)),
        last_result_code_before_success: previousFailed.result_code || null,
        normalized_command: entry.normalized_command || null,
      };
      for (const e of session.recent_tool_results) if (e.failed && key(e)) e.resolved = true;
    }
  }
  pushRing(session, { ...entry, attempt, first_attempt_at: firstAttemptAt });
  return { attempt, first_attempt_at: firstAttemptAt, resolved };
}

async function main() {
  const input = readStdin();
  if (!input) exit0();
  const hint = typeof input.cwd === "string" ? input.cwd : undefined;
  const eventName = eventArg || input.hook_event_name;
  const sessionId = typeof input.session_id === "string" && input.session_id ? input.session_id : "default";
  const identity = loadIdentity(hint);
  const config = loadConfig();

  if (!isActive(identity)) {
    if (eventName === "SessionStart" && !identity) {
      const setup = fwd(path.join(HERE, "setup.mjs"));
      process.stdout.write(
        `XRPL DevEx Capture is installed in this project but no identity is set up, so nothing is captured. The /xrpl-setup skill, or "node ${setup}", shows the consent text and asks for a team name. Setup only proceeds after the developer answers.\n`,
      );
    }
    exit0();
  }

  const state = loadState(hint);
  const now = new Date();
  const nowIso = now.toISOString();
  const base = { identity, config, session_id: sessionId, channel: "hook" };
  const events = [];
  let stdoutJson = null;
  let stdoutText = null;
  let session;

  switch (eventName) {
    case "SessionStart": {
      const source = String(input.source || "startup");
      if (source === "startup" || source === "clear") {
        state.sessions[sessionId] = newSession(sessionId, now);
      }
      session = sessionOf(state, sessionId, now);
      if (source === "compact") session.compacted = true;
      session.turn_errors = 0;
      session.turn_result_codes = [];
      events.push(makeEvent({ ...base, kind: "session_start", payload: { source, model: typeof input.model === "string" ? input.model : undefined } }));
      if (source === "compact") {
        stdoutJson = {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: `Context was just compacted in an XRPL session (${session.turn} turns so far). Detail from before the compaction is no longer in context, while the local capture buffer keeps the observed facts. If XRPL work happened before, /xrpl-session-analysis can still be run now and will report coverage as compacted.`,
          },
        };
      }
      break;
    }

    case "UserPromptSubmit": {
      session = sessionOf(state, sessionId, now);
      session.turn += 1;
      session.turn_errors = 0;
      session.turn_result_codes = [];
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      // A turn that invokes one of our skills is ours: not recorded, and the
      // reflection stop hook stays quiet on it.
      session.skill_turn = /^\s*\/xrpl-/i.test(prompt);
      if (prompt && !session.skill_turn) {
        const m = matchText(stripOwn(prompt), compiled());
        if (m.strong) {
          const keepText = config.prompt_text === "always" || (config.prompt_text === "signal" && promptHasSignal(prompt, m));
          const payload = { ...matchSummary(m), turn: session.turn, chars: prompt.length };
          if (!keepText) payload.text_omitted = config.prompt_text === "never" ? "prompt_text=never" : "no_signal";
          events.push(
            makeEvent({
              ...base,
              kind: "prompt",
              tx_type: m.tx_type,
              result_code: m.result_code,
              feature: m.feature,
              text: keepText ? truncate(prompt, config.prompt_max_chars) : null,
              payload,
            }),
          );
        }
      }
      break;
    }

    case "PostToolUse":
    case "PostToolUseFailure": {
      session = sessionOf(state, sessionId, now);
      const toolName = String(input.tool_name || "");
      const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
      const failedEvent = eventName === "PostToolUseFailure";

      if (packageInstall) {
        const packages = parseInstallCommand(toolInput.command, compiled());
        if (packages.length) {
          const manager = String(toolInput.command || "").match(/\b(npm|npx|yarn|pnpm|bun|pip3?|uv|poetry)\b/);
          events.push(makeEvent({ ...base, kind: "package_install", surface: "sdk", tool_name: toolName, payload: { packages, manager: manager ? manager[1] : null, turn: session.turn } }));
        }
        break;
      }

      if (toolName === "Bash" && isInstallCommand(toolInput.command)) break; // handled by the package_install handler

      const hay = toolHaystack(toolName, toolInput, failedEvent ? String(input.error || "") : input.tool_response);
      if (toolName === "Bash" && isOwnCommand(toolInput.command, hay.output)) break;
      const text = stripOwn(hay.subject) + "\n" + stripOwn(hay.output);
      const rawMatch = matchText(text, compiled());
      if (!rawMatch.strong) break;
      if ((toolName === "WebFetch" || toolName === "WebSearch") && !rawMatch.matches.some((x) => x.kind === "domain") && toolName === "WebFetch") break;

      const docLike = looksLikeDocs(rawMatch);
      // A result code is only real when it appears in what the tool produced,
      // never in the command itself (a script being patched, a grep for "tec")
      // and never in file contents written or read. Transaction types may come
      // from the command (node loanSet.js) as well.
      const fileTool = toolName === "Write" || toolName === "Edit" || toolName === "Read";
      const outputMatch = toolName === "Bash" && !docLike ? matchText(stripOwn(hay.output), compiled()) : null;
      const resultCode = outputMatch ? outputMatch.result_code : null;
      // Documentation being read carries no transaction, no result and no failure of its own.
      const m = docLike ? { ...rawMatch, tx_type: null, result_code: null, feature: null } : { ...rawMatch, result_code: fileTool ? null : resultCode };

      const interrupted = Boolean(input.tool_response && typeof input.tool_response === "object" && input.tool_response.interrupted);
      const errorClass = toolName === "Bash" && !docLike ? detectErrorClass(hay.output) : null;
      const failed = failedEvent || interrupted || isErrorCode(m.result_code) || Boolean(errorClass);
      let exitCode = null;
      if (failedEvent) {
        const em = String(input.error || "").match(/^Exit code (\d+)/);
        if (em) exitCode = Number(em[1]);
      }
      if (failed) {
        session.turn_errors += 1;
        if (m.result_code && !session.turn_result_codes.includes(m.result_code)) session.turn_result_codes.push(m.result_code);
      }

      let stored = null;
      const payload = { ...matchSummary(rawMatch), turn: session.turn };
      if (docLike) payload.doc_like = true;
      if (errorClass) payload.error_class = errorClass;
      if (toolName === "Bash") {
        stored = docLike ? firstUrl(toolInput.command) : truncate(hay.output, config.output_max_chars);
        payload.command = normalizeCommand(toolInput.command);
        if (exitCode !== null) payload.exit_code = exitCode;
      } else if (toolName === "WebFetch") {
        stored = hay.url;
      } else if (toolName === "WebSearch") {
        stored = hay.query;
      } else {
        // Write, Edit, Read: file contents are never stored, only the path.
        stored = null;
        payload.file = hay.filePath ? path.basename(hay.filePath) : null;
        if (failedEvent) stored = truncate(String(input.error || ""), config.output_max_chars);
      }

      const ev = makeEvent({ ...base, kind: "tool_result", tool_name: toolName, tx_type: m.tx_type, result_code: m.result_code, feature: m.feature, failed, text: stored, payload });

      if (toolName === "Bash" && !docLike) {
        const track = retryTrack(session, {
          tx_type: m.tx_type,
          result_code: m.result_code,
          normalized_command: payload.command,
          ts: ev.ts,
          failed,
          event_id: ev.id,
        });
        if (track.attempt > 1) {
          ev.attempts = track.attempt;
          ev.payload.first_attempt_at = track.first_attempt_at;
        }
        events.push(ev);
        if (track.resolved) {
          events.push(
            makeEvent({
              ...base,
              kind: "retry_resolved",
              friction_type: "retry_loop",
              tx_type: track.resolved.tx_type,
              result_code: track.resolved.last_result_code_before_success,
              feature: m.feature,
              attempts: track.resolved.attempts,
              elapsed_seconds: track.resolved.elapsed_seconds,
              tool_name: toolName,
              payload: { last_result_code_before_success: track.resolved.last_result_code_before_success, command: track.resolved.normalized_command, first_attempt_at: track.first_attempt_at, turn: session.turn },
            }),
          );
        }
      } else {
        events.push(ev);
      }
      break;
    }

    case "Stop": {
      session = sessionOf(state, sessionId, now);
      const p = dataPaths(hint);
      const buffered = readJsonl(p.buffer);
      const oldest = oldestTimestamp(buffered);
      const tooOld = oldest !== null && Date.now() - oldest > config.flush_max_age_seconds * 1000;
      if (isConfigured(config) && buffered.length && (buffered.length >= config.flush_max_batch || tooOld)) {
        const r = await flushBuffer({ config, identity, hint });
        state.last_flush_at = nowIso;
        state.last_flush_result = r.ok ? `ok: sent ${r.sent}` : `failed: ${r.error}`;
        debug(hint, "stop flush", r);
      }
      if (isConfigured(config) && fs.existsSync(p.pendingAnalyses) && fs.readdirSync(p.pendingAnalyses).some((f) => f.endsWith(".json"))) {
        const r = await flushPendingAnalyses({ config, identity, hint });
        debug(hint, "stop pending analyses", r);
      }
      const minutes = ageSeconds(session.session_started_at) / 60;
      const due = session.turn >= config.nudge_after_turns || minutes >= config.nudge_after_minutes;
      if (due && !session.nudged && !session.analysis_submitted && input.stop_hook_active !== true) {
        session.nudged = true;
        stdoutJson = {
          hookSpecificOutput: {
            hookEventName: "Stop",
            additionalContext: `This XRPL session has run for ${session.turn} turns (${Math.round(minutes)} minutes) without a session analysis. /xrpl-session-analysis captures friction before context is lost. This reminder is shown once per session.`,
          },
        };
      }
      break;
    }

    case "PreCompact": {
      session = sessionOf(state, sessionId, now);
      session.compacted = true;
      events.push(makeEvent({ ...base, kind: "compact", payload: { trigger: String(input.trigger || "auto"), turn: session.turn } }));
      break;
    }

    case "SessionEnd": {
      session = sessionOf(state, sessionId, now);
      events.push(makeEvent({ ...base, kind: "session_end", payload: { reason: String(input.reason || "other"), turn: session.turn } }));
      appendEvents(events.map(redactEvent), hint);
      events.length = 0;
      if (isConfigured(config)) {
        const budgetMs = Math.min(8000, Math.max(1000, config.flush_timeout_seconds * 1000));
        const r = await flushBuffer({ config, identity, hint, timeoutMs: budgetMs });
        state.last_flush_at = nowIso;
        state.last_flush_result = r.ok ? `ok: sent ${r.sent}` : `failed: ${r.error}`;
        const pa = await flushPendingAnalyses({ config, identity, hint, timeoutMs: budgetMs });
        debug(hint, "session end flush", r, pa);
      }
      break;
    }

    default:
      exit0();
  }

  if (events.length) appendEvents(events.map(redactEvent), hint);
  saveState(state, hint);
  if (stdoutJson) process.stdout.write(JSON.stringify(stdoutJson) + "\n");
  else if (stdoutText) process.stdout.write(stdoutText + "\n");
  exit0();
}

main().catch((err) => {
  try {
    debug(undefined, "capture error", String((err && err.stack) || err));
  } catch {
    // ignore
  }
  exit0();
});
