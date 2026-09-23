#!/usr/bin/env node
// Cursor wrapper around capture.mjs for Windows. Cursor runs hook commands
// through a PowerShell pipeline that drops stdin for .cmd wrappers, so the
// hook saw an empty payload and buffered nothing. Started directly by Cursor,
// this Node process inherits stdin, stdout and stderr and hands them to
// capture.mjs unchanged. Same arguments, always exit 0.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
spawnSync(process.execPath, [path.resolve(here, "../../capture.mjs"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(0);
