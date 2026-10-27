import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  audioIdentity,
  parseAsrConfig,
  parseEmbeddingConfig,
  recogniserLanguage,
} from "./subtitleAnalysis";

describe("configuration", () => {
  it("has no recogniser or embedder unless one is declared", () => {
    expect(parseAsrConfig({})).toBeUndefined();
    expect(parseEmbeddingConfig({})).toBeUndefined();
  });

  it("reads a recogniser declaration and refuses a malformed one", () => {
    expect(
      parseAsrConfig({
        SEYIRLIK_SUBTITLE_ASR: JSON.stringify({
          binaryPath: "/opt/whisper/whisper-cli",
          modelPath: "/models/ggml-small.bin",
          threads: 8,
        }),
      }),
    ).toEqual({
      binaryPath: "/opt/whisper/whisper-cli",
      modelPath: "/models/ggml-small.bin",
      threads: 8,
    });
    for (const bad of [
      "{",
      JSON.stringify({ binaryPath: "whisper-cli", modelPath: "/m.bin" }),
      JSON.stringify({ binaryPath: "/w", modelPath: "/m", gpu: true }),
      JSON.stringify({ binaryPath: "/w", modelPath: "/m", threads: 0 }),
    ])
      expect(() => parseAsrConfig({ SEYIRLIK_SUBTITLE_ASR: bad })).toThrow();
  });

  it("reads where the embedding model is kept", () => {
    expect(
      parseEmbeddingConfig({
        SEYIRLIK_SUBTITLE_EMBEDDINGS: JSON.stringify({ modelDir: "/models" }),
      }),
    ).toEqual({ modelDir: "/models", threads: 2 });
    expect(() =>
      parseEmbeddingConfig({
        SEYIRLIK_SUBTITLE_EMBEDDINGS: '{"modelDir":"models"}',
      }),
    ).toThrow();
  });
});

describe("recogniserLanguage", () => {
  it("gives Whisper its two-letter code, or auto for what it cannot name", () => {
    expect(recogniserLanguage("eng")).toBe("en");
    expect(recogniserLanguage("spa")).toBe("es");
    expect(recogniserLanguage("tur")).toBe("tr");
    expect(recogniserLanguage(null)).toBe("auto");
    expect(recogniserLanguage("xyz")).toBe("auto");
  });
});

describe("audioIdentity", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("follows the package's audio, not its path", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "seyirlik-audio-key-"));
    const here = path.join(dir, "a.m3u8");
    const there = path.join(dir, "elsewhere.m3u8");
    await writeFile(here, "#EXTM3U\n#EXT-X-BYTERANGE:100@0\nenglish.m4a\n");
    await writeFile(there, "#EXTM3U\n#EXT-X-BYTERANGE:100@0\nenglish.m4a\n");
    const key = (file: string) =>
      audioIdentity({
        mediaFileId: "m",
        sourceStreamIndex: 1,
        audio: { path: file, streamIndex: 0, isPackagePlaylist: true },
      });
    // The same playlist mounted at two places is the same audio.
    expect(await key(here)).toBe(await key(there));
    // A re-encode writes different byte ranges: different audio.
    await writeFile(there, "#EXTM3U\n#EXT-X-BYTERANGE:120@0\nenglish.m4a\n");
    expect(await key(here)).not.toBe(await key(there));
  });
});
