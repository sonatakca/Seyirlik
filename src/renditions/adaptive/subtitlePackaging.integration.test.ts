import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { describe, expect, it } from "vitest";
import { analyseRenditionLibrary } from "../analysis";
import { computeSourceFingerprint } from "../registry";
import { packageAdaptiveRendition } from "./packager";
import { planRetainedSidecarSubtitles } from "./processor";
import { readTitlePackageManifest } from "./publishTitle";
import { resolvePublishedTitleRoot } from "./publishedRoot";
import { rejectPublicationCommit } from "../../test/publicationFault";

const run = promisify(execFile);
const srt = (text: string) => `1\n00:00:00,500 --> 00:00:02,000\n${text}\n`;

// It builds a real package, so it needs FFmpeg; CI's runner has none.
const ffmpegAvailable =
  spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" })
    .status === 0;

describe.skipIf(!ffmpegAvailable)(
  "sidecar subtitles in a published package",
  () => {
    it("adds and updates Turkish without rebuilding video or reusing another subtitle's id", async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "seyirlik-sidecar-package-"),
      );
      try {
        const titleRoot = path.join(root, "media", "Movies", "Film");
        await mkdir(titleRoot, { recursive: true });
        const sourcePath = path.join(titleRoot, "Film.mp4");
        await run("ffmpeg", [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=640x360:rate=24",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000",
          "-t",
          "4",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-c:a",
          "aac",
          sourcePath,
        ]);
        await writeFile(
          path.join(titleRoot, "Z.eng.srt"),
          srt("English dialogue"),
        );
        const paths = {
          mediaRoot: path.join(root, "media"),
          renditionRoot: path.join(root, "renditions"),
          workRoot: path.join(root, "work"),
          stateRoot: path.join(root, "state"),
          logsRoot: path.join(root, "logs"),
        };
        const request = {
          mediaId: "11111111-1111-4111-8111-111111111111",
          relativePath: "Movies/Film/Film.mp4",
          sourcePath,
          titleRoot,
          sourceFingerprint: await computeSourceFingerprint(
            sourcePath,
            await stat(sourcePath),
          ),
        };
        const build = async (
          publicationFileSystem?: {
            rename: typeof import("node:fs/promises").rename;
          },
          allowFailure = false,
        ) => {
          const result = await packageAdaptiveRendition(request, paths, {
            reserveBytes: 0,
            videoEncoder: "libx264",
            preset: "ultrafast",
            audioStreamIndexes: [1],
            sidecarSubtitles: await planRetainedSidecarSubtitles(sourcePath),
            publicationFileSystem,
          });
          if (
            !allowFailure &&
            (result.status === "failed" ||
              result.status === "validation-failed")
          )
            throw new Error(result.error);
          return result;
        };
        expect(await build()).toMatchObject({ status: "ready" });
        const first = (await readTitlePackageManifest(titleRoot))!;
        const initialRoot = await resolvePublishedTitleRoot(titleRoot);
        const unchanged = await Promise.all(
          [...first.video, ...first.audio].map(async (track) => ({
            id: track.id,
            mtime: (await stat(path.join(initialRoot, track.mediaPath)))
              .mtimeMs,
            hash: createHash("sha256")
              .update(await readFile(path.join(initialRoot, track.mediaPath)))
              .digest("hex"),
          })),
        );

        // Sorts before Z: index 1000 now belongs to Turkish, not English.
        const turkishPath = path.join(titleRoot, "Film-LAMA-tr-synced.srt");
        await writeFile(turkishPath, srt("Türkçe: Şimdi görüşürüz."));
        const analyse = async () =>
          analyseRenditionLibrary({
            paths,
            reserveBytes: 0,
            saveReport: false,
            driveSpace: { totalBytes: 1e12, freeBytes: 9e11 },
          });
        expect((await analyse()).items[0]?.adaptive.status).toBe("stale");
        expect(await build()).toMatchObject({ status: "ready" });
        const second = (await readTitlePackageManifest(titleRoot))!;
        expect(second.subtitle.map((track) => track.language).sort()).toEqual([
          "eng",
          "tur",
        ]);
        const publishedRoot = await resolvePublishedTitleRoot(titleRoot);
        const turkish = second.subtitle.find(
          (track) => track.language === "tur",
        )!;
        expect(turkish.mediaPath).toMatch(/^subtitle\/turkish.*\.vtt$/);
        expect(
          await readFile(path.join(publishedRoot, turkish.mediaPath), "utf8"),
        ).toContain("Türkçe: Şimdi görüşürüz.");
        expect(
          await readFile(
            path.join(publishedRoot, second.masterPlaylistPath),
            "utf8",
          ),
        ).toContain('LANGUAGE="tur"');
        for (const before of unchanged) {
          const track = [...second.video, ...second.audio].find(
            (track) => track.id === before.id,
          )!;
          const file = path.join(publishedRoot, track.mediaPath);
          expect((await stat(file)).mtimeMs).toBe(before.mtime);
          expect(
            createHash("sha256")
              .update(await readFile(file))
              .digest("hex"),
          ).toBe(before.hash);
        }
        expect((await analyse()).items[0]?.adaptive.status).toBe("ready");
        expect(await build()).toMatchObject({ status: "already-valid" });

        await writeFile(turkishPath, srt("Düzeltilmiş Türkçe."));
        expect((await analyse()).items[0]?.adaptive.status).toBe("stale");
        const fault = await rejectPublicationCommit(titleRoot);
        const failed = await build(fault.fileSystem, true);
        expect(failed.status).not.toBe("ready");
        expect(fault.rejected()).toBe(1);
        expect(await resolvePublishedTitleRoot(titleRoot)).toBe(publishedRoot);
        expect(
          await readFile(path.join(publishedRoot, turkish.mediaPath), "utf8"),
        ).toContain("Türkçe: Şimdi görüşürüz.");
        fault.restore();
        // The subtitle can be corrected again while a failed publication waits.
        // A verified scratch package for the old bytes must not win the retry.
        await writeFile(turkishPath, srt("Son Türkçe düzeltmesi."));
        expect(await build()).toMatchObject({ status: "ready" });
        const updated = (await readTitlePackageManifest(titleRoot))!;
        const updatedRoot = await resolvePublishedTitleRoot(titleRoot);
        expect(
          await readFile(
            path.join(
              updatedRoot,
              updated.subtitle.find((track) => track.language === "tur")!
                .mediaPath,
            ),
            "utf8",
          ),
        ).toContain("Son Türkçe düzeltmesi.");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
