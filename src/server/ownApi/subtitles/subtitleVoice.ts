/**
 * Where a neural voice detector hears somebody speaking.
 *
 * The loudness envelope (`audioSpeech.ts`) cannot tell a voice from a score:
 * on nine packaged episodes only 39–46% of what it marked as speech was inside
 * a subtitle line, and on Arcane's continuous music 25–36%. Silero, a small
 * neural voice detector, marked 97–99% correctly — it is the evidence for
 * *whether* someone is speaking, where the envelope is evidence only that
 * something got louder. It ships with whisper.cpp as a ggml model and a
 * one-shot tool, `whisper-vad-speech-segments`, so the machine that
 * transcribes can run it in the same job for twenty seconds of CPU an episode.
 */

import type { SpeechInterval } from "./subtitleAlignment";

/** The tool prints `Speech segment N: start = <cs>, end = <cs>` in centiseconds. */
const SEGMENT_LINE = /start = ([\d.]+), end = ([\d.]+)/;

export function parseVoiceSegments(output: string): SpeechInterval[] {
  return output
    .split("\n")
    .flatMap((line) => {
      const found = SEGMENT_LINE.exec(line);
      if (!found) return [];
      const startSeconds = Number(found[1]) / 100;
      const endSeconds = Number(found[2]) / 100;
      return Number.isFinite(startSeconds) && endSeconds > startSeconds
        ? [{ startSeconds, endSeconds }]
        : [];
    })
    .sort((left, right) => left.startSeconds - right.startSeconds);
}
