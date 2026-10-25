import type { DatabasePool } from "../database/databasePool";
import { createJobQueue } from "../tasks/jobQueue";
import type { PlaybackRefreshBoundary } from "../playback/playbackRefresh";
import type { SubtitleCatalogueAttachment } from "./subtitleAttachment";
import type { SubtitleConfig } from "./subtitleConfig";
import { readFile } from "node:fs/promises";
import { createSubtitleFitter } from "./subtitleFit";
import type { TitleReferences } from "./subtitleReferences";
import { createSubtitleExecutionRepository } from "./subtitleExecution";
import { createSubtitleJobHandlers, SUBTITLE_JOB_TYPES } from "./subtitleJobs";
import type {
  ProviderSessionManager,
  SubtitleProvider,
} from "./subtitleProvider";
import { createSubtitleRepository } from "./subtitleRepository";
import { createSubtitleService } from "./subtitleService";
import {
  createSubtitleSyncService,
  type SubtitleSyncCatalogue,
} from "./subtitleSync";
import { createSubtitleStorage } from "./subtitleStorage";

/**
 * What to answer when no interactive session host is wired in.
 *
 * A provider needing a browser session, on a server with nowhere to show one,
 * is not a failure and not an error — it is a request that cannot proceed until
 * somebody attends to it. Answering `needs-authentication` keeps the attempt in
 * the resumable state, so wiring a session host in later resumes the work
 * rather than requiring it to be started again.
 *
 * The alternative — throwing, or pretending a session exists — would turn every
 * such provider into a permanent failure on a headless deployment.
 */
export function unattendedSessionManager(): ProviderSessionManager {
  return {
    acquire: async (providerId) => ({
      outcome: "needs-authentication",
      providerId,
      reason: "Interactive authentication is not configured.",
      authenticateAt: null,
    }),
    invalidate: async () => {},
  };
}

export function disabledSubtitleJobTypes(
  config: SubtitleConfig | undefined,
): string[] {
  return config ? [] : Object.values(SUBTITLE_JOB_TYPES);
}

/** No configuration means no construction, database queries, handlers or I/O. */
export function createSubtitleRuntime(options: {
  config?: SubtitleConfig;
  pool: DatabasePool;
  providers?: readonly SubtitleProvider[];
  sessions?: ProviderSessionManager;
  playback?: PlaybackRefreshBoundary;
  onFilesChanged?: (relativePath: string) => Promise<void>;
  /** Records an installed sidecar so the player lists it without a scan. */
  catalogue?: SubtitleCatalogueAttachment;
  /**
   * What syncing needs and searching does not: the catalogue's own view of a
   * file's tracks, and an FFmpeg to read the ones that are inside it. Absent on
   * a deployment that has neither, which leaves the sync routes unmounted and
   * the job type refused rather than half-built.
   */
  sync?: {
    catalogue: SubtitleSyncCatalogue;
    ffmpegPath: string;
  };
  /**
   * What a title can be timed against — its package's audio and original
   * subtitles, or the source's before it is packaged — so a search installs the
   * candidate that fits best and a retiming never needs the source.
   */
  references?: TitleReferences;
}) {
  if (!options.config) return undefined;
  const providers = options.providers ?? [];
  if (
    options.config.providerIds.some(
      (id) => !providers.some((provider) => provider.id === id),
    )
  )
    throw new Error("A configured subtitle provider is not registered.");
  const sessions: ProviderSessionManager =
    options.sessions ?? unattendedSessionManager();
  const repository = createSubtitleRepository(options.pool);
  const config = options.config;
  const service = createSubtitleService({
    config,
    execution: createSubtitleExecutionRepository(options.pool),
    providers,
    sessions,
    playback: options.playback,
    onFilesChanged: options.onFilesChanged,
    ...(options.catalogue ? { catalogue: options.catalogue } : {}),
    ...(options.references && options.sync
      ? {
          fit: async ({ mediaFileId, relativePath, signal }) => {
            const references = options.references!;
            const target = { mediaFileId, relativePath };
            const [audio, embedded] = await Promise.all([
              references.audio(target).catch(() => null),
              references.embeddedSubtitles(target).catch(() => []),
            ]);
            const subtitles = (
              await Promise.all(
                embedded.map((subtitle) =>
                  readFile(subtitle.path, "utf8").catch(() => null),
                ),
              )
            ).filter((text): text is string => text !== null);
            return audio || subtitles.length > 0
              ? createSubtitleFitter({
                  ffmpegPath: options.sync!.ffmpegPath,
                  audio,
                  subtitles,
                  signal,
                })
              : null;
          },
        }
      : {}),
  });
  const sync = options.sync
    ? createSubtitleSyncService({
        libraryRoot: config.libraryRoot,
        ffmpegPath: options.sync.ffmpegPath,
        catalogue: options.sync.catalogue,
        repository,
        /*
         * A writer bound to the one media file the request named. The storage
         * module resolves every destination through `resolveMedia`, so binding
         * it here is what keeps a sync unable to reach any other title's files
         * even if a catalogue row were wrong about which video it belongs to.
         */
        storageFactory: (relativeMedia, mediaFileId) =>
          createSubtitleStorage({
            libraryRoot: config.libraryRoot,
            resolveMedia: async (id) => {
              if (id !== mediaFileId)
                throw new Error("Unknown subtitle media ID.");
              return relativeMedia;
            },
            managedDigest: (id, relative) =>
              repository.managedDigest(id, relative),
          }),
        ...(options.playback ? { playback: options.playback } : {}),
        onFilesChanged: options.onFilesChanged,
        ...(options.references ? { references: options.references } : {}),
      })
    : undefined;
  return {
    repository,
    service,
    sync,
    handlers: createSubtitleJobHandlers(
      service,
      repository,
      sync,
      async (attemptId, runAfter) => {
        await createJobQueue(options.pool).enqueue({
          jobType: SUBTITLE_JOB_TYPES.run,
          payload: { attemptId, replace: false },
          dedupeKey: `subtitle:${attemptId}`,
          runAfter,
        });
      },
    ),
  };
}
