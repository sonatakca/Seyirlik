/**
 * How well a subtitle's lines are matched, by meaning, to what was spoken.
 *
 * For each episode: the subtitle packaged with it (timed to this edition, so
 * every cue's true moment is known) against a transcript of its audio. An
 * anchor is right when the transcript segment it names overlaps the cue's true
 * time. Measured per embedding model, on the subtitle as it is and with its
 * second half eight seconds late — matching must not depend on the cue already
 * being in the right place, or it is no use for finding where it should be.
 *
 * Usage:
 *   npx tsx scripts/benchmark-subtitle-semantics.ts <dataset> <model-cache> [--models a,b] [--episodes a,b] [--json out]
 *
 * `<dataset>/<episode>/` holds `turkish.vtt` and `whisper-small.json`
 * (whisper.cpp `--output-json-full`). See `benchmark-subtitle-sync.ts`.
 */
import { readdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  createTransformersEmbedder,
  SUBTITLE_EMBEDDING_MODELS,
  type SubtitleEmbeddingModelName,
} from "../src/server/ownApi/subtitles/subtitleEmbedder";
import {
  documentCues,
  parseSubtitleDocument,
} from "../src/server/ownApi/subtitles/subtitleCues";
import {
  semanticAnchors,
  speechText,
} from "../src/server/ownApi/subtitles/subtitleSemantics";
import {
  isReliableSpeech,
  parseWhisperTranscript,
} from "../src/server/ownApi/subtitles/subtitleTranscript";

const args = process.argv.slice(2);
const [dataset, cache] = args;
if (!dataset || !cache)
  throw new Error(
    "usage: benchmark-subtitle-semantics.ts <dataset> <model-cache> [--models a,b] [--episodes a,b] [--json out]",
  );
const option = (name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const models = (option("--models")?.split(",") ?? [
  "multilingual-e5-small",
]) as SubtitleEmbeddingModelName[];
const only = option("--episodes")?.split(",");
const jsonOut = option("--json");

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const results: Record<string, unknown>[] = [];
for (const name of models) {
  const embedder = createTransformersEmbedder({
    model: SUBTITLE_EMBEDDING_MODELS[name],
    cacheDir: cache,
    threads: 8,
  });
  const episodes = (await readdir(dataset, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((episode) => !only || only.includes(episode))
    .sort();
  for (const episode of episodes) {
    const directory = path.join(dataset, episode);
    if (
      !(await exists(path.join(directory, "turkish.vtt"))) ||
      !(await exists(path.join(directory, "whisper-small.json")))
    )
      continue;
    const truth = documentCues(
      parseSubtitleDocument(
        await readFile(path.join(directory, "turkish.vtt"), "utf8"),
      ),
    ).map((cue, index) => ({
      index,
      text: cue.text.join("\n"),
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
    }));
    const transcript = parseWhisperTranscript(
      await readFile(path.join(directory, "whisper-small.json"), "utf8"),
      { name: "whisper.cpp", model: "ggml-small", options: {} },
    );
    const segments = transcript.segments.filter(isReliableSpeech);
    const half = (truth.at(-1)?.startSeconds ?? 0) / 2;
    const counts = new Map<string, number>();
    for (const cue of truth) {
      const key = speechText(cue.text).toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated = (index: number) =>
      (counts.get(speechText(truth[index]!.text).toLowerCase()) ?? 0) >= 3;

    for (const damage of ["as-is", "second-half-late"] as const) {
      const cues = truth.map((cue) => ({
        index: cue.index,
        text: cue.text,
        startSeconds:
          damage === "as-is" || cue.startSeconds < half
            ? cue.startSeconds
            : cue.startSeconds + 8,
      }));
      const started = performance.now();
      const anchors = await semanticAnchors({ cues, segments, embedder });
      const ms = performance.now() - started;
      const right = (anchor: (typeof anchors)[number]) => {
        const cue = truth[anchor.cueIndex]!;
        const segment = segments.find(
          (candidate) => candidate.startSeconds === anchor.mediaSeconds,
        )!;
        return (
          segment.startSeconds <= cue.endSeconds + 1 &&
          segment.endSeconds >= cue.startSeconds - 1
        );
      };
      const strong = anchors.filter((anchor) => anchor.weight >= 1);
      const repeats = anchors.filter((anchor) => repeated(anchor.cueIndex));
      const row = {
        model: name,
        episode,
        damage,
        cues: truth.length,
        segments: segments.length,
        anchors: anchors.length,
        precision: anchors.filter(right).length / Math.max(1, anchors.length),
        strong: strong.length,
        strongPrecision:
          strong.filter(right).length / Math.max(1, strong.length),
        repeated: repeats.length,
        repeatedPrecision:
          repeats.filter(right).length / Math.max(1, repeats.length),
        ms: Math.round(ms),
      };
      results.push(row);
      console.log(
        [
          name.padEnd(31),
          episode.padEnd(18),
          damage.padEnd(17),
          `anchors ${String(row.anchors).padStart(4)}/${row.cues}`,
          `precision ${row.precision.toFixed(3)}`,
          `strong ${String(row.strong).padStart(4)} @ ${row.strongPrecision.toFixed(3)}`,
          `repeated ${String(row.repeated).padStart(3)} @ ${row.repeatedPrecision.toFixed(2)}`,
          `${row.ms} ms`,
        ].join("  "),
      );
    }
  }
  await embedder.dispose();
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify(results, null, 2));
