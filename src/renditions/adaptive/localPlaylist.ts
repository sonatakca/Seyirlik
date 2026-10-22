import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A package playlist rewritten so FFmpeg can open it from anywhere.
 *
 * The packager writes each URI percent-encoded, because browsers fetch them
 * (see `playlistUri`). Rendition names are written for people and have spaces
 * in them — an HDR rung is `2160p HDR`, a kept original track is
 * `english (original)` — so a segment reads `2160p%20HDR.mp4`. FFmpeg opens a
 * local playlist's URIs as literal file names and never decodes them, so it
 * looked for a file called `2160p%20HDR.mp4` and failed. The copy names every
 * file by its decoded, absolute path; byte ranges and tags are unchanged.
 */
export function localPackagePlaylist(
  playlist: string,
  playlistDirectory: string,
): string {
  const localPath = (uri: string): string => {
    // Anything with a scheme is not a file beside the playlist.
    if (/^[a-z][a-z0-9+.-]+:/i.test(uri)) return uri;
    let decoded = uri;
    try {
      decoded = decodeURIComponent(uri);
    } catch {
      // A lone `%` is not an escape; the name is then exactly as written.
    }
    return path.resolve(playlistDirectory, ...decoded.split("/"));
  };
  return playlist
    .split("\n")
    .map((line) => {
      const content = line.trim();
      if (content === "") return line;
      if (content.startsWith("#")) {
        return line.replace(
          /URI="([^"]*)"/g,
          (_, uri: string) => `URI="${localPath(uri)}"`,
        );
      }
      return localPath(content);
    })
    .join("\n");
}

export interface LocalPlaylistCopy {
  /** The copy, under the same file name as the playlist it was made from. */
  path: string;
  remove(): Promise<void>;
}

/**
 * Writes `localPackagePlaylist` of a package playlist into local temp storage.
 *
 * Local rather than beside the original, which is on the media volume; the
 * caller removes it once FFmpeg is done with it, however that went.
 */
export async function writeLocalPackagePlaylist(
  playlistPath: string,
): Promise<LocalPlaylistCopy> {
  const playlist = await readFile(playlistPath, "utf8");
  const directory = await mkdtemp(path.join(tmpdir(), "seyirlik-playlist-"));
  const remove = () =>
    rm(directory, { recursive: true, force: true }).catch(() => undefined);
  try {
    const copyPath = path.join(directory, path.basename(playlistPath));
    await writeFile(
      copyPath,
      localPackagePlaylist(playlist, path.dirname(playlistPath)),
    );
    return { path: copyPath, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
