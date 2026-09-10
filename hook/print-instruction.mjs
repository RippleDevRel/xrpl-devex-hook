#!/usr/bin/env node
// Prints the reflection instruction with the resolved submit.mjs path, for
// agents that cannot inject via a hook (paste it into their instructions file).
//   node hook/print-instruction.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstruction } from "./reflection.mjs";
import { fwd } from "./lib/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
process.stdout.write(buildInstruction({ submitPath: fwd(path.resolve(here, "submit.mjs")) }) + "\n");
