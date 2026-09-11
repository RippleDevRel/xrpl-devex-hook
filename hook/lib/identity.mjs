// Participant identity: a locally generated pseudonym plus the team name.
// Stored in .xrpl-devex/identity.json:
//   { participant_id, team, team_display, consented_at, client_version }
// or, when the participant declined:
//   { declined: true, declined_at }
// No real name, no email, ever.

import fs from "node:fs";
import crypto from "node:crypto";
import { dataPaths, ensureDataDir } from "./paths.mjs";
import { CLIENT_VERSION } from "../version.mjs";

const ADJECTIVES = [
  "plain", "quiet", "brisk", "calm", "bold", "keen", "mild", "swift", "tidy", "vivid",
  "amber", "azure", "coral", "ivory", "jade", "olive", "pearl", "ruby", "sage", "teal",
  "early", "late", "lucky", "merry", "noble", "proud", "rapid", "sunny", "witty", "zesty",
  "brave", "clear", "crisp", "eager", "fresh", "gentle", "humble", "lively", "mellow", "nimble",
  "polite", "rustic", "silent", "sturdy", "subtle", "tender", "upbeat", "urban", "warm", "young",
];

const ANIMALS = [
  "ibex", "otter", "heron", "lynx", "finch", "gecko", "koala", "lemur", "marmot", "newt",
  "osprey", "panda", "quail", "raven", "seal", "tapir", "urchin", "vole", "walrus", "yak",
  "zebra", "badger", "bison", "crane", "dingo", "egret", "falcon", "gannet", "hare", "iguana",
  "jackal", "kestrel", "llama", "moose", "narwhal", "ocelot", "puffin", "robin", "stoat", "toucan",
  "wombat", "auk", "beaver", "civet", "dove", "ermine", "ferret", "gopher", "hoopoe", "impala",
];

export function generatePseudonym(rand = crypto.randomInt) {
  const adj = ADJECTIVES[rand(0, ADJECTIVES.length)];
  const animal = ANIMALS[rand(0, ANIMALS.length)];
  const n = rand(10, 100);
  return `${adj}-${animal}-${n}`;
}

// "Team Zetlar  Labs" -> "team-zetlar-labs"
export function normalizeTeam(display) {
  return String(display || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);
}

export function loadIdentity(hint) {
  try {
    const raw = fs.readFileSync(dataPaths(hint).identity, "utf8");
    const id = JSON.parse(raw);
    return id && typeof id === "object" ? id : null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity, hint) {
  const p = ensureDataDir(hint);
  fs.writeFileSync(p.identity, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
  return p.identity;
}

export function createIdentity({ teamDisplay, pseudonym }) {
  const team = normalizeTeam(teamDisplay);
  if (!team) throw new Error("team name is required");
  return {
    participant_id: pseudonym || generatePseudonym(),
    team,
    team_display: String(teamDisplay).trim(),
    consented_at: new Date().toISOString(),
    client_version: CLIENT_VERSION,
  };
}

export function declinedIdentity() {
  return { declined: true, declined_at: new Date().toISOString() };
}

// True when capture may run: consent given and not declined.
export function isActive(identity) {
  return Boolean(identity && !identity.declined && identity.participant_id && identity.team);
}

// Headers for every write to the Worker: the ingest key, plus the event invite
// code when the participant stored one at setup (INVITE_ONLY events).
export function writeHeaders(identity, config) {
  const h = { "x-ingest-key": config.ingest_key };
  if (identity && typeof identity.invite_code === "string" && identity.invite_code) h["x-invite-code"] = identity.invite_code;
  return h;
}

// A 403 that a new invite code would fix. Events must stay buffered, not be
// parked as rejected.
export function isInviteReject(res) {
  return Boolean(res && res.status === 403 && res.body && ["invite_required", "invite_invalid"].includes(res.body.error));
}

// The participant object sent with every ingest call.
export function participantPayload(identity, config) {
  return {
    participant_id: identity.participant_id,
    event: config.event,
    team: identity.team,
    team_display: identity.team_display || identity.team,
    consented_at: identity.consented_at,
    client_version: CLIENT_VERSION,
  };
}
