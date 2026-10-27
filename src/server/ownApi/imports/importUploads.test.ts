// @vitest-environment node
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DriveUploadTracker } from "../processing/driveUpload";
import type { ImportFileRecord } from "./importRepository";
import { followImportUploads } from "./importUploads";

function file(over: Partial<ImportFileRecord>): ImportFileRecord {
  return {
    id: "file-1",
    importId: "import-1",
    role: "media",
    sourceRelative: "seyirlik-1/Arcane.S01E09.mkv",
    destinationRelative: "Arcane/Season 1/src/Arcane - S01E09.mkv",
    state: "committed",
    sizeBytes: 7_603_618_701,
    ...over,
  };
}

describe("following an import up to Drive", () => {
  it("follows each committed media file at its place in the library", async () => {
    const track = vi.fn(async () => true);
    const tracker = { track } as unknown as DriveUploadTracker;
    const libraryRoot = path.resolve("/drive/media/Series");

    const followed = await followImportUploads(tracker, { libraryRoot }, [
      file({}),
      // Kilobytes, and not what decides when the episode is on Drive.
      file({
        id: "file-2",
        role: "subtitle",
        destinationRelative: "Arcane/Season 1/src/Arcane - S01E09.tur.srt",
      }),
      // Not in the library, so nothing of it is uploading.
      file({ id: "file-3", state: "failed" }),
    ]);

    expect(followed).toBe(1);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith({
      processingJobId: "file-1",
      file: path.join(
        libraryRoot,
        "Arcane",
        "Season 1",
        "src",
        "Arcane - S01E09.mkv",
      ),
      totalBytes: 7_603_618_701,
    });
  });

  it("does not fail the import when a file cannot be followed", async () => {
    const tracker = {
      track: vi.fn(async () => {
        throw new Error("rclone is restarting");
      }),
    } as unknown as DriveUploadTracker;
    await expect(
      followImportUploads(tracker, { libraryRoot: "/library" }, [file({})]),
    ).resolves.toBe(0);
  });
});
