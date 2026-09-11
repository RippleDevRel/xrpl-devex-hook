// The reflection instruction injected into the agent's own model by the Stop
// hooks (JSON additionalContext on Claude Code, exit 2 + stderr on Codex and
// Grok, followup_message on Cursor, JSON decision block on Copilot).
// No external LLM is called: the model judges the turn and, if warranted, runs
// submit.mjs with a JSON object in our taxonomy. Ported from the SingHacks
// repo, payload changed from a free paragraph to structured JSON.

import { loadConfig, isConfigured } from "./lib/config.mjs";

export const SURFACE_TABLE = [
  "surface (where the friction sits):",
  "  protocol  ledger behaviour, transaction semantics, amendments (tec codes, flag semantics, vault share maths, rippling)",
  "  docs      xrpl.org, XLS specs, tutorials, reference pages (missing field description, wrong snippet, outdated tutorial)",
  "  sdk       client libraries (xrpl.js, xrpl-py, xrpl4j, xrpl-rust, wallet SDKs)",
  "  infra     networks and services (testnet or devnet availability, faucet, explorers, rippled or clio RPC, WebSocket disconnects)",
  "  tooling   the local environment for this event (starter repo, XRPL AI Starter Kit, MPP SDK, this capture system, Claude Code, env setup)",
].join("\n");

export const FRICTION_TABLE = [
  "friction_type (what kind of friction):",
  "  retry_loop     same operation attempted 2+ times before success",
  "  doc_gap        a question the docs should have answered",
  "  wrong_model    the developer believed something false about how the protocol works",
  "  expectation    expected X, got Y, including cases where Y was correct",
  "  error_message  a result code or error that did not point at the actual cause",
  "  dead_end       something attempted then abandoned",
  "  workaround     hand-rolled code for something the SDK or protocol should provide",
  "  docs_broken    a copied snippet or tutorial step that failed as written",
  "  terminology    inconsistent or incorrect use of terms (assets vs shares, redeem vs withdraw, vault owner vs loan broker)",
].join("\n");

export function buildInstruction({ submitPath, sessionId = null, signal = null, config = loadConfig() } = {}) {
  const focus = Array.isArray(config.focus_features) && config.focus_features.length ? config.focus_features.join(", ") : "any XRPL feature";
  const sessionArg = sessionId ? ` --session ${JSON.stringify(sessionId)}` : "";
  const why =
    signal === "error"
      ? "An XRPL tool failure or result code was captured during this turn."
      : signal === "match"
        ? "Your last message mentions XRPL transaction types, result codes or docs."
        : "This is a periodic check.";
  const lines = [
    "XRPL developer experience check (do this silently, then finish).",
    "",
    why + " Look back at this turn only and decide whether it revealed one genuine, specific piece of XRPL developer friction:",
    "a docs gap or wrong example, an SDK footgun, a misleading result code, a wrong mental model about the protocol,",
    "an abandoned approach, a workaround for something the SDK or protocol should provide, faucet or network trouble.",
    `Event focus features: ${focus}. Any XRPL feature counts.`,
    "",
    "Rules: at most one item per turn. Only something observed in this turn. No praise (praise goes through /xrpl-feedback).",
    "Write summary and text in English, whatever language the developer used; translate quotes when needed.",
    "Nothing unrelated to XRPL. No invention. Do not resubmit an item already sent this session.",
    "Never invent a tx_type or result_code that did not appear in this turn; use null when unsure.",
    "",
    SURFACE_TABLE,
    "",
    FRICTION_TABLE,
    "",
    "If and only if there is real friction, run exactly one command with this JSON (text is one specific paragraph, 50 to 2000 chars, what happened and what would have helped; summary is one line under 140 chars; feature is a short lowercase tag such as xls-65, xls-66, mpt, amm, rlusd, mpp, x402, or null):",
    "",
    `    node ${JSON.stringify(submitPath)} --channel reflection${sessionArg} --json '{"surface":"protocol|docs|sdk|infra|tooling","friction_type":"doc_gap|wrong_model|expectation|error_message|dead_end|workaround|docs_broken|terminology|retry_loop","feature":"xls-66","tx_type":null,"result_code":null,"summary":"one line, under 140 chars","text":"one specific paragraph, 50 to 2000 chars"}'`,
    "",
    "If the JSON contains single quotes, pipe it instead:  printf '%s' '<json>' | node " + JSON.stringify(submitPath) + " --channel reflection" + sessionArg + " --json -",
  ];
  if (isConfigured(config)) {
    lines.push(
      "",
      `If node is not available, POST the same fields to ${config.endpoint}/ingest as JSON {"participant":{...},"events":[{...}]} with headers X-Ingest-Key (ingest_key from hook/devex.config.json) and, when the event is invite only, X-Invite-Code (invite_code from .xrpl-devex/identity.json). Take participant_id, team and consented_at from identity.json, set id to a fresh UUID, ts to the current ISO time, channel and kind to "reflection", evidence to "inferred".`,
    );
  }
  lines.push("", "If nothing qualifies, do nothing at all. Either way, write at most one short line to the user about this.");
  return lines.join("\n");
}
