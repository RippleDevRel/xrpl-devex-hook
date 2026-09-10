// The allowlist matcher shared by capture.mjs, the reflection stop hook and
// submit.mjs. Loads hook/xrpl-allowlist.json and answers: does this text
// mention XRPL, and if so which canonical transaction type, result code and
// feature does it point at.
//
// Two-tier rule (section 2 of the brief): tx_types, result_codes, domains,
// field_names, strong keywords and packages are strong signals. sdk_symbols and
// weak keywords are weak: they only count when a strong signal is present in
// the same text. Canonical casing always comes from the allowlist.

import fs from "node:fs";
import path from "node:path";
import { HOOK_DIR } from "./paths.mjs";

const IDENT = "[A-Za-z0-9_]";

export function allowlistPath() {
  return process.env.XRPL_DEVEX_ALLOWLIST || path.join(HOOK_DIR, "xrpl-allowlist.json");
}

export function loadAllowlist(file = allowlistPath()) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Builds one alternation regex for a list of tokens plus a lookup from the
// lowercased token to its canonical form. Word boundaries are expressed with
// lookarounds on identifier characters so "loanSet.js" matches but
// "PaymentIntent" does not.
function wordGroup(tokens, { caseInsensitive }) {
  const canon = new Map();
  const parts = [];
  for (const t of tokens || []) {
    if (typeof t !== "string" || !t) continue;
    canon.set(caseInsensitive ? t.toLowerCase() : t, t);
    parts.push(escapeRe(t));
  }
  if (!parts.length) return null;
  parts.sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<!${IDENT})(?:${parts.join("|")})(?!${IDENT})`, caseInsensitive ? "gi" : "g");
  return { re, canon, caseInsensitive };
}

// Phrases (may contain spaces or hyphens) matched case-insensitively with
// boundaries on identifier characters.
function phraseGroup(tokens) {
  return wordGroup(tokens, { caseInsensitive: true });
}

export function compileAllowlist(allowlist) {
  const a = allowlist || {};
  const codes = a.result_codes || {};
  const prefixes = (codes.prefixes || ["tec", "tem", "ter", "tef", "tel", "tes"]).filter((p) => /^[a-z]{3}$/.test(p));
  return {
    txTypes: wordGroup(a.tx_types, { caseInsensitive: true }),
    resultCodes: wordGroup(codes.known, { caseInsensitive: true }),
    // Fallback for codes not yet in the list: prefix + underscore-separated
    // uppercase words, at least 4 chars after the prefix, with at least one
    // underscore or an all-uppercase body so ordinary words do not match.
    resultPrefix: new RegExp(`(?<!${IDENT})(${prefixes.join("|")})([A-Za-z]+_[A-Za-z0-9_]+|[A-Z][A-Z0-9_]{3,})(?!${IDENT})`, "g"),
    prefixes,
    fieldNames: wordGroup(a.field_names, { caseInsensitive: false }),
    strongKeywords: phraseGroup(a.strong_keywords || a.keywords),
    weakKeywords: phraseGroup(a.weak_keywords),
    domains: (a.domains || []).map((d) => String(d).toLowerCase()).sort((x, y) => y.length - x.length),
    packages: (a.packages || []).slice(),
    packageWords: wordGroup((a.packages || []).filter((p) => !p.endsWith("/") && !p.endsWith(":")), { caseInsensitive: true }),
    packagePrefixes: (a.packages || []).filter((p) => p.endsWith("/") || p.endsWith(":")).map((p) => p.toLowerCase()),
    sdkSymbols: wordGroup(Object.values(a.sdk_symbols || {}).flat(), { caseInsensitive: false }),
    txTypeFeatures: Object.entries(a.tx_type_features || {}).sort((x, y) => y[0].length - x[0].length),
    featureKeywords: Object.entries(a.feature_keywords || {}).sort((x, y) => y[0].length - x[0].length),
  };
}

function collect(group, text, kind, out, seen) {
  if (!group) return;
  group.re.lastIndex = 0;
  let m;
  while ((m = group.re.exec(text)) !== null) {
    const key = group.caseInsensitive ? m[0].toLowerCase() : m[0];
    const canonical = group.canon.get(key) || m[0];
    const id = kind + ":" + canonical;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind, canonical });
  }
}

export function normalizeResultCode(token, compiled) {
  if (typeof token !== "string") return null;
  const lower = token.toLowerCase();
  if (compiled.resultCodes && compiled.resultCodes.canon.has(lower)) return compiled.resultCodes.canon.get(lower);
  const prefix = lower.slice(0, 3);
  if (compiled.prefixes.includes(prefix) && token.length > 3) return prefix + token.slice(3).toUpperCase();
  return null;
}

export function inferFeature(result, compiled) {
  if (!result) return null;
  const txs = result.matches.filter((m) => m.kind === "tx_type").map((m) => m.canonical);
  for (const tx of txs) {
    for (const [prefix, feature] of compiled.txTypeFeatures) {
      if (tx === prefix || (tx.startsWith(prefix) && prefix !== "Loan") || (prefix === "Loan" && tx.startsWith("Loan") && !tx.startsWith("LoanBroker"))) return feature;
    }
  }
  const kws = result.matches.filter((m) => m.kind === "keyword").map((m) => m.canonical.toLowerCase());
  for (const kw of kws) {
    for (const [k, feature] of compiled.featureKeywords) if (kw === k) return feature;
  }
  return null;
}

// Returns { matches: [{kind, canonical}], strong, tx_type, result_code, feature }.
export function matchText(text, compiled) {
  const empty = { matches: [], strong: false, tx_type: null, result_code: null, feature: null };
  if (typeof text !== "string" || !text) return empty;
  const strong = [];
  const seen = new Set();

  collect(compiled.txTypes, text, "tx_type", strong, seen);
  collect(compiled.resultCodes, text, "result_code", strong, seen);
  // Prefix fallback for result codes not in the list.
  compiled.resultPrefix.lastIndex = 0;
  let m;
  while ((m = compiled.resultPrefix.exec(text)) !== null) {
    const canonical = normalizeResultCode(m[0], compiled);
    if (!canonical) continue;
    const id = "result_code:" + canonical;
    if (seen.has(id)) continue;
    seen.add(id);
    strong.push({ kind: "result_code", canonical });
  }
  const lower = text.toLowerCase();
  for (const d of compiled.domains) {
    if (lower.includes(d)) {
      const id = "domain:" + d;
      if (seen.has(id)) continue;
      seen.add(id);
      strong.push({ kind: "domain", canonical: d });
    }
  }
  collect(compiled.fieldNames, text, "field", strong, seen);
  collect(compiled.strongKeywords, text, "keyword", strong, seen);
  collect(compiled.packageWords, text, "package", strong, seen);
  for (const p of compiled.packagePrefixes) {
    let idx = lower.indexOf(p);
    while (idx !== -1) {
      const rest = text.slice(idx + p.length).match(/^[A-Za-z0-9._-]+/);
      const canonical = rest ? text.slice(idx, idx + p.length + rest[0].length) : null;
      if (canonical) {
        const id = "package:" + canonical.toLowerCase();
        if (!seen.has(id)) {
          seen.add(id);
          strong.push({ kind: "package", canonical });
        }
      }
      idx = lower.indexOf(p, idx + p.length);
    }
  }

  if (!strong.length) return empty;

  const weak = [];
  collect(compiled.sdkSymbols, text, "sdk_symbol", weak, seen);
  collect(compiled.weakKeywords, text, "keyword", weak, seen);

  const matches = strong.concat(weak);
  const tx = matches.find((x) => x.kind === "tx_type");
  const rc = matches.find((x) => x.kind === "result_code");
  const result = { matches, strong: true, tx_type: tx ? tx.canonical : null, result_code: rc ? rc.canonical : null, feature: null };
  result.feature = inferFeature(result, compiled);
  return result;
}

// For "npm install xrpl@5 express": returns the XRPL package names installed.
// Handles npm install|i, yarn add, pnpm add, pip|pip3 install, and shell
// chains (cd app && npm install xrpl).
export function parseInstallCommand(command, compiled) {
  if (typeof command !== "string") return [];
  const segments = command.split(/&&|\|\||;|\|/);
  const out = [];
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/);
    const i = tokens.findIndex((t, idx) => {
      const prev = tokens[idx - 1];
      return (
        (t === "install" || t === "i" || t === "add") &&
        prev &&
        /^(npm|npx|yarn|pnpm|bun|pip|pip3|python|python3|uv|poetry)$/.test(prev.replace(/^.*\//, ""))
      );
    });
    if (i === -1) continue;
    for (const raw of tokens.slice(i + 1)) {
      if (raw.startsWith("-")) continue;
      // strip version specifiers: xrpl@5, xrpl-py==5.1.0, xrpl-py>=5, "xrpl-py[extra]"
      let name = raw.replace(/^["']|["']$/g, "");
      if (name.startsWith("@")) {
        const at = name.indexOf("@", 1);
        if (at !== -1) name = name.slice(0, at);
      } else {
        name = name.split("@")[0];
      }
      name = name.split(/[=<>!~\[]/)[0];
      if (!name) continue;
      const lower = name.toLowerCase();
      const hit = compiled.packages.find((p) => {
        const pl = p.toLowerCase();
        return pl.endsWith("/") || pl.endsWith(":") ? lower.startsWith(pl) : lower === pl;
      });
      if (hit && !out.includes(name)) out.push(name);
    }
  }
  return out;
}
