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
import { debug, hookLog } from "./lib/log.mjs";
import { runningAgents } from "./lib/install.mjs";
import { buildCheckpointInstruction } from "./checkpoint.mjs";
import { normalizeHookInput } from "./lib/normalize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const eventArg = argv[argv.indexOf("--event") + 1];
const packageInstall = argv.includes("--package-install");

// The cwd carried by stdin, kept for the hook log written by exit0.
let stdinHint;

// Always exit 0. A reason, or an identity file that is not where the resolved
// project root says, leaves one line in the hook log so a silent exit can be
// diagnosed (T16). A declined identity is a decision and stays quiet.
function exit0(reason) {
  let why = reason || "";
  if (!why) {
    try {
      if (loadIdentity(stdinHint) === null) why = `no identity at ${dataPaths(stdinHint).identity} (cwd ${process.cwd()})`;
    } catch {
      // keep quiet rather than fail on the way out
    }
  }
  if (why) hookLog(stdinHint, `${eventArg || "?"} exit 0: ${why}`);
  process.exit(0);
}

function readStdin() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    const input = raw.trim() ? normalizeHookInput(JSON.parse(raw)) : {};
    if (input && typeof input.cwd === "string") stdinHint = input.cwd;
    return input;
  } catch (err) {
    hookLog(undefined, `${eventArg || "?"} exit 0: stdin unreadable or not JSON (${String((err && err.message) || err)})`);
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
    // agents that mirror the same text under two keys must not double a result
    resp = [...new Set(parts)].join("\n");
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
// Output shaped like grep hits (file.md:12: ...) or a markdown table is
// documentation too, whatever the counts.
const DOC_LIKE = { result_codes: 3, tx_types: 6, matches: 20 };
const GREP_LINE_RE = /^\S+\.(?:md|txt|rst|cpp|h|hpp|ts|js|mjs|py|json|toml|yaml|yml):\d+:/gm;
const TABLE_LINE_RE = /^\s*\|.*\|\s*$/gm;
function looksLikeDocs(m, output = "") {
  const distinct = (kind) => new Set(m.matches.filter((x) => x.kind === kind).map((x) => x.canonical)).size;
  if (distinct("result_code") > DOC_LIKE.result_codes || distinct("tx_type") > DOC_LIKE.tx_types || m.matches.length > DOC_LIKE.matches) return true;
  const count = (re) => ((typeof output === "string" ? output : "").match(re) || []).length;
  return count(GREP_LINE_RE) >= 2 || count(TABLE_LINE_RE) >= 2;
}

// A result code is only real when it comes out of code that ran: a script or
// an interpreter, not a file read, a search or a download. Shell chains are
// split and the first word of each segment is checked, env assignments and a
// leading cd are skipped.
const RUNS_CODE_RE = /^(node|nodejs|npx|tsx|ts-node|bun|bunx|deno|python|python3|py|uv|poetry|pipx|cargo|go|dotnet|java|npm|pnpm|yarn|make|\.\/[^\s]+|[^\s]+\.(?:m?js|c?js|ts|mts|py|sh))$/;
function runsCode(command) {
  if (typeof command !== "string") return false;
  return command
    .split(/&&|\|\||;|\|/)
    .map((seg) => seg.trim().split(/\s+/).filter((t) => t && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)))
    .filter((toks) => toks.length && toks[0] !== "cd")
    .some((toks) => RUNS_CODE_RE.test(toks[0]) && !(toks[0] === "npm" && toks[1] !== "run" && toks[1] !== "start" && toks[1] !== "test") && !((toks[0] === "pnpm" || toks[0] === "yarn") && ["add", "install", "i", "remove"].includes(toks[1])));
}

// Within executed output, a code counts when it sits in a result context: after
// a result-ish word on the same line, alone on its line, or as a JSON string
// value. A code inside a prose sentence ("the spec says LoanSet returns
// tecNO_PERMISSION when ...") is the developer reading, not the ledger answering.
const RESULT_CONTEXT_WORDS = /(engine_result|TransactionResult|transaction_result|result|error|status|code|rejected|failed|returned|got|reason|ok|submit|submitted|validated)\b[^\n]{0,40}$/i;
function resultCodeInContext(output, compiled) {
  if (typeof output !== "string" || !output) return null;
  const all = matchText(output, compiled).matches;
  const codes = all.filter((x) => x.kind === "result_code").map((x) => x.canonical);
  const txNames = all.filter((x) => x.kind === "tx_type").map((x) => x.canonical);
  // "VaultDeposit tesSUCCESS" or "LoanSet: tecEXPIRED", nothing but separators between the two
  const txBefore = txNames.length ? new RegExp(`(?:${txNames.join("|")})\\s*[:=,-]?\\s*$`, "i") : null;
  for (const code of codes) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${code}(?![A-Za-z0-9_])`, "g");
    let m;
    while ((m = re.exec(output)) !== null) {
      const lineStart = output.lastIndexOf("\n", m.index) + 1;
      const lineEnd = output.indexOf("\n", m.index);
      const line = output.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      const before = output.slice(lineStart, m.index);
      const after = output.slice(m.index + code.length, lineEnd === -1 ? undefined : lineEnd);
      if (/^[\s"'`:=[{(,-]*$/.test(before) && /^[\s"'`,;.)}\]]*$/.test(after)) return code; // alone on the line
      if (/["']\s*:\s*["']$/.test(before) || /^["']/.test(after) && /["']\s*[:=]\s*["']?$/.test(before)) return code; // JSON value
      if (RESULT_CONTEXT_WORDS.test(before)) return code;
      if (txBefore && txBefore.test(before)) return code; // "VaultDeposit tesSUCCESS"
      void line;
    }
  }
  return null;
}

// A script that submits several transactions prints several results. Each
// line holding a code in a result context is one transaction: its type comes
// from the same line when named there, otherwise from the command.
function transactionResults(output, compiled) {
  const out = [];
  for (const line of String(output || "").split("\n")) {
    const code = resultCodeInContext(line, compiled);
    if (!code) continue;
    out.push({ tx_type: matchText(line, compiled).tx_type || null, result_code: code, line: line.trim(), tx_hash: txHashes(line)[0] || null });
  }
  return out;
}

// Validated transaction hashes are public: kept in the payload on purpose so a
// hook row can be checked against the ledger later (the text is still redacted).
const HASH_RE = /(?<![0-9A-Fa-f])[0-9A-F]{64}(?![0-9A-Fa-f])/g;
function txHashes(output) {
  return [...new Set(String(output || "").match(HASH_RE) || [])];
}

// A session_end followed by more events was not the end (a second process, a
// /clear, a resumed session). The session is reopened with a marker and the
// earlier end row is flagged in the local buffer when it is still there.
function markSuperseded(hint, id) {
  const file = dataPaths(hint).buffer;
  if (!id || !fs.existsSync(file)) return;
  let changed = false;
  const out = fs.readFileSync(file, "utf8").split("\n").map((l) => {
    if (!l) return l;
    try {
      const e = JSON.parse(l);
      if (e.id !== id) return l;
      e.payload = { ...(e.payload || {}), superseded: true };
      changed = true;
      return JSON.stringify(e);
    } catch {
      return l;
    }
  });
  if (changed) fs.writeFileSync(file, out.join("\n"));
}
function reopenIfEnded(session, events, base, hint) {
  if (!session || !session.ended_at) return;
  const supersedes = session.end_event_id || null;
  events.push(makeEvent({ ...base, kind: "session_start", payload: { source: "reopen", supersedes } }));
  markSuperseded(hint, supersedes);
  session.ended_at = null;
  session.end_event_id = null;
}

// "git commit ..." whose output shows git's confirmation line "[branch hash] message".
const COMMIT_LINE_RE = /^\[[^\]\n]+?\s+([0-9a-f]{7,40})\]\s*(.*)$/m;
function commitFromOutput(command, output) {
  if (!/\bgit\b[^\n;&|]*\bcommit\b/.test(String(command || ""))) return null;
  const m = String(output || "").match(COMMIT_LINE_RE);
  if (!m) return null;
  return { hash: m[1].slice(0, 12), message: m[2].trim().slice(0, 80) };
}

// Our own configuration and identity files carry keys; a read of them is
// never stored, whatever it matches.
const OWN_FILES_RE = /devex\.config\.json|\.dev\.vars|wrangler\.toml|identity\.json|(^|[\s/\\])\.env(\.[A-Za-z0-9_-]+)?(?=$|[\s"'])/;
function touchesOwnFiles(command, filePath) {
  return OWN_FILES_RE.test(String(command || "")) || OWN_FILES_RE.test(String(filePath || ""));
}

// Prompts injected by the agent runtime (task notifications, system reminders,
// skill invocations) are not the developer speaking.
const INJECTED_PROMPT_RE = /^\s*<[a-z][a-z0-9-]*(\s[^>]*)?>/i;

// Rows written without a session id from the agent get a stable identifier
// derived from the session start, so reports can still group them.
function derivedSessionId(session) {
  const t = String(session && session.session_started_at || "").replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  return "default-" + (t || "unknown");
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

// SDK exceptions without a result code, as printed when thrown: "Name: message"
// in Node, "module.path.Name: message" at the end of a Python traceback. Source
// code that constructs or catches them ("new errors_1.XRPLFaucetError(") has no
// colon after the name and does not count. Counts as a failure for the turn.
const ERROR_CLASS_RE = /\b((?:XRPL|Xrpl|Rippled)\w*(?:Error|Exception)|ValidationError|NotConnectedError|DisconnectedError|ResponseFormatError):\s/;
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
  const base = { identity, config, session_id: sessionId, channel: "hook", agent: runningAgents()[0] ?? null };
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
      reopenIfEnded(session, events, base, hint);
      session.turn += 1;
      session.turn_errors = 0;
      session.turn_result_codes = [];
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      // A turn that invokes one of our skills is ours: not recorded, and the
      // reflection stop hook stays quiet on it.
      session.skill_turn = /^\s*\/xrpl-/i.test(prompt);
      if (prompt && !session.skill_turn && !INJECTED_PROMPT_RE.test(prompt)) {
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
      reopenIfEnded(session, events, base, hint);
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
      // Tool calls made by our own skills (/xrpl-feedback, /xrpl-session-analysis, ...) are not the developer's work.
      if (session.skill_turn) break;

      const hay = toolHaystack(toolName, toolInput, failedEvent ? String(input.error || "") : input.tool_response);
      // A commit made through the agent closes a period of work: remembered so
      // the next Stop can ask for a checkpoint analysis of that period.
      if (toolName === "Bash" && !failedEvent) {
        const commit = commitFromOutput(toolInput.command, hay.output);
        if (commit) session.commit_since_analysis = { ...commit, at: nowIso };
      }
      if (toolName === "Bash" && isOwnCommand(toolInput.command, hay.output)) break;
      if (touchesOwnFiles(toolInput.command, hay.filePath)) break;
      const text = stripOwn(hay.subject) + "\n" + stripOwn(hay.output);
      const rawMatch = matchText(text, compiled());
      if (!rawMatch.strong) break;
      if (toolName === "WebFetch" && !rawMatch.matches.some((x) => x.kind === "domain")) break;

      const docLike = looksLikeDocs(rawMatch, hay.output);
      // A result code is only real when code ran and printed it in a result
      // context: never from the command itself (a script being patched, a grep
      // for "tec"), never from a file read, a search or a download, never from
      // file contents written or read. Transaction types come from executed
      // commands and their output; file tools and searches carry none, since
      // their text is the developer's own material.
      const fileTool = toolName === "Write" || toolName === "Edit" || toolName === "Read";
      const executed = toolName === "Bash" && runsCode(toolInput.command);
      const resultCode = executed && !docLike ? resultCodeInContext(stripOwn(hay.output), compiled()) : null;
      // File tools may keep a transaction type named by the file itself
      // (loanSet.js), never one found in the contents.
      const pathMatch = fileTool && hay.filePath ? matchText(stripOwn(path.basename(String(hay.filePath))), compiled()) : null;
      // Documentation being read carries no transaction, no result and no failure of its own.
      const m = docLike || toolName === "WebSearch" ? { ...rawMatch, tx_type: null, result_code: null, feature: null } : fileTool ? { ...rawMatch, tx_type: pathMatch ? pathMatch.tx_type : null, result_code: null, feature: pathMatch ? pathMatch.feature : null } : { ...rawMatch, result_code: resultCode };

      const interrupted = Boolean(input.tool_response && typeof input.tool_response === "object" && input.tool_response.interrupted);
      const errorClass = executed && !docLike ? detectErrorClass(hay.output) : null;
      const failed = failedEvent || interrupted || isErrorCode(m.result_code) || Boolean(errorClass);

      // Keyword-only matches (an ls that lists xrpl-client.ts, a package.json
      // that depends on xrpl) are activity, not evidence: counted for the
      // checkpoint, never stored. Searches keep their query as a doc signal.
      const hasEvidence = Boolean(m.tx_type || m.result_code || failed || docLike || toolName === "WebFetch" || rawMatch.matches.some((x) => x.kind === "domain") || (toolName === "WebSearch" && (rawMatch.tx_type || rawMatch.result_code)));
      if (!hasEvidence) {
        session.xrpl_events_since_analysis = (session.xrpl_events_since_analysis || 0) + 1;
        break;
      }
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

      // Several transactions in one output: one row each, retry tracking per row.
      const multi = executed && !docLike ? transactionResults(stripOwn(hay.output), compiled()) : [];
      if (multi.length >= 2) {
        let failedRows = 0;
        multi.forEach((r, i) => {
          const tx = r.tx_type || m.tx_type;
          const rowFailed = isErrorCode(r.result_code);
          if (rowFailed) {
            failedRows += 1;
            if (!session.turn_result_codes.includes(r.result_code)) session.turn_result_codes.push(r.result_code);
          }
          const rowPayload = { ...payload, tx_index: i };
          if (r.tx_hash) rowPayload.tx_hashes = [r.tx_hash];
          const row = makeEvent({ ...base, kind: "tool_result", tool_name: toolName, tx_type: tx, result_code: r.result_code, feature: m.feature, failed: rowFailed, text: truncate(r.line, config.output_max_chars), payload: rowPayload, tx_hash: r.tx_hash });
          const track = retryTrack(session, { tx_type: tx, result_code: r.result_code, normalized_command: payload.command, ts: row.ts, failed: rowFailed, event_id: row.id });
          if (track.attempt > 1) {
            row.attempts = track.attempt;
            row.payload.first_attempt_at = track.first_attempt_at;
          }
          events.push(row);
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
        });
        // the single-row accounting above counted at most one error for this call
        session.turn_errors += failedRows - (failed ? 1 : 0);
        break;
      }

      if (executed && !docLike && m.result_code) {
        const hashes = txHashes(hay.output);
        if (hashes.length) payload.tx_hashes = hashes.slice(0, 10);
      }
      const ev = makeEvent({ ...base, kind: "tool_result", tool_name: toolName, tx_type: m.tx_type, result_code: m.result_code, feature: m.feature, failed, text: stored, payload, tx_hash: payload.tx_hashes ? payload.tx_hashes[0] : null });

      if (toolName === "Bash" && !docLike && executed) {
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
      const checkpointHours = Number(config.analysis_checkpoint_hours) || 0;
      if (checkpointHours > 0) {
        // Automatic checkpoint: X hours of XRPL activity since the session
        // start, the last analysis or the last checkpoint prompt, and enough
        // XRPL events to be worth a report. Never during a continuation or a
        // turn that ran one of our skills.
        const periodStart = [session.last_analysis_at, session.checkpoint_prompted_at, session.session_started_at].filter(Boolean).sort().at(-1);
        const hours = ageSeconds(periodStart) / 3600;
        const enough = (session.xrpl_events_since_analysis || 0) >= (Number(config.analysis_checkpoint_min_events) || 1);
        const allowed = input.stop_hook_active !== true && !session.skill_turn;
        // A commit since the last analysis closes the period early, at most one
        // commit checkpoint per analysis_commit_cooldown_minutes; otherwise the
        // period closes on the clock.
        const lastAnalysis = [session.last_analysis_at, session.checkpoint_prompted_at].filter(Boolean).sort().at(-1);
        const cooled = !lastAnalysis || ageSeconds(lastAnalysis) / 60 >= (Number(config.analysis_commit_cooldown_minutes) || 0);
        const commit = session.commit_since_analysis || null;
        const fire = allowed && enough && ((commit && cooled) || hours >= checkpointHours);
        if (fire) {
          session.checkpoint_prompted_at = nowIso;
          session.checkpoint_turn = session.turn;
          session.commit_since_analysis = null;
          stdoutJson = {
            hookSpecificOutput: {
              hookEventName: "Stop",
              additionalContext: buildCheckpointInstruction({ sessionId, periodStart, events: session.xrpl_events_since_analysis, hours: Math.round(hours * 10) / 10, config, commit: commit && cooled ? commit : null }),
            },
          };
        }
      } else {
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
      }
      break;
    }

    case "PreCompact": {
      session = sessionOf(state, sessionId, now);
      reopenIfEnded(session, events, base, hint);
      session.compacted = true;
      events.push(makeEvent({ ...base, kind: "compact", payload: { trigger: String(input.trigger || "auto"), turn: session.turn } }));
      break;
    }

    case "SessionEnd": {
      session = sessionOf(state, sessionId, now);
      const endEvent = makeEvent({ ...base, kind: "session_end", payload: { reason: String(input.reason || "other"), turn: session.turn, pid: process.pid } });
      events.push(endEvent);
      session.ended_at = nowIso;
      session.end_event_id = endEvent.id;
      if (!input.session_id) for (const e of events) e.session_id = derivedSessionId(session);
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

  if (events.length && session && !input.session_id) for (const e of events) e.session_id = derivedSessionId(session);
  if (events.length) appendEvents(events.map(redactEvent), hint);
  if (session && events.length) {
    session.xrpl_events_since_analysis = (session.xrpl_events_since_analysis || 0) + events.filter((e) => ["prompt", "tool_result", "package_install", "retry_resolved"].includes(e.kind)).length;
  }
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
