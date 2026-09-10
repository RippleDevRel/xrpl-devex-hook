// Random fallback gate for the reflection stop hooks. Ported from the SingHacks
// repo; in v2 it is only the fallback for turns with no XRPL signal (Claude
// Code) or the whole gate for agents whose Stop input carries no signal.
//
// Rate comes from "reflection_sample" in hook/devex.config.json (0 to 1), or
// the XRPL_DEVEX_REFLECTION_SAMPLE environment variable. 1 = every turn, 0 = never.

import { loadConfig } from "./lib/config.mjs";

export function sampleRate(config = loadConfig()) {
  const rate = Number(config.reflection_sample);
  return Number.isFinite(rate) ? rate : 0.1;
}

export function passesSampling(config) {
  const rate = sampleRate(config);
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}
