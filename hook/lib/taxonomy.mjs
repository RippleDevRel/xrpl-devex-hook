// The v2 taxonomy. Every row that lands in D1 carries these classification
// fields. This file is the single source of truth on the client side; the
// Worker keeps an identical copy (worker/src/index.js must stay dependency free
// and paste-able into the dashboard editor). tests/taxonomy.test.mjs checks the
// two copies agree.

export const SURFACES = ["protocol", "docs", "sdk", "infra", "tooling", "unknown"];

export const FRICTION_TYPES = [
  "retry_loop",
  "doc_gap",
  "wrong_model",
  "expectation",
  "error_message",
  "dead_end",
  "workaround",
  "docs_broken",
  "terminology",
  "timing",
  "praise",
  "raw",
];

export const EVIDENCE = ["observed", "reported", "inferred"];

export const CHANNELS = ["hook", "reflection", "feedback", "analysis"];

export const KINDS = [
  "session_start",
  "prompt",
  "tool_result",
  "package_install",
  "retry_resolved",
  "compact",
  "session_end",
  "reflection",
  "feedback",
  "analysis",
];

export const HOOK_KINDS = ["session_start", "prompt", "tool_result", "package_install", "retry_resolved", "compact", "session_end"];

export const COVERAGE = ["full", "partial", "compacted", "interview_only"];

// Which friction types each channel may write.
export const FRICTION_BY_CHANNEL = {
  hook: FRICTION_TYPES,
  reflection: FRICTION_TYPES.filter((t) => !["praise", "raw", "timing"].includes(t)),
  feedback: FRICTION_TYPES.filter((t) => t !== "raw"),
  analysis: FRICTION_TYPES.filter((t) => !["praise", "raw"].includes(t)),
};

// Which surfaces each channel may write. "unknown" is for automated capture
// and for a truly ambiguous /xrpl-feedback, never for reflection or analysis.
export const SURFACES_BY_CHANNEL = {
  hook: SURFACES,
  reflection: SURFACES.filter((s) => s !== "unknown"),
  feedback: SURFACES,
  analysis: SURFACES.filter((s) => s !== "unknown"),
};

export const KIND_BY_CHANNEL = {
  hook: HOOK_KINDS,
  reflection: ["reflection"],
  feedback: ["feedback"],
  analysis: ["analysis"],
};

export const LIMITS = {
  text_max: 2000,
  text_min_reflection: 50,
  summary_max: 200,
  summary_max_reflection: 140,
  feature_max: 40,
  team_max: 64,
};

export const FEATURE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PARTICIPANT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TEAM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isStr(v) {
  return typeof v === "string" && v.length > 0;
}

// Validates one event object as it travels on the wire. Returns { ok, errors }.
export function validateEvent(ev) {
  const errors = [];
  if (!ev || typeof ev !== "object") return { ok: false, errors: ["event must be an object"] };
  for (const k of ["id", "event", "team", "participant_id", "ts", "channel", "kind", "surface", "friction_type", "evidence"]) {
    if (!isStr(ev[k])) errors.push(`${k} is required`);
  }
  if (errors.length) return { ok: false, errors };
  if (!CHANNELS.includes(ev.channel)) errors.push(`channel must be one of ${CHANNELS.join(", ")}`);
  if (!KINDS.includes(ev.kind)) errors.push(`kind must be one of ${KINDS.join(", ")}`);
  if (!SURFACES.includes(ev.surface)) errors.push(`surface must be one of ${SURFACES.join(", ")}`);
  if (!FRICTION_TYPES.includes(ev.friction_type)) errors.push(`friction_type must be one of ${FRICTION_TYPES.join(", ")}`);
  if (!EVIDENCE.includes(ev.evidence)) errors.push(`evidence must be one of ${EVIDENCE.join(", ")}`);
  if (errors.length) return { ok: false, errors };

  if (!KIND_BY_CHANNEL[ev.channel].includes(ev.kind)) errors.push(`kind ${ev.kind} is not valid for channel ${ev.channel}`);
  if (!FRICTION_BY_CHANNEL[ev.channel].includes(ev.friction_type)) errors.push(`friction_type ${ev.friction_type} is not allowed on channel ${ev.channel}`);
  if (!SURFACES_BY_CHANNEL[ev.channel].includes(ev.surface)) errors.push(`surface ${ev.surface} is not allowed on channel ${ev.channel}`);
  if (!ISO_RE.test(ev.ts)) errors.push("ts must be ISO 8601");
  if (!PARTICIPANT_RE.test(ev.participant_id)) errors.push("participant_id must be a pseudonym like plain-ibex-69");
  if (!TEAM_RE.test(ev.team)) errors.push("team must be a normalized slug");

  if (ev.feature !== undefined && ev.feature !== null) {
    if (!isStr(ev.feature) || ev.feature.length > LIMITS.feature_max || !FEATURE_RE.test(ev.feature)) {
      errors.push("feature must be a short lowercase hyphenated tag");
    }
  }
  for (const k of ["tx_type", "result_code", "tool_name", "session_id", "summary", "text"]) {
    if (ev[k] !== undefined && ev[k] !== null && typeof ev[k] !== "string") errors.push(`${k} must be a string or null`);
  }
  for (const k of ["attempts", "elapsed_seconds"]) {
    if (ev[k] !== undefined && ev[k] !== null && !(Number.isInteger(ev[k]) && ev[k] >= 0)) errors.push(`${k} must be a non-negative integer or null`);
  }
  if (ev.failed !== undefined && ev.failed !== null && ![0, 1, true, false].includes(ev.failed)) errors.push("failed must be 0, 1 or a boolean");

  if (typeof ev.text === "string") {
    if (ev.text.length > LIMITS.text_max) errors.push(`text must be at most ${LIMITS.text_max} characters`);
    if (ev.channel === "reflection" && ev.text.length < LIMITS.text_min_reflection) {
      errors.push(`text must be at least ${LIMITS.text_min_reflection} characters for a reflection`);
    }
  } else if (ev.channel === "reflection" || ev.channel === "feedback") {
    errors.push("text is required for reflection and feedback");
  }
  if (typeof ev.summary === "string") {
    const max = ev.channel === "reflection" ? LIMITS.summary_max_reflection : LIMITS.summary_max;
    if (ev.summary.length > max) errors.push(`summary must be at most ${max} characters`);
    if (/\r|\n/.test(ev.summary)) errors.push("summary must be one line");
  }
  if (ev.payload !== undefined && ev.payload !== null && typeof ev.payload !== "object" && typeof ev.payload !== "string") {
    errors.push("payload must be an object, a JSON string or null");
  }
  return { ok: errors.length === 0, errors };
}

// Validates the JSON block produced by /xrpl-session-analysis (section 5.4).
export function validateAnalysis(a) {
  const errors = [];
  if (!a || typeof a !== "object") return { ok: false, errors: ["analysis must be an object"] };
  for (const k of ["participant", "team", "event", "coverage"]) if (!isStr(a[k])) errors.push(`${k} is required`);
  if (isStr(a.coverage) && !COVERAGE.includes(a.coverage)) errors.push(`coverage must be one of ${COVERAGE.join(", ")}`);
  if (!Array.isArray(a.features_touched)) errors.push("features_touched must be an array");
  if (!Array.isArray(a.friction)) errors.push("friction must be an array");
  else {
    a.friction.forEach((f, i) => {
      const at = `friction[${i}]`;
      if (!f || typeof f !== "object") return errors.push(`${at} must be an object`);
      if (!FRICTION_BY_CHANNEL.analysis.includes(f.friction_type)) errors.push(`${at}.friction_type invalid`);
      if (!SURFACES_BY_CHANNEL.analysis.includes(f.surface)) errors.push(`${at}.surface invalid`);
      if (!EVIDENCE.includes(f.evidence)) errors.push(`${at}.evidence invalid`);
      if (!isStr(f.summary)) errors.push(`${at}.summary is required`);
      if (f.feature !== undefined && f.feature !== null && f.feature !== "" && !FEATURE_RE.test(f.feature)) errors.push(`${at}.feature invalid`);
      for (const k of ["attempts", "minutes_lost", "rank"]) {
        if (f[k] !== undefined && f[k] !== null && !(Number.isInteger(f[k]) && f[k] >= 0)) errors.push(`${at}.${k} must be a non-negative integer`);
      }
    });
  }
  for (const k of ["doc_questions", "error_codes", "abandoned", "workarounds", "not_observed", "redacted"]) {
    if (a[k] !== undefined && !Array.isArray(a[k])) errors.push(`${k} must be an array`);
  }
  for (const k of ["time_to_first_success_minutes", "time_to_first_success_source"]) {
    if (a[k] !== undefined && (typeof a[k] !== "object" || a[k] === null || Array.isArray(a[k]))) errors.push(`${k} must be an object`);
  }
  if (a.single_fix !== undefined && typeof a.single_fix !== "string") errors.push("single_fix must be a string");
  return { ok: errors.length === 0, errors };
}
