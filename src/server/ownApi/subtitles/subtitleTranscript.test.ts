import { describe, expect, it } from "vitest";
import {
  isReliableSpeech,
  parseWhisperTranscript,
  transcriptAudioEvents,
  transcriptUtterances,
} from "./subtitleTranscript";

const ENGINE = { name: "whisper.cpp" as const, model: "test", options: {} };

/** whisper.cpp's --output-json-full shape, for the segments given. */
function whisperJson(
  segments: {
    from: number;
    to: number;
    text: string;
    words?: [string, number, number, number?][];
  }[],
) {
  return JSON.stringify({
    result: { language: "en" },
    transcription: segments.map((segment) => ({
      offsets: { from: segment.from, to: segment.to },
      text: segment.text,
      tokens: [
        {
          text: "[_BEG_]",
          offsets: { from: segment.from, to: segment.from },
          p: 0.9,
        },
        ...(segment.words ?? []).map(([text, from, to, p]) => ({
          text,
          offsets: { from, to },
          p: p ?? 0.95,
        })),
        {
          text: "[_TT_100]",
          offsets: { from: segment.to, to: segment.to },
          p: 0.5,
        },
      ],
    })),
  });
}

describe("parseWhisperTranscript", () => {
  it("joins tokens into words at a leading space and drops timing markers", () => {
    const transcript = parseWhisperTranscript(
      whisperJson([
        {
          from: 1000,
          to: 3000,
          text: " You're my sister.",
          words: [
            [" You", 1000, 1200],
            ["'re", 1200, 1350],
            [" my", 1350, 1500],
            [" sister", 1500, 2000],
            [".", 2000, 2050],
          ],
        },
      ]),
      ENGINE,
    );
    expect(transcript.segments[0]?.words.map((word) => word.text)).toEqual([
      "You're",
      "my",
      "sister.",
    ]);
    expect(transcript.segments[0]?.words[0]).toMatchObject({
      startSeconds: 1,
      endSeconds: 1.35,
    });
    expect(isReliableSpeech(transcript.segments[0]!)).toBe(true);
  });

  it("keeps sound captions as audio events and never as speech", () => {
    const transcript = parseWhisperTranscript(
      whisperJson([
        { from: 0, to: 2300, text: " (explosion)" },
        { from: 3000, to: 9000, text: " [dramatic music]" },
        { from: 9500, to: 12000, text: " ♪ Welcome to the playground ♪" },
      ]),
      ENGINE,
    );
    expect(
      transcript.segments.every((segment) => !isReliableSpeech(segment)),
    ).toBe(true);
    expect(
      transcriptAudioEvents(transcript).map((event) => event.category),
    ).toEqual(["effect", "music", "singing"]);
    expect(transcriptUtterances(transcript)).toEqual([]);
  });

  it("flags a line the model loops over music, and stock lines from its training subtitles", () => {
    const transcript = parseWhisperTranscript(
      whisperJson([
        {
          from: 0,
          to: 2000,
          text: " I'll be back.",
          words: [
            [" I'll", 0, 300],
            [" be", 300, 500],
            [" back.", 500, 900],
          ],
        },
        {
          from: 2000,
          to: 4000,
          text: " I'll be back.",
          words: [
            [" I'll", 2000, 2300],
            [" be", 2300, 2500],
            [" back.", 2500, 2900],
          ],
        },
        {
          from: 4000,
          to: 6000,
          text: " I'll be back.",
          words: [
            [" I'll", 4000, 4300],
            [" be", 4300, 4500],
            [" back.", 4500, 4900],
          ],
        },
        {
          from: 7000,
          to: 9000,
          text: " Thank you for watching!",
          words: [
            [" Thank", 7000, 7300],
            [" you", 7300, 7500],
          ],
        },
      ]),
      ENGINE,
    );
    expect(transcript.segments.map((segment) => segment.flags)).toEqual([
      [],
      ["repeated"],
      ["repeated"],
      ["stock-phrase"],
    ]);
  });

  it("flags words the model itself doubts", () => {
    const transcript = parseWhisperTranscript(
      whisperJson([
        {
          from: 0,
          to: 2000,
          text: " Mumble grumble.",
          words: [
            [" Mumble", 0, 500, 0.1],
            [" grumble.", 500, 1000, 0.2],
          ],
        },
      ]),
      ENGINE,
    );
    expect(transcript.segments[0]?.flags).toContain("low-confidence");
  });
});

describe("transcriptUtterances", () => {
  it("starts a new stretch at a pause longer than the gap", () => {
    const transcript = parseWhisperTranscript(
      whisperJson([
        {
          from: 10_000,
          to: 16_000,
          text: " Wait. Listen to me.",
          words: [
            [" Wait.", 10_000, 10_400],
            [" Listen", 12_000, 12_400],
            [" to", 12_400, 12_500],
            [" me.", 12_500, 12_800],
          ],
        },
      ]),
      ENGINE,
    );
    expect(transcriptUtterances(transcript, 0.6)).toEqual([
      { startSeconds: 10, endSeconds: 10.4 },
      { startSeconds: 12, endSeconds: 12.8 },
    ]);
  });
});
