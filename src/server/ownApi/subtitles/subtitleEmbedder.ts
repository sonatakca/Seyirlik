/**
 * Multilingual sentence embeddings for matching a cue to what was spoken.
 *
 * The same runtime the reader's meaning search already ships (transformers.js
 * over ONNX Runtime, CPU), with its own model: subtitle lines are short and
 * there are a thousand of them per episode, so speed per line matters more
 * than it does for a novel's passages. Which model is the default is decided
 * by measurement (`scripts/benchmark-subtitle-semantics.ts`), and each is named
 * in the analysis record so a change of model never reuses another's anchors.
 *
 * Models are fetched once into a directory the deployment names and never from
 * a path a request could name. A host without the directory configured has no
 * embedder, and alignment carries on without meaning-based anchors.
 */

import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

import type { TextEmbedder } from "./subtitleSemantics";

export interface EmbeddingModel {
  readonly id: string;
  readonly dtype: "q8" | "fp32";
  readonly pooling: "mean" | "cls";
  /** Some models were trained to see a role prefix on every input. */
  readonly prefix: string;
}

export const SUBTITLE_EMBEDDING_MODELS = {
  "multilingual-e5-small": {
    id: "Xenova/multilingual-e5-small",
    dtype: "q8",
    pooling: "mean",
    prefix: "query: ",
  },
  "multilingual-e5-base": {
    id: "Xenova/multilingual-e5-base",
    dtype: "q8",
    pooling: "mean",
    prefix: "query: ",
  },
  labse: { id: "Xenova/LaBSE", dtype: "q8", pooling: "cls", prefix: "" },
  "paraphrase-multilingual-minilm": {
    id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    dtype: "q8",
    pooling: "mean",
    prefix: "",
  },
  "bge-m3": { id: "Xenova/bge-m3", dtype: "q8", pooling: "cls", prefix: "" },
} as const satisfies Record<string, EmbeddingModel>;

export type SubtitleEmbeddingModelName = keyof typeof SUBTITLE_EMBEDDING_MODELS;

/**
 * Chosen by measurement (`docs/subtitle-sync-engine.md`): with LaBSE's anchors
 * the aligner's 95th-percentile error stayed at or under 0.29 s in every
 * scenario on nine episodes, level with bge-m3 at a third of its time;
 * multilingual-e5-small left whole regions unplaced.
 */
export const DEFAULT_SUBTITLE_EMBEDDING_MODEL: SubtitleEmbeddingModelName =
  "labse";

export function createTransformersEmbedder(options: {
  readonly model: EmbeddingModel;
  readonly cacheDir: string;
  readonly threads?: number;
  /** Texts per model call. Short lines pad little, so batching pays. */
  readonly batch?: number;
}): TextEmbedder & { dispose(): Promise<void> } {
  env.cacheDir = options.cacheDir;
  // Only from the cache or the hub; never a path a subtitle could name.
  env.allowLocalModels = false;
  let extractor: Promise<FeatureExtractionPipeline> | null = null;
  const load = () =>
    (extractor ??= pipeline("feature-extraction", options.model.id, {
      dtype: options.model.dtype,
      session_options: {
        intraOpNumThreads: options.threads ?? 2,
        interOpNumThreads: 1,
      },
    }).catch((error: unknown) => {
      extractor = null;
      throw error;
    }));
  const batch = options.batch ?? 32;
  return {
    model: `${options.model.id}@${options.model.dtype}`,
    async embed(texts) {
      const model = await load();
      const vectors: Float32Array[] = [];
      for (let from = 0; from < texts.length; from += batch) {
        const slice = texts
          .slice(from, from + batch)
          .map((text) => options.model.prefix + text);
        const output = await model(slice, {
          pooling: options.model.pooling,
          normalize: true,
        });
        const data = output.data as Float32Array;
        const width = data.length / slice.length;
        for (let row = 0; row < slice.length; row += 1)
          vectors.push(data.slice(row * width, (row + 1) * width));
      }
      return vectors;
    },
    async dispose() {
      const loaded = await extractor?.catch(() => null);
      extractor = null;
      await loaded?.dispose();
    },
  };
}
