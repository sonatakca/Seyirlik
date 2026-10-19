/**
 * A subtitle a person hands over, rather than one a provider was asked for.
 *
 * The searching subsystem exists because finding a subtitle is slow, uncertain
 * and worth retrying. None of that is true of a file somebody already has: they
 * know which title it belongs to and which language it is, and they want an
 * answer now. So this is a plain request-scoped operation with an immediate
 * result — no want, no attempt, no state machine, no queue.
 *
 * What it deliberately does **not** do differently is write. The destination is
 * derived by the same storage writer the pipeline uses, from the media file the
 * catalogue id resolves to, so an upload cannot name a path, cannot leave the
 * configured root, cannot clobber a file this system does not own, and lands
 * under the same `<stem>.<lang>[.forced][.sdh].<format>` name the detector, the
 * packager and the player already read.
 */

import { discoverSidecarSubtitles } from "../../../renditions/adaptive/sidecarSubtitles";
import { toUtf8 } from "./subtitleArchive";
import {
  attachInstalledSidecar,
  type SubtitleCatalogueAttachment,
} from "./subtitleAttachment";
import type { SubtitleRepository } from "./subtitleRepository";
import {
  createSubtitleStorage,
  type SubtitleInstallOutcome,
  type SubtitleStorage,
  type SubtitleStorageOptions,
} from "./subtitleStorage";

/** What a caller may say about the file it is handing over. */
export interface SubtitleUploadRequest {
  /** The catalogue item — a film or one episode, never a whole show. */
  readonly itemId: string;
  /** Already normalised to ISO 639-2 by the route. */
  readonly language: string;
  readonly forced: boolean;
  readonly hearingImpaired: boolean;
  /** Permission to overwrite a subtitle this system installed. Never another. */
  readonly replace: boolean;
  readonly bytes: Uint8Array;
}

export type SubtitleUploadResult =
  | {
      readonly outcome: "installed" | "duplicate";
      readonly relativePath: string;
      /** The file's name alone, which is the part a person recognises. */
      readonly fileName: string;
      readonly language: string;
      readonly cueCount: number | null;
      /** Whether the player can offer it without waiting for a library scan. */
      readonly attached: boolean;
    }
  | {
      readonly outcome: "error";
      readonly failure: string;
      readonly reason: string;
    };

export type { SubtitleCatalogueAttachment };

export interface SubtitleUploader {
  upload(request: SubtitleUploadRequest): Promise<SubtitleUploadResult>;
}

export function createSubtitleUploader(dependencies: {
  libraryRoot: string;
  repository: Pick<
    SubtitleRepository,
    "titleMediaFiles" | "managedDigest" | "recordInstallation"
  > & {
    mediaFileRelativePath(mediaFileId: string): Promise<string | null>;
  };
  catalogue?: SubtitleCatalogueAttachment;
  storageFactory?: (options: SubtitleStorageOptions) => SubtitleStorage;
  discover?: typeof discoverSidecarSubtitles;
}): SubtitleUploader {
  const { libraryRoot, repository } = dependencies;

  return {
    async upload(request) {
      /*
       * One file, named by the caller's item. A show has many, and choosing one
       * of them on the caller's behalf would file the subtitle against whichever
       * episode happened to sort first.
       */
      const files = await repository.titleMediaFiles(request.itemId);
      if (files.length === 0) {
        return {
          outcome: "error",
          failure: "media-missing",
          reason: "This title has no playable file to put a subtitle beside.",
        };
      }
      if (files.length > 1) {
        return {
          outcome: "error",
          failure: "ambiguous-title",
          reason:
            "This title has more than one file. Upload the subtitle from the episode it belongs to.",
        };
      }
      const mediaFileId = files[0] as string;
      const relativeMedia = await repository.mediaFileRelativePath(mediaFileId);
      if (relativeMedia === null) {
        return {
          outcome: "error",
          failure: "media-missing",
          reason: "The catalogue has no path for this title's file.",
        };
      }

      const storage = (dependencies.storageFactory ?? createSubtitleStorage)({
        libraryRoot,
        resolveMedia: async (id) => {
          if (id !== mediaFileId) throw new Error("Unknown subtitle media ID.");
          return relativeMedia;
        },
        managedDigest: (id, relative) => repository.managedDigest(id, relative),
      });

      /*
       * Decoded before validation, not instead of it.
       *
       * The validator accepts UTF-8 only and must not guess, which is right for
       * a provider's bytes. A person's own file is the case the strictness gets
       * wrong: Turkish subtitles in the wild are overwhelmingly Windows-1254,
       * and refusing them would make this feature useless for exactly the
       * library it is for. The language the person chose is what makes this a
       * decision rather than a guess.
       */
      const bytes = toUtf8(request.bytes, request.language);

      let installed: SubtitleInstallOutcome;
      try {
        installed = await storage.install({
          mediaFileId,
          language: request.language,
          flags: {
            forced: request.forced,
            hearingImpaired: request.hearingImpaired,
          },
          payload: { bytes, declaredFormat: null, declaredFileName: null },
          replace: request.replace,
        });
      } catch (error) {
        return {
          outcome: "error",
          failure: "storage",
          reason:
            error instanceof Error
              ? error.message
              : "The subtitle was not written.",
        };
      }

      if (installed.outcome === "error") {
        return {
          outcome: "error",
          failure: installed.failure,
          reason: installed.reason,
        };
      }
      if (installed.outcome === "cancelled") {
        return {
          outcome: "error",
          failure: "cancelled",
          reason: "The upload was cancelled.",
        };
      }

      const fileName =
        installed.relativePath.split("/").pop() ?? installed.relativePath;

      if (installed.outcome === "installed") {
        /*
         * The receipt that makes this file ours, so a corrected version can be
         * uploaded over it later. Recorded after the rename rather than before,
         * because the digest is of the bytes that landed: a crash in the gap
         * leaves a correct subtitle nobody owns, which reads exactly like one
         * that arrived with a download and is refused rather than overwritten.
         */
        await repository.recordInstallation({
          mediaFileId,
          wantId: null,
          attemptId: null,
          relativePath: installed.relativePath,
          language: request.language,
          forced: request.forced,
          hearingImpaired: request.hearingImpaired,
          // The writer named the file after the format it proved the bytes are.
          format: fileName.endsWith(".vtt") ? "vtt" : "srt",
          sha256: installed.sha256,
          sizeBytes: bytes.length,
          cueCount: installed.cueCount,
          providerId: null,
          syncState: "unknown",
        });
      }

      const attached = await attach(
        mediaFileId,
        relativeMedia,
        installed.relativePath,
      );

      return {
        outcome: installed.outcome,
        relativePath: installed.relativePath,
        fileName,
        language: request.language,
        cueCount: installed.outcome === "installed" ? installed.cueCount : null,
        attached,
      };
    },
  };

  /** The one row that lets the player list this track. */
  async function attach(
    mediaFileId: string,
    relativeMedia: string,
    relativeSubtitle: string,
  ): Promise<boolean> {
    if (!dependencies.catalogue) return false;
    return attachInstalledSidecar(
      {
        libraryRoot,
        catalogue: dependencies.catalogue,
        ...(dependencies.discover ? { discover: dependencies.discover } : {}),
      },
      mediaFileId,
      relativeMedia,
      relativeSubtitle,
    );
  }
}
