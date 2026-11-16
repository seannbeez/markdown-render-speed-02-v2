// Driver: renders every case in /input/cases.json with parse() and writes
// the HTML strings, in order, to /output/html.json. The harness runs
// `node /bot/main.ts`; MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in
// for /input and /output outside a container.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
const cases = JSON.parse(readFileSync(join(inDir, "cases.json"), "utf8"));
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
writeFileSync(join(outDir, "html.json"), JSON.stringify(html));
