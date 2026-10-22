import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSubtitleUploader } from "./subtitleUpload";
import type { RecordInstallationInput } from "./subtitleRepository";

/**
 * A person's own subtitle, against real directories.
 *
 * Real files rather than a mocked filesystem, for the same reason the storage
 * suite uses them: what this feature promises is where a file ends up and what
 * it is called, and only a filesystem can answer that.
 */

const SRT = [
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "Merhaba dünya.",
  "",
  "2",
  "00:00:04,000 --> 00:00:06,000",
  "İyi seyirler.",
  "",
  "",
].join("\n");

const MEDIA = "Movies/Dune (2021)/Dune (2021).mkv";

describe("uploading a subtitle by hand", () => {
  let root = "";
  let installs: RecordInstallationInput[] = [];
  let attached: Array<Record<string, unknown>> = [];
  let files: string[] = [];
  let owned = new Map<string, string>();

  const uploader = () =>
    createSubtitleUploader({
      libraryRoot: root,
      catalogue: {
        attachExternalSubtitle: async (input) => {
          attached.push(input);
        },
      },
      repository: {
        titleMediaFiles: async () => files,
        mediaFileRelativePath: async () => MEDIA,
        managedDigest: async (_id, relative) => owned.get(relative) ?? null,
        recordInstallation: async (input) => {
          installs.push(input);
          owned.set(input.relativePath, input.sha256);
          return "installation-1";
        },
      },
    });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "seyirlik-subtitle-upload-"));
    await mkdir(path.join(root, "Movies", "Dune (2021)"), { recursive: true });
    await writeFile(path.join(root, ...MEDIA.split("/")), "video");
    installs = [];
    attached = [];
    owned = new Map();
    files = ["file-1"];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const upload = (
    text: string | Uint8Array,
    over: { language?: string; forced?: boolean; replace?: boolean } = {},
  ) =>
    uploader().upload({
      itemId: "item-1",
      language: over.language ?? "tur",
      forced: over.forced ?? false,
      hearingImpaired: false,
      replace: over.replace ?? false,
      bytes: typeof text === "string" ? new TextEncoder().encode(text) : text,
    });

  it("files the subtitle beside the film, named after it", async () => {
    const result = await upload(SRT);

    expect(result).toMatchObject({
      outcome: "installed",
      relativePath: "Movies/Dune (2021)/Dune (2021).tur.srt",
      fileName: "Dune (2021).tur.srt",
      cueCount: 2,
    });
    expect(
      await readFile(
        path.join(root, "Movies", "Dune (2021)", "Dune (2021).tur.srt"),
        "utf8",
      ),
    ).toContain("Merhaba dünya.");
  });

  it("marks a forced track in the name the detector already reads", async () => {
    const result = await upload(SRT, { forced: true });

    expect(result).toMatchObject({
      relativePath: "Movies/Dune (2021)/Dune (2021).tur.forced.srt",
    });
  });

  /*
   * The case the strict UTF-8 validator gets wrong for a person's own file.
   * Turkish subtitles in the wild are overwhelmingly Windows-1254, and refusing
   * them would make this feature useless for the library it is for.
   */
  it("accepts a Windows-1254 Turkish subtitle and stores it as UTF-8", async () => {
    /*
     * The two bytes that matter: 0xFC is `ü` and 0xDD is `İ` in Windows-1254,
     * and 0xDD is `Ý` in every other common single-byte page — so decoding this
     * correctly is a decision the chosen language makes, not a guess.
     */
    const bytes = Buffer.from(
      SRT.replace("dünya", "d\xfcnya").replace("İyi", "\xddyi"),
      "binary",
    );

    const result = await upload(new Uint8Array(bytes));

    expect(result.outcome).toBe("installed");
    const written = await readFile(
      path.join(root, "Movies", "Dune (2021)", "Dune (2021).tur.srt"),
      "utf8",
    );
    expect(written).toContain("dünya");
    expect(written).toContain("İyi");
  });

  it("records the file as this system's, so a corrected one can replace it", async () => {
    await upload(SRT);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      relativePath: "Movies/Dune (2021)/Dune (2021).tur.srt",
      language: "tur",
      format: "srt",
      wantId: null,
      attemptId: null,
      providerId: null,
    });

    const corrected = SRT.replace("Merhaba dünya.", "Selam dünya.");
    const second = await upload(corrected, { replace: true });

    expect(second.outcome).toBe("installed");
    expect(
      await readFile(
        path.join(root, "Movies", "Dune (2021)", "Dune (2021).tur.srt"),
        "utf8",
      ),
    ).toContain("Selam dünya.");
  });

  it("refuses to overwrite a subtitle it did not write", async () => {
    await writeFile(
      path.join(root, "Movies", "Dune (2021)", "Dune (2021).tur.srt"),
      "1\n00:00:01,000 --> 00:00:02,000\nSomebody else's.\n\n",
    );

    const result = await upload(SRT, { replace: true });

    expect(result).toMatchObject({
      outcome: "error",
      failure: "destination-occupied",
    });
  });

  it("calls a byte-identical upload a duplicate rather than a write", async () => {
    await upload(SRT);
    const again = await upload(SRT);

    expect(again.outcome).toBe("duplicate");
    // A duplicate is not a second installation.
    expect(installs).toHaveLength(1);
  });

  it("records the sidecar so the player can offer it at once", async () => {
    await upload(SRT);

    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({
      mediaFileId: "file-1",
      relativePath: "Movies/Dune (2021)/Dune (2021).tur.srt",
      codec: "subrip",
      isText: true,
      language: "tur",
      isForced: false,
    });
  });

  /*
   * A processed title whose source was removed keeps its catalogue row and its
   * package. The subtitle goes where the source was and is listed at once —
   * the scan reads such a title from its package and would never list it.
   */
  it("files a subtitle for a title whose source has been removed", async () => {
    await rm(path.join(root, ...MEDIA.split("/")));

    expect(await upload(SRT)).toMatchObject({
      outcome: "installed",
      relativePath: "Movies/Dune (2021)/Dune (2021).tur.srt",
      attached: true,
    });
    expect(attached).toEqual([
      expect.objectContaining({
        relativePath: "Movies/Dune (2021)/Dune (2021).tur.srt",
        language: "tur",
      }),
    ]);
  });

  it("refuses a title whose files it cannot tell apart", async () => {
    files = ["file-1", "file-2"];

    const result = await upload(SRT);

    expect(result).toMatchObject({
      outcome: "error",
      failure: "ambiguous-title",
    });
  });

  it("refuses a title with no playable file", async () => {
    files = [];

    expect(await upload(SRT)).toMatchObject({
      outcome: "error",
      failure: "media-missing",
    });
  });

  /* The commonest hostile upload is not malicious, it is a saved web page. */
  it("refuses something that is not a subtitle", async () => {
    const result = await upload(
      "<!doctype html><html><body>Sign in</body></html>",
    );

    expect(result.outcome).toBe("error");
    expect(installs).toHaveLength(0);
  });

  it("refuses an ASS subtitle rather than installing styling it cannot own", async () => {
    const result = await upload(
      "[Script Info]\nTitle: x\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hi\n",
    );

    expect(result).toMatchObject({
      outcome: "error",
      failure: "payload-unsupported-format",
    });
  });
});
