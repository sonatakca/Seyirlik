import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localPackagePlaylist,
  writeLocalPackagePlaylist,
} from "./localPlaylist";

describe("a package playlist FFmpeg can open", () => {
  const directory = path.resolve("/media/Show/.seyirlik/video");

  it("decodes each URI and resolves it against the playlist's own folder", () => {
    const copy = localPackagePlaylist(
      [
        "#EXTM3U",
        '#EXT-X-MAP:URI="../../video/2160p%20HDR.mp4",BYTERANGE="900@0"',
        "#EXTINF:6.0,",
        "#EXT-X-BYTERANGE:100@900",
        "../../video/2160p%20HDR.mp4",
        "",
      ].join("\n"),
      directory,
    );
    const media = path.resolve("/media/Show/video/2160p HDR.mp4");

    expect(copy).toBe(
      [
        "#EXTM3U",
        `#EXT-X-MAP:URI="${media}",BYTERANGE="900@0"`,
        "#EXTINF:6.0,",
        "#EXT-X-BYTERANGE:100@900",
        media,
        "",
      ].join("\n"),
    );
  });

  it("decodes a kept original audio track's name, parentheses and all", () => {
    expect(
      localPackagePlaylist(
        "../../audio/english%20(original).m4a",
        path.resolve("/media/Show/.seyirlik/audio"),
      ),
    ).toBe(path.resolve("/media/Show/audio/english (original).m4a"));
  });

  it("leaves a name that is not an escape exactly as written", () => {
    expect(localPackagePlaylist("100%.mp4", directory)).toBe(
      path.resolve(directory, "100%.mp4"),
    );
  });
});

/*
 * MSI's worker, as it was on 2026-10-23: FFmpeg 8.1's HLS demuxer refused the
 * backslash spellings of these paths with "No such file or directory" and
 * opened the forward-slash ones.
 */
describe("a package playlist FFmpeg can open on Windows", () => {
  it("writes a share path with forward slashes", () => {
    expect(
      localPackagePlaylist(
        [
          '#EXT-X-MAP:URI="../../video/2160p%20HDR.mp4",BYTERANGE="994@0"',
          "../../video/2160p%20HDR.mp4",
        ].join("\n"),
        "\\\\seyirlik\\drive\\media\\Series\\House of the Dragon\\Season 1\\House of the Dragon - S01E09\\.seyirlik\\video",
        path.win32,
      ),
    ).toBe(
      [
        '#EXT-X-MAP:URI="//seyirlik/drive/media/Series/House of the Dragon/Season 1/House of the Dragon - S01E09/video/2160p HDR.mp4",BYTERANGE="994@0"',
        "//seyirlik/drive/media/Series/House of the Dragon/Season 1/House of the Dragon - S01E09/video/2160p HDR.mp4",
      ].join("\n"),
    );
  });

  it("writes a drive-letter path with forward slashes", () => {
    expect(
      localPackagePlaylist(
        "../../audio/english%20(original).m4a",
        "D:\\media\\Movies\\Film (2024)\\.seyirlik\\audio",
        path.win32,
      ),
    ).toBe("D:/media/Movies/Film (2024)/audio/english (original).m4a");
  });
});

describe("writing the copy", () => {
  const roots: string[] = [];
  afterEach(async () => {
    while (roots.length > 0) {
      await rm(roots.pop() as string, { recursive: true, force: true });
    }
  });

  it("writes it under the playlist's own name outside the package, and removes it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "local-playlist-"));
    roots.push(root);
    const playlistPath = path.join(
      root,
      "Show",
      ".seyirlik",
      "audio",
      "english (original).m3u8",
    );
    await mkdir(path.dirname(playlistPath), { recursive: true });
    await writeFile(playlistPath, "../../audio/english%20(original).m4a\n");

    const copy = await writeLocalPackagePlaylist(playlistPath);

    expect(path.basename(copy.path)).toBe("english (original).m3u8");
    expect(copy.path.startsWith(root)).toBe(false);
    expect(await readFile(copy.path, "utf8")).toBe(
      `${path
        .join(root, "Show", "audio", "english (original).m4a")
        .split(path.sep)
        .join("/")}\n`,
    );
    await copy.remove();
    await expect(readFile(copy.path, "utf8")).rejects.toThrow();
  });

  it("makes nothing when the playlist cannot be read", async () => {
    await expect(
      writeLocalPackagePlaylist(
        path.join(tmpdir(), "no-such-folder", "absent.m3u8"),
      ),
    ).rejects.toThrow();
  });
});
