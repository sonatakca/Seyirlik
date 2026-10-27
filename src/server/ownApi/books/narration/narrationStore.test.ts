// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StagedAudioError,
  StagedSizeError,
  createNarrationStore,
} from "./narrationStore";
import { checkTimings, TimingsError } from "./narrationTimings";

const BOOK = "22222222-2222-4222-8222-222222222222";
// Enough of an MP4 for the check: a box size, then "ftyp".
const audio = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypM4A "),
  Buffer.alloc(4000, 7),
]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("narration store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "narration-store-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("takes the audio in parts and puts it in place with its words", async () => {
    const store = createNarrationStore(root);
    const first = audio.subarray(0, 1500);
    const rest = audio.subarray(1500);

    expect(
      await store.append(BOOK, 1, 0, Readable.from([first]), first.length),
    ).toBe(1500);
    expect(
      await store.append(BOOK, 1, 1500, Readable.from([rest]), rest.length),
    ).toBe(audio.length);
    expect(await store.commit(BOOK, 1, sha(audio), '{"words":[]}')).toBe(
      audio.length,
    );

    const files = store.files(BOOK, 1, sha(audio));
    expect(await readFile(files.audio)).toEqual(audio);
    expect(await readFile(files.words, "utf8")).toBe('{"words":[]}');
    expect(await store.stagedSize(BOOK, 1)).toBe(0);
  });

  it("refuses a part that does not follow the last, and says where to go on", async () => {
    const store = createNarrationStore(root);
    await store.append(
      BOOK,
      1,
      0,
      Readable.from([audio.subarray(0, 100)]),
      100,
    );

    await expect(
      store.append(
        BOOK,
        1,
        400,
        Readable.from([audio.subarray(400, 500)]),
        100,
      ),
    ).rejects.toEqual(new StagedSizeError(100));
  });

  it("forgets a part cut off on the way, so it can be sent again whole", async () => {
    const store = createNarrationStore(root);
    await store.append(
      BOOK,
      1,
      0,
      Readable.from([audio.subarray(0, 100)]),
      100,
    );

    const cut = new PassThrough();
    const sending = store.append(BOOK, 1, 100, cut, 1000);
    cut.write(audio.subarray(100, 400));
    cut.destroy(new Error("connection reset"));

    await expect(sending).rejects.toBeInstanceOf(StagedSizeError);
    expect(await store.stagedSize(BOOK, 1)).toBe(100);
    // Nor is a part longer than it said kept.
    await expect(
      store.append(BOOK, 1, 100, Readable.from([audio.subarray(100, 400)]), 50),
    ).rejects.toBeInstanceOf(StagedAudioError);
    expect(await store.stagedSize(BOOK, 1)).toBe(100);
  });

  it("puts nothing in place unless the audio is whole, as hashed, and an MP4", async () => {
    const store = createNarrationStore(root);
    await store.append(
      BOOK,
      2,
      0,
      Readable.from([audio.subarray(0, 2000)]),
      2000,
    );
    await expect(
      store.commit(BOOK, 2, sha(audio), "{}"),
    ).rejects.toBeInstanceOf(StagedAudioError);

    const wav = Buffer.from("RIFF....WAVEfmt ");
    await store.append(BOOK, 3, 0, Readable.from([wav]), wav.length);
    await expect(store.commit(BOOK, 3, sha(wav), "{}")).rejects.toThrow(/MP4/);
    expect(await readdir(path.join(root, BOOK))).toEqual(["staging"]);
  });

  it("takes the same audio sent again without moving the file in place", async () => {
    const store = createNarrationStore(root);
    const send = () =>
      store.append(BOOK, 1, 0, Readable.from([audio]), audio.length);
    await send();
    await store.commit(BOOK, 1, sha(audio), '{"words":[1]}');
    const files = store.files(BOOK, 1, sha(audio));

    // Same audio, same words: nothing changes, and nothing is left staged.
    await send();
    expect(await store.commit(BOOK, 1, sha(audio), '{"words":[1]}')).toBe(
      audio.length,
    );
    // Same audio, new words: only the words are written.
    await send();
    await store.commit(BOOK, 1, sha(audio), '{"words":[2]}');
    expect(await readFile(files.words, "utf8")).toBe('{"words":[2]}');
    expect(await readFile(files.audio)).toEqual(audio);
    expect(await store.stagedSize(BOOK, 1)).toBe(0);
  });

  it("removes a replaced version, and everything of a book", async () => {
    const store = createNarrationStore(root);
    await store.append(BOOK, 1, 0, Readable.from([audio]), audio.length);
    await store.commit(BOOK, 1, sha(audio), "{}");

    await store.removeVersion(BOOK, 1, sha(audio));
    expect((await readdir(path.join(root, BOOK))).sort()).toEqual(["staging"]);
    await store.removeAll(BOOK);
    await expect(readdir(path.join(root, BOOK))).rejects.toThrow();
  });

  it("names nothing outside its root", () => {
    const store = createNarrationStore(root);
    expect(() => store.files("../../etc", 1, sha(audio))).toThrow();
    expect(() => store.files(BOOK, 1, "../x")).toThrow();
  });
});

describe("checkTimings", () => {
  const section = {
    section: 1,
    blocks: [
      { block: 0, heading: true, text: "BİR" },
      { block: 1, heading: false, text: "Pansiyondaki Hollandalı dul" },
    ],
  };

  it("takes words inside their blocks, heard in order within the audio", () => {
    expect(
      checkTimings(
        section,
        [
          [0, 0, 3, 100, 500],
          [1, 0, 12, 900, 1600],
          [1, 13, 23, 1700, 2300],
        ],
        3,
      ),
    ).toHaveLength(3);
  });

  it.each([
    ["a block the section does not read", [[5, 0, 3, 0, 100]]],
    ["a word past its block's text", [[0, 0, 4, 0, 100]]],
    ["an empty word", [[1, 4, 4, 0, 100]]],
    ["a word after the audio ends", [[1, 0, 4, 0, 9000]]],
    [
      "words out of order",
      [
        [1, 0, 4, 500, 600],
        [1, 5, 9, 100, 200],
      ],
    ],
    ["a word that is not five numbers", [[1, 0, 4, 0]]],
    ["a fraction", [[1, 0.5, 4, 0, 10]]],
  ])("refuses %s", (_name, words) => {
    expect(() => checkTimings(section, words, 3)).toThrow(TimingsError);
  });

  it("refuses a duration that is not a length of audio", () => {
    expect(() => checkTimings(section, [], 0)).toThrow(TimingsError);
    expect(() => checkTimings(section, [], Number.NaN)).toThrow(TimingsError);
  });
});
