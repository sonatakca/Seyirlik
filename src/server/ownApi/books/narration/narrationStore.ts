import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isUuid } from "../../api/validation";

/**
 * A section's audio arrives in parts (a request through the tunnel carries
 * at most about 100 MB, and a section of a novel runs to hours), each one
 * added to the end of a staged file. The upload is then finished: the staged
 * file is checked against the hash the narrator gives, and the audio and its
 * word timings are put in place under names that carry that hash. The
 * database names the hash it serves, so switching to a new upload is one
 * row change, and the old files go once nothing names them.
 *
 *   <root>/<itemId>/staging/<section>.part
 *   <root>/<itemId>/<section>-<sha256>.m4a
 *   <root>/<itemId>/<section>-<sha256>.words.json
 */
export const MAX_NARRATION_PART_BYTES = 32 * 1024 * 1024;
/** Far longer than any section: 64 kbit/s for a day. */
export const MAX_NARRATION_AUDIO_BYTES = 800 * 1024 * 1024;

export class StagedSizeError extends Error {
  constructor(readonly size: number) {
    super("The upload is not where the part says it is.");
  }
}

export class StagedAudioError extends Error {}

export interface NarrationFiles {
  audio: string;
  words: string;
}

export interface NarrationStore {
  /** Adds a part at `offset`, which must be where the staged file ends; returns its new size. */
  append(
    itemId: string,
    section: number,
    offset: number,
    body: Readable,
    length: number,
  ): Promise<number>;
  /** The staged file's size, 0 when nothing is staged. */
  stagedSize(itemId: string, section: number): Promise<number>;
  /**
   * Puts the staged audio and its timings in place, if the audio is whole,
   * has this hash, and is an MP4. Returns its size.
   */
  commit(
    itemId: string,
    section: number,
    sha256: string,
    words: string,
  ): Promise<number>;
  files(itemId: string, section: number, sha256: string): NarrationFiles;
  removeVersion(itemId: string, section: number, sha256: string): Promise<void>;
  removeAll(itemId: string): Promise<void>;
}

export function createNarrationStore(root: string): NarrationStore {
  const resolvedRoot = path.resolve(root);
  // Item ids are UUIDs and sections numbers, so no name can leave the root.
  const directory = (itemId: string) => {
    if (!isUuid(itemId))
      throw new Error("A narration is named by its item's id.");
    return path.join(resolvedRoot, itemId);
  };
  const staged = (itemId: string, section: number) =>
    path.join(directory(itemId), "staging", `${Math.trunc(section)}.part`);
  const files = (itemId: string, section: number, sha256: string) => {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Not a SHA-256.");
    const base = path.join(
      directory(itemId),
      `${Math.trunc(section)}-${sha256}`,
    );
    return { audio: `${base}.m4a`, words: `${base}.words.json` };
  };
  /** One part at a time per section: two at once could not both end where the file ends. */
  const busy = new Set<string>();

  const sizeOf = async (file: string) =>
    (await stat(file).catch(() => null))?.size ?? 0;

  return {
    files,

    stagedSize: (itemId, section) => sizeOf(staged(itemId, section)),

    append: async (itemId, section, offset, body, length) => {
      // Until the pipeline below takes the body, a connection dropped now
      // would be an error with no listener, which ends the process. The
      // pipeline then reports it as a part cut short.
      body.on("error", () => undefined);
      const file = staged(itemId, section);
      const key = file;
      if (busy.has(key)) throw new StagedSizeError(await sizeOf(file));
      busy.add(key);
      try {
        await mkdir(path.dirname(file), { recursive: true });
        // A part at 0 starts the upload over; any other must follow the last.
        if (offset !== 0 && (await sizeOf(file)) !== offset)
          throw new StagedSizeError(await sizeOf(file));
        if (offset + length > MAX_NARRATION_AUDIO_BYTES)
          throw new StagedAudioError(
            "The audio is longer than a section can be.",
          );

        let written = 0;
        const counted = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            written += chunk.length;
            done(
              written > length
                ? new StagedAudioError("The part is longer than it said.")
                : null,
              chunk,
            );
          },
        });
        try {
          // pipeline reports a connection dropped mid-part as an error, so a
          // cut-off part can never be taken for a whole one.
          await pipeline(
            body,
            counted,
            createWriteStream(file, { flags: offset === 0 ? "w" : "a" }),
          );
          if (written !== length) throw new StagedSizeError(offset);
        } catch (error) {
          // The file goes back to where the last whole part ended, so the
          // narrator sends this one again from there.
          await truncate(file, offset).catch(() => undefined);
          throw error instanceof StagedAudioError ||
            error instanceof StagedSizeError
            ? error
            : new StagedSizeError(offset);
        }
        return offset + written;
      } finally {
        busy.delete(key);
      }
    },

    commit: async (itemId, section, sha256, words) => {
      const file = staged(itemId, section);
      const size = await sizeOf(file);
      if (size === 0)
        throw new StagedAudioError("No audio was uploaded for this section.");

      const hash = createHash("sha256");
      const head = Buffer.alloc(12);
      let headLength = 0;
      await new Promise<void>((resolve, reject) => {
        createReadStream(file)
          .on("data", (chunk: Buffer) => {
            if (headLength < head.length)
              headLength += chunk.copy(
                head,
                headLength,
                0,
                head.length - headLength,
              );
            hash.update(chunk);
          })
          .on("error", reject)
          .on("end", resolve);
      });
      if (hash.digest("hex") !== sha256)
        throw new StagedAudioError(
          "The audio is not what was uploaded: its hash differs.",
        );
      // An MP4 begins with its ftyp box: a section's audio is AAC in MP4.
      if (headLength < 8 || head.toString("latin1", 4, 8) !== "ftyp")
        throw new StagedAudioError("The audio is not an MP4 file.");

      const target = files(itemId, section, sha256);
      // The very same audio already in place (an upload sent again): its
      // file may be open to a listener, and Windows will not rename over an
      // open file, so the copy just checked is the one dropped.
      const same = (await sizeOf(target.audio)) === size;
      if (
        same &&
        (await readFile(target.words, "utf8").catch(() => null)) === words
      ) {
        await unlink(file);
        return size;
      }
      // Timings first, written whole: audio in place always has its words.
      const temporary = `${target.words}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "w");
      try {
        await handle.writeFile(words, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target.words);
      if (same) await unlink(file);
      else await rename(file, target.audio);
      return size;
    },

    removeVersion: async (itemId, section, sha256) => {
      const target = files(itemId, section, sha256);
      await Promise.all(
        [target.audio, target.words].map((file) =>
          unlink(file).catch(() => undefined),
        ),
      );
    },

    removeAll: async (itemId) => {
      await rm(directory(itemId), { recursive: true, force: true });
    },
  };
}
