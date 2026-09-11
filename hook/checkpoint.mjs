// The checkpoint instruction injected by the Stop hook every
// analysis_checkpoint_hours of XRPL activity: the agent runs the session
// analysis procedure on the period and submits it without asking. Factual
// wording, no imperative framing beyond the task itself.

import path from "node:path";
import { REPO_DIR, HOOK_DIR, fwd } from "./lib/paths.mjs";

export function buildCheckpointInstruction({ sessionId, periodStart, events, hours, config }) {
  const skill = fwd(path.join(REPO_DIR, "skills", "xrpl-session-analysis", "SKILL.md"));
  const submit = fwd(path.join(HOOK_DIR, "submit.mjs"));
  const focus = Array.isArray(config.focus_features) && config.focus_features.length ? config.focus_features.join(", ") : "any XRPL feature";
  return [
    `XRPL DevEx checkpoint. This session has ${events} XRPL events over the last ${hours} hour(s) (since ${periodStart}) and no analysis for that period. The organizer of this event asked for an automatic session analysis every ${config.analysis_checkpoint_hours} hour(s).`,
    "",
    `Run the session analysis procedure now, in checkpoint mode. The procedure, the surface and friction_type values, the fixed report structure and the JSON shape are in ${skill}; read that file first. Event focus features: ${focus}.`,
    "",
    "Checkpoint mode differs from a manual run in four ways:",
    `- cover only the period since ${periodStart}; use the transcript in context and the hook evidence in .xrpl-devex/buffer.jsonl and .xrpl-devex/sent.jsonl for this session`,
    "- do not ask the developer anything: state coverage honestly and list open questions under Not observed",
    `- add "trigger": "checkpoint" and "period_start": "${periodStart}" to the JSON block`,
    `- submit without asking: node ${JSON.stringify(submit)} --analysis <json path> --markdown <md path> --session ${JSON.stringify(sessionId)} --checkpoint`,
    "",
    "Write both files to .xrpl-devex/reports/session-analysis-<YYYYMMDD-HHMMSS>.md and .json. Redact seeds, keys, tokens and private URLs as the procedure says. Everything in English.",
    "If the period holds no XRPL work worth reporting, submit nothing.",
    "Then tell the developer in one line where the report is (or that nothing was worth reporting) and go back to what they asked. The developer can run /xrpl-session-analysis at any time for a reviewed analysis.",
  ].join("\n");
}
