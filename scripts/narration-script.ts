/**
 * Writes an EPUB's narration script as JSON, for running the narrator by hand.
 *
 *   node --import tsx scripts/narration-script.ts <book.epub> <script.json>
 */

import { readFileSync, writeFileSync } from "node:fs";

import { buildNarrationScript } from "../src/server/ownApi/books/narration/narrationScript";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: narration-script.ts <book.epub> <script.json>");
  process.exit(2);
}

const script = buildNarrationScript(readFileSync(input));
writeFileSync(output, `${JSON.stringify(script, null, 2)}\n`);
const blocks = script.sections.reduce((n, s) => n + s.blocks.length, 0);
const words = script.sections
  .flatMap((s) => s.blocks)
  .reduce((n, b) => n + b.text.split(/\s+/).length, 0);
console.log(
  `${script.sections.length} sections, ${blocks} blocks, ${words} words → ${output}`,
);
