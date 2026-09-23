#!/usr/bin/env node
// Pre-commit guard built on the capture redactor (backlog B4, T22). Exits 1
// when hook/lib/redact.mjs would redact anything in the files about to be
// committed, printing file and line but never the matched value.
//
//   node scripts/precommit-secrets.mjs                 check the files staged in the current git repo
//   node scripts/precommit-secrets.mjs <file> [...]    check these paths instead
//   bash skills/install.sh --git-hook                  install as .git/hooks/pre-commit
//
// Skipped: binary files, missing paths, and devex.config.json (its ingest key
// ships in the participant repo by design; the Worker treats it as public).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { redact } from "../hook/lib/redact.mjs";

const SKIP_NAMES = ["devex.config.json"];
const MAX_BYTES = 5 * 1024 * 1024;

// Staged paths (added, copied, modified) relative to the repo root.
function stagedFiles() {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], { encoding: "utf8" });
    return out.split("\0").filter(Boolean).map((f) => path.join(root, f));
  } catch (err) {
    process.stderr.write("precommit-secrets: not a git repository and no paths given (" + String(err.message || err).split("\n")[0] + ")\n");
    process.exit(2);
  }
}

// Returns [{ line, types }] for every line the redactor would change.
function scanText(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const r = redact(line);
    if (r.redacted.length) hits.push({ line: i + 1, types: r.redacted });
  });
  return hits;
}

function readable(file) {
  if (SKIP_NAMES.includes(path.basename(file))) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString("utf8");
}

const args = process.argv.slice(2);
const files = args.length ? args.map((f) => path.resolve(f)) : stagedFiles();
let failed = 0;
for (const file of files) {
  const text = readable(file);
  if (text === null) continue;
  for (const hit of scanText(text)) {
    failed += 1;
    process.stdout.write(`${path.relative(process.cwd(), file)}:${hit.line}: looks like a secret (${hit.types.join(", ")})\n`);
  }
}
if (failed) {
  process.stdout.write(`precommit-secrets: ${failed} line(s) would be redacted by hook/lib/redact.mjs. Remove the value or move it to an ignored .env file, then commit again.\n`);
  process.exit(1);
}
