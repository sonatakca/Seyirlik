/**
 * The epochs' stream copies, against a direct read of the source.
 *
 * The same title is packaged twice: once with the epochs copying the audio and
 * text subtitle tracks out for the later stages, once with every stage reading
 * the source itself. The published sound and subtitles must be byte for byte
 * the same, and the first package must actually have used the copies.
 *
 * The fixture is made to catch the ways a join goes wrong: a track that starts
 * after the picture, two audio codecs with different frame lengths, and a
 * subtitle cue that straddles an epoch boundary.
 */

import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RenditionPaths } from "../../analysis";
import { computeSourceFingerprint } from "../../registry";
import { packageAdaptiveRendition } from "../packager";
import { runFfmpeg } from "../../processor";
import { ADAPTIVE_PROFILE_VERSION } from "../profile";
import { readTitlePackageManifest } from "../publishTitle";
import { hasFfmpeg } from "../testFixtures";
import {
  audioStagePath,
  checkpointRoot,
  readAuxiliaryStage,
  readEpochManifest,
} from "./checkpoints";
import { EPOCH_SOURCE_COPY_FILE } from "./sourceCopy";

const run = promisify(execFile);
const MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const EPOCH_TARGET_SECONDS = 6;

let workspace = "";
let fixture: string | null = null;

function srtTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

async function buildFixture(directory: string): Promise<string> {
  const cues: Array<[number, number]> = [
    [1, 2.5],
    // Straddles the first epoch boundary.
    [5.8, 6.6],
    [13, 14],
    [19, 21],
  ];
  const srt = path.join(directory, "cues.srt");
  await writeFile(
    srt,
    cues
      .map(
        ([from, to], index) =>
          `${index + 1}\n${srtTime(from)} --> ${srtTime(to)}\nline ${index + 1}\n`,
      )
      .join("\n"),
    "utf8",
  );
  // A second track, so the subtitle stage reads its tracks in one pass.
  const turkish = path.join(directory, "tr.srt");
  await writeFile(
    turkish,
    `1\n${srtTime(3)} --> ${srtTime(4)}\nsatır bir\n\n2\n${srtTime(12)} --> ${srtTime(13.5)}\nsatır iki\n`,
    "utf8",
  );
  const target = path.join(directory, "copy-source.mkv");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24000/1001",
    "-itsoffset",
    "0.3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=sample_rate=48000:color=pink:amplitude=0.2",
    "-i",
    srt,
    "-i",
    turkish,
    "-t",
    "22",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-map",
    "2:a",
    "-map",
    "3:s",
    "-map",
    "4:s",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-g",
    "48",
    "-pix_fmt",
    "yuv420p",
    "-c:a:0",
    "aac",
    "-ac:a:0",
    "2",
    "-c:a:1",
    "ac3",
    "-ac:a:1",
    "2",
    "-c:s",
    "srt",
    "-metadata:s:a:0",
    "language=eng",
    "-metadata:s:a:1",
    "language=tur",
    "-metadata:s:s:0",
    "language=eng",
    "-metadata:s:s:1",
    "language=tur",
    target,
  ]);
  return target;
}

async function packageCopyOf(
  copySourceStreams: boolean,
  overrides: Record<string, unknown> = {},
) {
  const root = await mkdtemp(path.join(workspace, "run-"));
  const paths: RenditionPaths = {
    mediaRoot: path.join(root, "media"),
    renditionRoot: path.join(root, "renditions"),
    workRoot: path.join(root, "work"),
    stateRoot: path.join(root, "state"),
    logsRoot: path.join(root, "logs"),
  };
  await mkdir(paths.logsRoot, { recursive: true });
  await mkdir(path.join(paths.stateRoot, "locks"), { recursive: true });
  const titleRoot = path.join(paths.mediaRoot, "Copy Title (2026)");
  await mkdir(titleRoot, { recursive: true });
  const sourcePath = path.join(titleRoot, "copy-source.mkv");
  await writeFile(sourcePath, await readFile(fixture!));
  const fingerprint = await computeSourceFingerprint(
    sourcePath,
    await stat(sourcePath),
  );
  const result = await packageAdaptiveRendition(
    {
      mediaId: MEDIA_ID,
      relativePath: path.relative(paths.mediaRoot, sourcePath),
      sourceFingerprint: fingerprint,
      sourcePath,
    },
    paths,
    {
      reserveBytes: 0,
      preset: "ultrafast",
      verifySourceFingerprint: false,
      epochTargetSeconds: EPOCH_TARGET_SECONDS,
      subtitleStreamIndexes: [3, 4],
      retainWorkspaceAfterPublish: true,
      copySourceStreams,
      ...overrides,
    } as never,
  );
  return {
    result,
    titleRoot,
    checkpoints: checkpointRoot(
      paths.workRoot,
      MEDIA_ID,
      ADAPTIVE_PROFILE_VERSION,
      fingerprint,
    ),
  };
}

async function publishedBytes(titleRoot: string) {
  const manifest = await readTitlePackageManifest(titleRoot);
  expect(manifest).not.toBeNull();
  const read = (relative: string) =>
    readFile(path.join(titleRoot, ...relative.split("/")));
  return {
    audio: await Promise.all(
      manifest!.audio.map(async (rendition) => ({
        id: rendition.id,
        bytes: await read(rendition.mediaPath),
      })),
    ),
    subtitle: await Promise.all(
      manifest!.subtitle.map(async (rendition) => ({
        id: rendition.id,
        text: (await read(rendition.mediaPath)).toString("utf8"),
      })),
    ),
  };
}

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "seyirlik-copy-it-"));
  if (await hasFfmpeg()) fixture = await buildFixture(workspace);
}, 300_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

describe("epoch stream copies", () => {
  it("publish the same sound and subtitles as reading the source", async () => {
    if (!fixture) {
      console.warn("FFmpeg is not available; skipping stream copy test.");
      return;
    }
    const copied = await packageCopyOf(true);
    expect(copied.result.error).toBeUndefined();
    expect(copied.result.status).toBe("ready");
    const direct = await packageCopyOf(false);
    expect(direct.result.error).toBeUndefined();
    expect(direct.result.status).toBe("ready");

    // The copies were made by every epoch and actually read.
    const epoch0 = await readEpochManifest(copied.checkpoints, 0);
    expect(epoch0?.sourceCopy?.streams.map((stream) => stream.kind)).toEqual(
      expect.arrayContaining(["audio", "subtitle"]),
    );
    const audioStage = await readAuxiliaryStage(
      audioStagePath(copied.checkpoints),
    );
    expect(audioStage?.sourceCopyUnavailable).toBeUndefined();
    expect(audioStage?.readFrom).toBe("epoch-copies");
    const directStage = await readAuxiliaryStage(
      audioStagePath(direct.checkpoints),
    );
    expect(directStage?.readFrom).toBe("source");

    const fromCopies = await publishedBytes(copied.titleRoot);
    const fromSource = await publishedBytes(direct.titleRoot);
    expect(fromCopies.audio.length).toBeGreaterThan(0);
    expect(fromCopies.audio.map((entry) => entry.id)).toEqual(
      fromSource.audio.map((entry) => entry.id),
    );
    for (const [index, entry] of fromCopies.audio.entries()) {
      expect(
        entry.bytes.equals(fromSource.audio[index]!.bytes),
        `audio ${entry.id} differs`,
      ).toBe(true);
    }
    expect(fromCopies.subtitle.length).toBe(2);
    expect(fromCopies.subtitle).toEqual(fromSource.subtitle);
    expect(fromCopies.subtitle[0]!.text).toContain("line 2");
    expect(fromCopies.subtitle[1]!.text).toContain("satır iki");
  }, 900_000);

  it("retries an epoch without the copy when FFmpeg fails with it attached", async () => {
    if (!fixture) return;
    const withCopy: boolean[] = [];
    let failed = false;
    const packaged = await packageCopyOf(true, {
      runEncoder: (async (
        command: string,
        args: string[],
        options: Parameters<typeof runFfmpeg>[2],
      ) => {
        const copying = args.some((arg) =>
          arg.endsWith(EPOCH_SOURCE_COPY_FILE),
        );
        withCopy.push(copying);
        if (copying && !failed) {
          failed = true;
          throw new Error(
            "FFmpeg failed with exit code 1: Could not write header for output file #1",
          );
        }
        return runFfmpeg(command, args, options);
      }) as never,
    });
    expect(packaged.result.error).toBeUndefined();
    expect(packaged.result.status).toBe("ready");
    // One attempt carried the copy and failed; nothing after it tried again.
    expect(withCopy.filter(Boolean)).toHaveLength(1);
    const audioStage = await readAuxiliaryStage(
      audioStagePath(packaged.checkpoints),
    );
    expect(audioStage?.readFrom).toBe("source");
    expect(audioStage?.sourceCopyUnavailable).toContain(
      "failed with the stream copy attached",
    );
  }, 900_000);
});
