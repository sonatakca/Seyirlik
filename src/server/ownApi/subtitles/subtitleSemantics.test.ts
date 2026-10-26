import { describe, expect, it } from "vitest";
import {
  semanticAnchors,
  speechText,
  type TextEmbedder,
} from "./subtitleSemantics";

/**
 * An embedder that knows which sentences mean the same thing because it is
 * told: every text maps to the unit vector of its meaning's number, plus a
 * little of a shared direction so that unrelated sentences are not exactly
 * orthogonal, which no real model achieves either.
 */
function meanings(dictionary: Record<string, number>, size = 64): TextEmbedder {
  return {
    model: "test",
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Float32Array(size);
        const meaning = dictionary[text];
        vector[0] = 0.3;
        if (meaning !== undefined) vector[1 + (meaning % (size - 1))] = 1;
        const norm = Math.hypot(...vector);
        return vector.map((value) => value / norm);
      });
    },
  };
}

/** A conversation: Turkish lines and the English spoken for each. */
function conversation(count: number, phrase = (i: number) => `line ${i}`) {
  const dictionary: Record<string, number> = {};
  const cues = [];
  const segments = [];
  for (let i = 0; i < count; i += 1) {
    const turkish = `tr ${phrase(i)}`;
    const english = `en ${phrase(i)}`;
    dictionary[turkish] = dictionary[english] = Number(
      /\d+/.exec(phrase(i))![0],
    );
    cues.push({ index: i, text: turkish, startSeconds: 20 + i * 6 });
    segments.push({
      startSeconds: 20 + i * 6,
      endSeconds: 22 + i * 6,
      text: english,
    });
  }
  return { dictionary, cues, segments };
}

describe("speechText", () => {
  it("keeps what was said and drops markup, sound descriptions and dashes", () => {
    expect(speechText("<i>- Gel buraya!</i>\n- [patlama] Hemen!")).toBe(
      "Gel buraya! Hemen!",
    );
  });
});

describe("semanticAnchors", () => {
  it("anchors each line to where its meaning is spoken, even when the subtitle is late", async () => {
    const { dictionary, cues, segments } = conversation(60);
    const late = cues.map((cue) => ({
      ...cue,
      startSeconds: cue.startSeconds + 8,
    }));
    const anchors = await semanticAnchors({
      cues: late,
      segments,
      embedder: meanings(dictionary),
    });
    expect(anchors.length).toBeGreaterThan(50);
    for (const anchor of anchors)
      expect(anchor.mediaSeconds).toBe(20 + anchor.cueIndex * 6);
  });

  it("follows an edit: everything after it is matched at its new offset", async () => {
    const { dictionary, cues, segments } = conversation(80);
    const edited = cues.map((cue) =>
      cue.index >= 40 ? { ...cue, startSeconds: cue.startSeconds + 45 } : cue,
    );
    const anchors = await semanticAnchors({
      cues: edited,
      segments,
      embedder: meanings(dictionary),
    });
    const after = anchors.filter((anchor) => anchor.cueIndex >= 40);
    expect(after.length).toBeGreaterThan(30);
    for (const anchor of after)
      expect(anchor.mediaSeconds).toBe(20 + anchor.cueIndex * 6);
  });

  it("matches a repeated line where its neighbours are, not wherever it first appears", async () => {
    // "Come on!" every tenth line, all with the same meaning.
    const phrase = (i: number) => (i % 10 === 5 ? "come on 999" : `line ${i}`);
    const { dictionary, cues, segments } = conversation(60, phrase);
    const anchors = await semanticAnchors({
      cues,
      segments,
      embedder: meanings(dictionary),
    });
    const repeats = anchors.filter((anchor) => anchor.cueIndex % 10 === 5);
    for (const anchor of repeats)
      expect(anchor.mediaSeconds).toBe(20 + anchor.cueIndex * 6);
    // And each carries less weight than a line that means only one thing.
    const unique = anchors.filter((anchor) => anchor.cueIndex % 10 !== 5);
    const mean = (list: typeof anchors) =>
      list.reduce((sum, anchor) => sum + anchor.weight, 0) /
      Math.max(1, list.length);
    expect(mean(repeats)).toBeLessThan(mean(unique));
  });

  it("gives a lone match with no agreeing neighbours little weight", async () => {
    const { dictionary, cues, segments } = conversation(30);
    // Only one line has a counterpart in the transcript.
    const anchors = await semanticAnchors({
      cues,
      segments: segments.filter((_, i) => i === 12),
      embedder: meanings(dictionary),
    });
    expect(anchors.every((anchor) => anchor.weight < 0.6)).toBe(true);
  });

  it("finds nothing when nothing was said", async () => {
    const { dictionary, cues } = conversation(10);
    expect(
      await semanticAnchors({
        cues,
        segments: [],
        embedder: meanings(dictionary),
      }),
    ).toEqual([]);
  });
});
