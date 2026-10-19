/**
 * Recording an installed sidecar against its media file, so the player can
 * offer it.
 *
 * Without this the bytes are correct, correctly named and completely invisible
 * until the next library scan: the player's track list is built from
 * `media_streams`, and only a scan writes external rows. For a title whose
 * source has been removed it is worse than a delay — the scanner reads such a
 * title from its package and never rewrites its sidecar rows, so a subtitle
 * installed after the removal is never listed unless it is attached here.
 */

import path from "node:path";

import {
  discoverSidecarSubtitles,
  type SidecarSubtitle,
} from "../../../renditions/adaptive/sidecarSubtitles";
import { UNKNOWN_LANGUAGE } from "../../../renditions/processing/languages";

export interface SubtitleCatalogueAttachment {
  attachExternalSubtitle(input: {
    mediaFileId: string;
    relativePath: string;
    codec: string;
    isText: boolean;
    language: string | null;
    isForced: boolean;
  }): Promise<void>;
}

/** The codec name the catalogue uses for each installable sidecar format. */
const CODEC_BY_FORMAT: Record<"srt" | "vtt", string> = {
  srt: "subrip",
  vtt: "webvtt",
};

/**
 * Attaches one installed sidecar. Answers whether it did.
 *
 * Read back off the disk rather than assumed from what was just written: the
 * discovery is what decides a sidecar's language and forced flag everywhere
 * else, and a row written from the request would be the one row in the
 * catalogue that disagreed with the next scan. A failure is reported, never
 * thrown — the bytes are in place and correctly named either way.
 */
export async function attachInstalledSidecar(
  dependencies: {
    libraryRoot: string;
    catalogue: SubtitleCatalogueAttachment;
    discover?: typeof discoverSidecarSubtitles;
  },
  mediaFileId: string,
  relativeMedia: string,
  relativeSubtitle: string,
): Promise<boolean> {
  const discover = dependencies.discover ?? discoverSidecarSubtitles;
  const mediaDirectory = relativeMedia.split("/").slice(0, -1).join("/");
  // Joined with the platform's separator: the catalogue stores POSIX paths and
  // the media volume on the deployed host is `D:\media`.
  const absoluteMedia = path.join(
    dependencies.libraryRoot,
    ...relativeMedia.split("/"),
  );
  let found: SidecarSubtitle[];
  try {
    found = await discover(absoluteMedia);
  } catch {
    return false;
  }
  const name = relativeSubtitle.split("/").pop();
  const sidecar = found.find((entry) => entry.fileName === name);
  if (!sidecar) return false;
  const format = name?.endsWith(".vtt") ? "vtt" : "srt";
  try {
    await dependencies.catalogue.attachExternalSubtitle({
      mediaFileId,
      relativePath: mediaDirectory
        ? `${mediaDirectory}/${sidecar.fileName}`
        : sidecar.fileName,
      codec: CODEC_BY_FORMAT[format],
      isText: true,
      language: sidecar.language === UNKNOWN_LANGUAGE ? null : sidecar.language,
      isForced: sidecar.isForced,
    });
    return true;
  } catch {
    // The next library scan records a title whose source is present.
    return false;
  }
}
