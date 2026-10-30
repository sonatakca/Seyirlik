/**
 * Turning a finished download into a planned import.
 *
 * One function, used by the admin route and by the automatic handoff alike, so
 * that a download imported by hand and one imported by itself are checked the
 * same way: the source is what the acquisition recorded, it must sit inside
 * the authorised download root, and the library root comes from configuration.
 */
import path from "node:path";
import { isPathInsideRoot } from "../../pathSecurity";
import { validationError } from "../api/validation";
import type { JobQueue } from "../tasks/jobQueue";
import { IMPORT_JOB_TYPES } from "./importJobs";
import type { ImportRecord, ImportRepository } from "./importRepository";

/** What the completed download and the library root are, for one target. */
export interface ImportSourceResolution {
  /** Absolute path SABnzbd reported for the finished download. */
  readonly downloadPath: string;
  readonly target: {
    readonly kind: "movie" | "series" | "season" | "episode";
    readonly title: string;
    readonly year?: number;
    readonly season?: number;
    readonly episode?: number;
    readonly itemId?: string;
  };
}

/** What a person may correct about the target when importing by hand. */
export interface ImportOverrides {
  readonly kind?: string;
  readonly title?: string;
  readonly year?: number;
  readonly season?: number;
  readonly episode?: number;
  readonly isUpgrade?: boolean;
}

export interface ImportStarterOptions {
  readonly repository: ImportRepository;
  readonly queue: JobQueue;
  /** The one directory an import may read a download out of. */
  readonly downloadRoot: string;
  /** Where the library for a target kind lives. */
  readonly libraryRootFor: (kind: string) => string | undefined;
  /** What the acquisition says it downloaded, and for what. */
  readonly resolveAcquisition: (
    acquisitionId: string,
  ) => Promise<ImportSourceResolution | null>;
}

export type ImportStarter = (
  acquisitionId: string,
  overrides?: ImportOverrides,
) => Promise<{ record: ImportRecord; taskId: string }>;

export const importRunDedupeKey = (importId: string): string =>
  `import.run:${importId}`;

export function createImportStarter({
  repository,
  queue,
  downloadRoot,
  libraryRootFor,
  resolveAcquisition,
}: ImportStarterOptions): ImportStarter {
  return async (acquisitionId, overrides = {}) => {
    const resolved = await resolveAcquisition(acquisitionId);
    if (!resolved) {
      throw validationError(
        "That acquisition has no finished download to import.",
      );
    }

    /*
     * The download path came from SABnzbd, not from the caller, and it is
     * still checked: a download client writing outside the root Seyirlik
     * authorised is a misconfiguration, and following it would put the
     * importer somewhere nobody agreed to.
     */
    const absolute = path.resolve(resolved.downloadPath);
    if (!isPathInsideRoot(path.resolve(downloadRoot), absolute)) {
      throw validationError(
        "The finished download is outside the configured download root.",
      );
    }
    const sourceRelative = path
      .relative(path.resolve(downloadRoot), absolute)
      .split(path.sep)
      .join("/");

    const kind = overrides.kind ?? resolved.target.kind ?? "movie";
    if (
      kind !== "movie" &&
      kind !== "series" &&
      kind !== "season" &&
      kind !== "episode"
    ) {
      throw validationError(
        "The kind must be movie, series, season or episode.",
      );
    }
    const libraryRoot = libraryRootFor(kind);
    if (!libraryRoot) {
      throw validationError("No library is configured for that kind of media.");
    }

    const title = (overrides.title ?? resolved.target.title).trim();
    if (!title) throw validationError("A title is required.");

    const year = overrides.year ?? resolved.target.year;
    const season = overrides.season ?? resolved.target.season;
    const episode = overrides.episode ?? resolved.target.episode;
    const record = await repository.create({
      acquisitionId,
      target: {
        kind,
        title,
        ...(resolved.target.itemId ? { itemId: resolved.target.itemId } : {}),
        ...(year ? { year } : {}),
        ...(season ? { season } : {}),
        ...(episode ? { episode } : {}),
      },
      sourceRoot: path.resolve(downloadRoot),
      libraryRoot: path.resolve(libraryRoot),
      sourceRelative,
      isUpgrade: overrides.isUpgrade === true,
    });

    const taskId = await queue.enqueue({
      jobType: IMPORT_JOB_TYPES.run,
      payload: { importId: record.id },
      dedupeKey: importRunDedupeKey(record.id),
    });
    return { record, taskId };
  };
}

export interface ImportHandoffOptions {
  /** Acquisitions whose download has finished, with or without an import. */
  readonly listFinished: () => Promise<ReadonlyArray<{ id: string }>>;
  /** Which of these already have an import, in any state. */
  readonly withImports: (ids: readonly string[]) => Promise<Set<string>>;
  readonly start: ImportStarter;
  readonly warn?: (message: string) => void;
}

/**
 * Plans an import for every finished download that has none.
 *
 * A download is asked for in order to be watched, and before this nothing
 * carried it the last step: it sat as "downloaded" until somebody called the
 * import API by hand. One import per acquisition is a unique index, so this
 * racing a person importing by hand loses quietly rather than doubling up.
 * A download that cannot be planned is skipped and named, and tried again on
 * the next pass — never retried in a loop here.
 */
export function createImportHandoff({
  listFinished,
  withImports,
  start,
  warn = console.warn,
}: ImportHandoffOptions): () => Promise<{ started: number; refused: number }> {
  return async () => {
    const finished = await listFinished();
    const imported = await withImports(finished.map((row) => row.id));
    let started = 0;
    let refused = 0;
    for (const row of finished) {
      if (imported.has(row.id)) continue;
      try {
        await start(row.id);
        started += 1;
      } catch (error) {
        refused += 1;
        warn(
          `[import] Could not hand off acquisition ${row.id}: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      }
    }
    return { started, refused };
  };
}
