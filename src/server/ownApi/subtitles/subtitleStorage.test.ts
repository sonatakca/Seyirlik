import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSubtitleStorage,
  subtitleDigest,
  type SubtitleStorage,
} from "./subtitleStorage";
import type { SubtitlePayload } from "./subtitleProvider";

/**
 * The writer, against real directories on this machine's temporary storage.
 *
 * Real files rather than a mocked filesystem: every property this module exists
 * for — containment, no-clobber, ownership, the lock — is a property of what a
 * filesystem actually does, and a mock would only prove the mock agrees with
 * itself. The root is a temporary directory, so the suite runs identically on
 * macOS and on Windows and nothing here can reach a media volume.
 */

const SRT = ["1", "00:00:01,000 --> 00:00:03,500", "Merhaba.", "", ""].join(
  "\n",
);

const payloadOf = (text: string, declared: "srt" | "vtt" | null = "srt") =>
  ({
    bytes: new TextEncoder().encode(text),
    declaredFormat: declared,
    declaredFileName: null,
  }) satisfies SubtitlePayload;

const FLAGS = { forced: false, hearingImpaired: false };

describe("installing a subtitle beside media", () => {
  let root = "";
  let mediaRelative = "";
  let storage: SubtitleStorage;
  let owned = new Map<string, string>();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "seyirlik-subtitle-store-"));
    mediaRelative = "Movies/Dune (2021)/Dune (2021).mkv";
    await mkdir(path.join(root, "Movies", "Dune (2021)"), { recursive: true });
    await writeFile(path.join(root, ...mediaRelative.split("/")), "video");
    owned = new Map();
    storage = createSubtitleStorage({
      libraryRoot: root,
      resolveMedia: async () => mediaRelative,
      managedDigest: async (_id, relativePath) =>
        owned.get(relativePath) ?? null,
    });
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const install = (
    over: Partial<Parameters<SubtitleStorage["install"]>[0]> = {},
  ) =>
    storage.install({
      mediaFileId: "media-1",
      language: "tur",
      flags: FLAGS,
      payload: payloadOf(SRT),
      replace: false,
      ...over,
    });

  it("refuses a root that is not absolute", () => {
    expect(() =>
      createSubtitleStorage({
        libraryRoot: "relative/root",
        resolveMedia: async () => mediaRelative,
        managedDigest: async () => null,
      }),
    ).toThrow(/absolute/);
  });

  it("writes the subtitle beside the video, named the way the detector reads", async () => {
    const result = await install();
    expect(result).toMatchObject({
      outcome: "installed",
      relativePath: "Movies/Dune (2021)/Dune (2021).tur.srt",
    });
    const written = await readFile(
      path.join(root, "Movies", "Dune (2021)", "Dune (2021).tur.srt"),
      "utf8",
    );
    expect(written).toBe(SRT);
    if (result.outcome === "installed") {
      expect(result.sha256).toBe(subtitleDigest(new TextEncoder().encode(SRT)));
      expect(result.cueCount).toBe(1);
    }
  });

  it("carries the flags into the name", async () => {
    const result = await install({
      flags: { forced: true, hearingImpaired: true },
      language: "eng",
    });
    expect(result).toMatchObject({
      relativePath: "Movies/Dune (2021)/Dune (2021).eng.forced.sdh.srt",
    });
  });

  /* The subtitle the detector finds is the subtitle this wrote. */
  it("is found by the detector afterwards", async () => {
    await install();
    const tracks = await storage.inspect("media-1");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      language: "tur",
      origin: "external",
      format: "srt",
    });
  });

  it("leaves no temporary file behind", async () => {
    await install();
    const entries = await readdir(path.join(root, "Movies", "Dune (2021)"));
    expect(entries.filter((name) => name.includes(".tmp"))).toEqual([]);
    expect(entries.filter((name) => name.includes(".lock"))).toEqual([]);
  });

  describe("what it refuses to write", () => {
    it("refuses a catalogue path that climbs out of the root", async () => {
      mediaRelative = "../outside/film.mkv";
      expect(await install()).toMatchObject({
        outcome: "error",
        failure: "path-escape",
      });
    });

    it("refuses a catalogue path that is absolute", async () => {
      mediaRelative = "C:/Windows/System32/film.mkv";
      expect(await install()).toMatchObject({
        outcome: "error",
        failure: "path-escape",
      });
    });

    it("refuses a segment with a trailing dot or space", async () => {
      mediaRelative = "Movies/trailing. /film.mkv";
      expect(await install()).toMatchObject({
        outcome: "error",
        failure: "path-escape",
      });
    });

    /*
     * The link is created rather than described, because the property is that
     * the walk refuses it *before following it*. Creating one needs a
     * privilege Windows does not grant by default, so only the creation is
     * guarded — the assertion is the same wherever it can run.
     */
    it("refuses a link on the way to the media file", async () => {
      const real = path.join(root, "real");
      await mkdir(real, { recursive: true });
      await writeFile(path.join(real, "film.mkv"), "video");
      try {
        await symlink(real, path.join(root, "linked"), "dir");
      } catch {
        return; // No privilege to create one here; nothing to assert against.
      }
      mediaRelative = "linked/film.mkv";
      expect(await install()).toMatchObject({
        outcome: "error",
        failure: "path-escape",
      });
    });

    it("refuses when the media file's folder is not there", async () => {
      mediaRelative = "Movies/Missing/none.mkv";
      expect(await install()).toMatchObject({
        outcome: "error",
        failure: "media-missing",
      });
    });

    it("refuses a catalogue path that is not a video container", async () => {
      mediaRelative = "Movies/Dune (2021)/notes.txt";
      await writeFile(path.join(root, ...mediaRelative.split("/")), "x");
      expect(await install()).toMatchObject({
        outcome: "error",
        failure: "name-unrepresentable",
      });
    });

    it("refuses a language it cannot name a file after", async () => {
      expect(await install({ language: "und" })).toMatchObject({
        outcome: "error",
        failure: "name-unrepresentable",
      });
      expect(await install({ language: "turkish" })).toMatchObject({
        failure: "name-unrepresentable",
      });
    });

    it("refuses a payload that is a web page", async () => {
      expect(
        await install({
          payload: payloadOf("<!doctype html><html><body>login</body></html>"),
        }),
      ).toMatchObject({ outcome: "error", failure: "payload-invalid" });
    });

    it("refuses a format it does not install, as unsupported rather than invalid", async () => {
      const ass = "[Script Info]\nTitle: x\n\n[Events]\nDialogue: 0,0:00:01.00";
      expect(await install({ payload: payloadOf(ass, null) })).toMatchObject({
        outcome: "error",
        failure: "payload-unsupported-format",
      });
    });

    it("writes nothing when it refuses", async () => {
      await install({ payload: payloadOf("<html></html>") });
      const entries = await readdir(path.join(root, "Movies", "Dune (2021)"));
      expect(entries).toEqual(["Dune (2021).mkv"]);
    });
  });

  describe("what is already there", () => {
    it("reports a byte-identical subtitle as a duplicate without rewriting", async () => {
      const first = await install();
      expect(first.outcome).toBe("installed");
      const second = await install();
      expect(second).toMatchObject({ outcome: "duplicate" });
    });

    /*
     * The want is answered under a different name. Installing beside it would
     * leave two Turkish subtitles for one film, which is what a viewer sees as
     * a duplicate track.
     */
    it("refuses when that language is already subtitled under another name", async () => {
      await writeFile(
        path.join(root, "Movies", "Dune (2021)", "Dune (2021).türkçe.tur.srt"),
        SRT,
      );
      expect(await install()).toMatchObject({
        outcome: "error",
        failure: "destination-occupied",
      });
    });

    it("refuses to overwrite a subtitle it does not own", async () => {
      const target = path.join(
        root,
        "Movies",
        "Dune (2021)",
        "Dune (2021).tur.srt",
      );
      await writeFile(target, "1\n00:00:01,000 --> 00:00:02,000\nHand made.\n");
      expect(await install({ replace: true })).toMatchObject({
        outcome: "error",
        failure: "destination-occupied",
      });
      expect(await readFile(target, "utf8")).toContain("Hand made.");
    });

    /*
     * The one genuinely new ownership overlap in this phase. Both the importer
     * and this service write subtitles into the same folder, and they are
     * separated by evidence rather than by naming: a subtitle that arrived with
     * a download has no installation record, so it is refused — which also
     * means it cannot currently be upgraded. That is deliberate, and
     * `docs/library-file-ownership.md` says so.
     */
    it("will not replace a subtitle the importer placed", async () => {
      const target = path.join(
        root,
        "Movies",
        "Dune (2021)",
        "Dune (2021).tur.srt",
      );
      await writeFile(target, SRT);
      // Byte-identical, but no record: this service did not write it.
      expect(await install({ replace: true })).toMatchObject({
        outcome: "duplicate",
      });

      const different = SRT.replace("Merhaba.", "Selam.");
      expect(
        await install({ payload: payloadOf(different), replace: true }),
      ).toMatchObject({
        outcome: "error",
        failure: "destination-occupied",
      });
      expect(await readFile(target, "utf8")).toBe(SRT);
    });

    it("replaces one it does own, but only when asked to", async () => {
      const first = await install();
      expect(first.outcome).toBe("installed");
      if (first.outcome !== "installed") return;
      owned.set(first.relativePath, first.sha256);

      const better = SRT.replace("Merhaba.", "Merhaba dünya.");
      expect(await install({ payload: payloadOf(better) })).toMatchObject({
        outcome: "error",
        failure: "destination-occupied",
      });
      expect(
        await install({ payload: payloadOf(better), replace: true }),
      ).toMatchObject({ outcome: "installed" });
      expect(
        await readFile(
          path.join(root, ...first.relativePath.split("/")),
          "utf8",
        ),
      ).toContain("Merhaba dünya.");
    });
  });

  /*
   * The Sopranos, 2026-10-19: five episodes whose sources were removed once
   * their packages were whole could never be given a subtitle, because this
   * refused before a provider was asked. Their sidecars are served on their
   * own; only the folder the source lived in has to be real.
   */
  describe("a title whose source has been removed", () => {
    const season = ["Shows", "The Sopranos", "Season 1", "src"];
    const episode = (n: number) =>
      `The.Sopranos.S01E0${n}.1080p.BluRay.x264-UNIT3D`;

    beforeEach(async () => {
      await mkdir(path.join(root, ...season), { recursive: true });
      mediaRelative = [...season, `${episode(1)}.mkv`].join("/");
    });

    it("writes the sidecar where the source was, named after it", async () => {
      const result = await install();
      expect(result).toMatchObject({
        outcome: "installed",
        relativePath: [...season, `${episode(1)}.tur.srt`].join("/"),
      });
      expect(
        await readFile(path.join(root, ...season, `${episode(1)}.tur.srt`), {
          encoding: "utf8",
        }),
      ).toBe(SRT);
      const entries = await readdir(path.join(root, ...season));
      expect(entries).toEqual([`${episode(1)}.tur.srt`]);
    });

    /*
     * With every source gone the folder holds no video at all, and the rule
     * that a lone video owns every subtitle beside it would have handed this
     * episode the next one's translation — and called the want satisfied.
     */
    it("does not mistake another episode's sidecar for this one's", async () => {
      await writeFile(path.join(root, ...season, `${episode(2)}.tur.srt`), SRT);
      expect(await storage.inspect("media-1")).toEqual([]);
      expect(await install()).toMatchObject({ outcome: "installed" });
      expect(await storage.inspect("media-1")).toEqual([
        expect.objectContaining({
          relativePath: [...season, `${episode(1)}.tur.srt`].join("/"),
        }),
      ]);
    });

    it("still finds its own sidecar, so a want it answers is not repeated", async () => {
      await writeFile(
        path.join(root, ...season, `${episode(1)}.tr.srt`),
        SRT.replace("Merhaba.", "Selam."),
      );
      expect(await install()).toMatchObject({
        outcome: "error",
        failure: "destination-occupied",
      });
    });

    it("reads and rewrites a sidecar beside the absent source", async () => {
      const first = await install();
      if (first.outcome !== "installed") throw new Error(first.outcome);
      expect(
        new TextDecoder().decode(
          await storage.read("media-1", first.relativePath),
        ),
      ).toBe(SRT);
      const later = SRT.replace("00:00:01,000", "00:00:02,000");
      expect(
        await storage.rewrite({
          mediaFileId: "media-1",
          relativePath: first.relativePath,
          bytes: new TextEncoder().encode(later),
          expectedSha256: first.sha256,
        }),
      ).toMatchObject({ outcome: "installed" });
    });

    it("refuses something that is not a file at the source's name", async () => {
      await mkdir(path.join(root, ...season, `${episode(1)}.mkv`));
      expect(await install()).toMatchObject({
        outcome: "error",
        failure: "media-missing",
      });
    });

    it("refuses a link at the source's name", async () => {
      await writeFile(path.join(root, "elsewhere.mkv"), "video");
      try {
        await symlink(
          path.join(root, "elsewhere.mkv"),
          path.join(root, ...season, `${episode(1)}.mkv`),
        );
      } catch {
        return; // No privilege to create one here; nothing to assert against.
      }
      expect(await install()).toMatchObject({
        outcome: "error",
        failure: "path-escape",
      });
    });
  });

  describe("being interrupted", () => {
    it("stops before committing when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      expect(await install({ signal: controller.signal })).toMatchObject({
        outcome: "cancelled",
      });
      const entries = await readdir(path.join(root, "Movies", "Dune (2021)"));
      expect(entries).toEqual(["Dune (2021).mkv"]);
    });

    /*
     * Two writers for one media file. The loser is told the outcome is
     * ambiguous rather than being allowed to guess the winner is dead and
     * steal the lock, which is how both end up writing.
     */
    it("lets only one writer hold a media file at a time", async () => {
      const slowStorage = createSubtitleStorage({
        libraryRoot: root,
        resolveMedia: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return mediaRelative;
        },
        managedDigest: async () => null,
      });
      const request = {
        mediaFileId: "media-1",
        language: "tur",
        flags: FLAGS,
        payload: payloadOf(SRT),
        replace: false,
      };
      const [a, b] = await Promise.all([
        slowStorage.install(request),
        slowStorage.install({ ...request, language: "eng" }),
      ]);
      const outcomes = [a.outcome, b.outcome].sort();
      expect(outcomes).toEqual(["error", "installed"]);
      const loser = a.outcome === "error" ? a : b;
      expect(loser).toMatchObject({ failure: "commit-ambiguous" });
    });
  });
});
