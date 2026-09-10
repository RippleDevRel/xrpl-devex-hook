// Light regex redaction applied by capture.mjs before buffering and by
// submit.mjs before sending. It is a safety net, not a guarantee: the analysis
// skill does a fuller redaction pass on its own output.
//
// Redacted, replaced by [redacted:<type>]:
//   seed    XRPL family seeds: "s" followed by 28 to 30 base58 characters, and
//           any "sEd" prefixed base58 string (Ed25519 seeds)
//   hex64   64 hex character strings (raw private keys; note that transaction
//           hashes have the same shape and are redacted too in hook captures)
//   bearer  "Bearer <token>" authorization values
//   env     KEY=, TOKEN=, SECRET= style assignments (value only)
//
// Kept on purpose: ledger addresses (r... 25 to 35 base58 chars) and
// transaction hashes shorter or longer than exactly 64 hex characters.

const BASE58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

// Order matters: env assignments first so a seed used as a value is reported
// once as env, then bearer, then seeds, then bare hex.
const RULES = [
  {
    type: "env",
    re: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|SEED|PRIVATE)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
    replace: (_m, name, sep) => `${name}${sep}[redacted:env]`,
  },
  {
    type: "bearer",
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: () => "Bearer [redacted:bearer]",
  },
  {
    type: "seed",
    re: new RegExp(`(?<![${BASE58}])sEd[${BASE58}]{20,40}(?![${BASE58}])`, "g"),
    replace: () => "[redacted:seed]",
  },
  {
    type: "seed",
    re: new RegExp(`(?<![${BASE58}])s[${BASE58}]{28,30}(?![${BASE58}])`, "g"),
    replace: () => "[redacted:seed]",
  },
  {
    type: "hex64",
    re: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/g,
    replace: () => "[redacted:hex64]",
  },
];

// Returns { text, redacted } where redacted lists the types that fired.
export function redact(input) {
  if (typeof input !== "string" || input.length === 0) return { text: input, redacted: [] };
  let text = input;
  const found = new Set();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (!rule.re.test(text)) continue;
    rule.re.lastIndex = 0;
    found.add(rule.type);
    text = text.replace(rule.re, rule.replace);
  }
  return { text, redacted: [...found] };
}

export function redactString(input) {
  return redact(input).text;
}

// Redacts every string value in a plain object or array, recursively.
export function redactDeep(value, found = new Set()) {
  if (typeof value === "string") {
    const r = redact(value);
    r.redacted.forEach((t) => found.add(t));
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, found));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, found);
    return out;
  }
  return value;
}
