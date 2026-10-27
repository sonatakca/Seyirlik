/**
 * Reads a release-note.json from stdin and says whether it can ship.
 *
 * `deploy/ship.sh` pipes the shipped commit's copy through this, so the rule
 * is the one the site applies when it shows the note (`buildInfo.ts`).
 */
import { releaseNoteProblem } from "../src/lib/appVersion/buildInfo";

async function main(): Promise<void> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  if (!text.trim()) {
    throw new Error('there is none; add {"en": "...", "tr": "..."}');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("it is not valid JSON");
  }
  const problem = releaseNoteProblem(value);
  if (problem) throw new Error(problem);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
