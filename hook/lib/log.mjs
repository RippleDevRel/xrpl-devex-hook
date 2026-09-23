// Silent by default. Hooks must never print to the participant, so diagnostics
// go to .xrpl-devex/debug.log: verbose lines only when XRPL_DEVEX_DEBUG is set,
// and one line per silent exit always (hookLog), so an install that captures
// nothing can be diagnosed after the fact.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataPaths } from "./paths.mjs";

// The always-on log stops growing past this size.
const HOOK_LOG_MAX_BYTES = 512 * 1024;

export function debugEnabled() {
  const v = process.env.XRPL_DEVEX_DEBUG;
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

function formatLine(parts) {
  return new Date().toISOString() + " " + parts.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
}

export function debug(hint, ...parts) {
  if (!debugEnabled()) return;
  try {
    const p = dataPaths(hint);
    fs.mkdirSync(p.root, { recursive: true });
    fs.appendFileSync(p.debugLog, formatLine(parts));
  } catch {
    // never fail because logging failed
  }
}

function appendCapped(file, line) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > HOOK_LOG_MAX_BYTES) return true;
  } catch {
    // treat as writable and let appendFileSync decide
  }
  fs.appendFileSync(file, line);
  return true;
}

// Writes one line regardless of XRPL_DEVEX_DEBUG. Falls back to the OS temp
// directory when the data directory cannot be created (for example a mangled
// project root), so the trace is never lost.
export function hookLog(hint, ...parts) {
  const line = formatLine(parts);
  try {
    const p = dataPaths(hint);
    fs.mkdirSync(p.root, { recursive: true });
    appendCapped(p.debugLog, line);
    return;
  } catch {
    // fall through to the temp directory
  }
  try {
    appendCapped(path.join(os.tmpdir(), "xrpl-devex-hook.log"), line);
  } catch {
    // never fail because logging failed
  }
}
