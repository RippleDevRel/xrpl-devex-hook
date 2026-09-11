// Loads hook/devex.config.json with defaults and environment overrides.
//
// Precedence: environment variable, then config file, then built-in default.
//   XRPL_DEVEX_CONFIG       path to an alternative config file
//   XRPL_DEVEX_ENDPOINT     overrides "endpoint"
//   XRPL_DEVEX_INGEST_KEY   overrides "ingest_key"
//   XRPL_DEVEX_EVENT        overrides "event"
//   XRPL_DEVEX_REFLECTION_SAMPLE overrides "reflection_sample"

import fs from "node:fs";
import path from "node:path";
import { HOOK_DIR } from "./paths.mjs";

export const DEFAULTS = {
  event: "REPLACE-ME",
  focus_features: [],
  endpoint: "https://REPLACE-ME.workers.dev",
  ingest_key: "REPLACE-ME",
  retention_days: 90,
  flush_max_batch: 10,
  flush_max_age_seconds: 60,
  flush_timeout_seconds: 3,
  reflection_sample: 0.1,
  reflection_cooldown_turns: 3,
  reflection_max_per_session: 8,
  nudge_after_turns: 40,
  nudge_after_minutes: 180,
  // Automatic checkpoint analyses: every N hours of session with XRPL activity,
  // the Stop hook asks the agent to run the session analysis on the period and
  // submit it without review. 0 disables and leaves the manual reminder only.
  analysis_checkpoint_hours: 2,
  analysis_checkpoint_min_events: 5,
  prompt_max_chars: 2000,
  output_max_chars: 1500,
  // Which prompts keep their text: "signal" (a transaction type, a result code
  // or wording that describes a question or a problem), "always", or "never"
  // (the prompt row is still counted, without text).
  prompt_text: "signal",
};

const NUMERIC = [
  "retention_days",
  "flush_max_batch",
  "flush_max_age_seconds",
  "flush_timeout_seconds",
  "reflection_sample",
  "reflection_cooldown_turns",
  "reflection_max_per_session",
  "nudge_after_turns",
  "nudge_after_minutes",
  "analysis_checkpoint_hours",
  "analysis_checkpoint_min_events",
  "prompt_max_chars",
  "output_max_chars",
];

export function configPath() {
  return process.env.XRPL_DEVEX_CONFIG || path.join(HOOK_DIR, "devex.config.json");
}

export function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    // missing or broken config: run on defaults, the caller decides what that means
  }
  const cfg = { ...DEFAULTS, ...(file && typeof file === "object" ? file : {}) };
  if (process.env.XRPL_DEVEX_ENDPOINT) cfg.endpoint = process.env.XRPL_DEVEX_ENDPOINT;
  if (process.env.XRPL_DEVEX_INGEST_KEY) cfg.ingest_key = process.env.XRPL_DEVEX_INGEST_KEY;
  if (process.env.XRPL_DEVEX_EVENT) cfg.event = process.env.XRPL_DEVEX_EVENT;
  if (process.env.XRPL_DEVEX_REFLECTION_SAMPLE !== undefined && process.env.XRPL_DEVEX_REFLECTION_SAMPLE !== "") {
    cfg.reflection_sample = process.env.XRPL_DEVEX_REFLECTION_SAMPLE;
  }
  for (const k of NUMERIC) {
    const n = Number(cfg[k]);
    cfg[k] = Number.isFinite(n) ? n : DEFAULTS[k];
  }
  if (!Array.isArray(cfg.focus_features)) cfg.focus_features = [];
  if (!["signal", "always", "never"].includes(cfg.prompt_text)) cfg.prompt_text = "signal";
  cfg.endpoint = String(cfg.endpoint || "").replace(/\/+$/, "");
  return cfg;
}

// True when the organizer has filled in the endpoint and key.
export function isConfigured(cfg) {
  return Boolean(cfg.endpoint) && !/REPLACE-ME/i.test(cfg.endpoint) && Boolean(cfg.ingest_key) && !/REPLACE-ME/i.test(cfg.ingest_key);
}
