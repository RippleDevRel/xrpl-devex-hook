// Silent by default. Hooks must never print to the participant, so diagnostics
// go to .xrpl-devex/debug.log and only when XRPL_DEVEX_DEBUG is set.

import fs from "node:fs";
import { dataPaths } from "./paths.mjs";

export function debugEnabled() {
  const v = process.env.XRPL_DEVEX_DEBUG;
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

export function debug(hint, ...parts) {
  if (!debugEnabled()) return;
  try {
    const p = dataPaths(hint);
    fs.mkdirSync(p.root, { recursive: true });
    const line = new Date().toISOString() + " " + parts.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
    fs.appendFileSync(p.debugLog, line);
  } catch {
    // never fail because logging failed
  }
}
