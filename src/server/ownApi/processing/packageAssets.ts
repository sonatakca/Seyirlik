import { stat } from "node:fs/promises";
import path from "node:path";

import type { TitlePackageManifest } from "../../../renditions/adaptive/publishTitle";
import { isPathInsideRoot } from "../../pathSecurity";

/**
 * One file a package's manifest claims and the disk does not have.
 *
 * `qualityHeight` is set only for a video rendition's media file, because that
 * is the one kind of damage the system can repair by itself: a rung whose bytes
 * are gone can be encoded again from the source, and every other kind needs a
 * person to look.
 */
export interface MissingPackageAsset {
  /** Path inside the title root, spelled as the manifest spells it. */
  relativePath: string;
  reason: "absent" | "size";
  qualityHeight?: number;
  expectedBytes?: number;
  actualBytes?: number;
}

/**
 * Every file the manifest claims, checked against what is actually on disk.
 *
 * A manifest is only a record of what publishing meant to leave behind: an
 * interrupted swap, a copy that stopped short, or a hand-deleted rendition
 * leaves it describing files that are no longer there, or no longer whole.
 * Sizes are compared as well as existence, because a truncated media file still
 * opens, still plays, and simply ends early — which is the failure that reaches
 * a viewer with nothing in any log to explain it.
 *
 * Read before a source file is deleted, which is the one action here that
 * cannot be taken back, and when a single title is analysed on demand. It is
 * deliberately not read by the background package index: that sweeps the whole
 * library on a clock, and this is a stat per rendition against a spinning disk.
 *
 * `sizeOf` answers for a place other than this disk — Drive itself, when a
 * helper checks that an upload holds every file before the source goes.
 */
export async function missingPackageAssets(
  titleRoot: string,
  manifest: TitlePackageManifest,
  sizeOf: (absolutePath: string) => Promise<number | undefined> = statSize,
): Promise<MissingPackageAsset[]> {
  const expected: Array<{
    relativePath: string;
    sizeBytes?: number;
    qualityHeight?: number;
  }> = [
    { relativePath: manifest.masterPlaylistPath },
    ...manifest.video.flatMap((rendition) => [
      {
        relativePath: rendition.mediaPath,
        sizeBytes: rendition.fileSizeBytes,
        qualityHeight: rendition.qualityHeight,
      },
      {
        relativePath: rendition.playlistPath,
        qualityHeight: rendition.qualityHeight,
      },
    ]),
    ...[...manifest.audio, ...manifest.subtitle].flatMap((rendition) => [
      { relativePath: rendition.mediaPath, sizeBytes: rendition.fileSizeBytes },
      { relativePath: rendition.playlistPath },
    ]),
  ];

  const missing: MissingPackageAsset[] = [];
  for (const entry of expected) {
    const absolutePath = path.resolve(
      titleRoot,
      ...entry.relativePath.split("/"),
    );
    // The manifest is a file on disk like any other, so its paths are treated
    // as data rather than as instructions about what to open.
    if (!isPathInsideRoot(titleRoot, absolutePath)) {
      missing.push({
        relativePath: entry.relativePath,
        reason: "absent",
        ...(entry.qualityHeight === undefined
          ? {}
          : { qualityHeight: entry.qualityHeight }),
      });
      continue;
    }
    const size = await sizeOf(absolutePath);
    if (size === undefined) {
      missing.push({
        relativePath: entry.relativePath,
        reason: "absent",
        ...(entry.qualityHeight === undefined
          ? {}
          : { qualityHeight: entry.qualityHeight }),
      });
      continue;
    }
    if (entry.sizeBytes !== undefined && size !== entry.sizeBytes) {
      missing.push({
        relativePath: entry.relativePath,
        reason: "size",
        expectedBytes: entry.sizeBytes,
        actualBytes: size,
        ...(entry.qualityHeight === undefined
          ? {}
          : { qualityHeight: entry.qualityHeight }),
      });
    }
  }
  return missing;
}

/** A regular file's size, or undefined when there is none to measure. */
async function statSize(absolutePath: string): Promise<number | undefined> {
  try {
    const stats = await stat(absolutePath);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

/** How many damaged files a message names before it stops listing them. */
const NAMED_LIMIT = 3;

/**
 * The damage, in words an operator can act on.
 *
 * A count alone — "1 of its files are missing or the wrong size" — names
 * neither the file nor the discrepancy, which for the one message standing
 * between an operator and a lost source is the whole of what they need.
 */
export function describeMissingPackageAssets(
  missing: readonly MissingPackageAsset[],
  where = "on disk",
): string {
  const named = missing
    .slice(0, NAMED_LIMIT)
    .map((asset) =>
      asset.reason === "size"
        ? `${asset.relativePath} is ${asset.actualBytes} bytes ${where}, and the package records ${asset.expectedBytes}`
        : `${asset.relativePath} is not ${where}`,
    );
  const rest = missing.length - named.length;
  return rest > 0 ? `${named.join("; ")}; and ${rest} more` : named.join("; ");
}
