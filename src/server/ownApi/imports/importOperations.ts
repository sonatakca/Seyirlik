/**
 * The filesystem operations an import is allowed to perform, and nothing else.
 *
 * Two roots, and every path proven against the one it belongs to. A source
 * path can only ever be read or removed; a library path can only ever be
 * written inside the library. There is no operation that takes two arbitrary
 * paths, because that is the operation that turns a bug into somebody's
 * missing film.
 *
 * The strategy is probed rather than assumed. Whether a hardlink works between
 * two directories is a fact about the filesystems underneath them — one that
 * this project cannot yet know, because the drive the library will live on is
 * disconnected — so it is measured by trying it on a file that does not matter
 * and cleaning up afterwards.
 */
import {
  copyFile,
  link,
  mkdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRootResolver, type RootResolver } from "./importFileSystem";
import type { ImportFailureClass, ImportStrategy } from "./importState";

export class ImportOperationError extends Error {
  readonly failure: ImportFailureClass;
  /**
   * Whether the operation may have taken effect despite reporting failure.
   *
   * The flag that decides between `failed` and `uncertain`, so it is set from
   * the error code rather than from a guess at the call site.
   */
  readonly ambiguous: boolean;

  constructor(failure: ImportFailureClass, message: string, ambiguous = false) {
    super(message);
    this.name = "ImportOperationError";
    this.failure = failure;
    this.ambiguous = ambiguous;
  }
}

/** What a filesystem error means for an import. */
export function classifyFsError(error: unknown): ImportOperationError {
  const code = (error as NodeJS.ErrnoException).code;
  /*
   * Which call failed, not just how. Windows overloads two codes badly enough
   * that the code alone leads the wrong way, and `syscall` is on every Node
   * filesystem error, so nothing has to be threaded down from the call site.
   */
  const syscall = (error as NodeJS.ErrnoException).syscall;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "ENOENT":
      return new ImportOperationError("source-missing", message);
    case "EXDEV":
      return new ImportOperationError("cross-volume", message);
    case "EPERM":
      /*
       * A rename whose destination another process holds open is refused with
       * `EPERM` on Windows, not `EBUSY`. Measured on Windows 11 against a real
       * open handle, on exFAT and on NTFS, and for a holder that shares
       * deletion as well as one that does not: `EBUSY` did not occur at all.
       *
       * The two codes lead opposite ways — `destination-locked` is retried,
       * `permission-denied` asks a person — and a player or a scanner holding a
       * file open for a few seconds is the commonest reason an upgrade cannot
       * be written. It was being escalated to a human instead of being tried
       * again.
       *
       * Narrowed to `rename` deliberately. `EPERM` from opening a source, or
       * from a mkdir, is a permission problem and still reads as one. The cost
       * of being wrong in this direction is bounded: a genuine permission
       * failure now takes `MAX_IMPORT_ATTEMPTS` tries before it asks, rather
       * than asking at once.
       */
      if (syscall === "rename") {
        return new ImportOperationError("destination-locked", message);
      }
      return new ImportOperationError("permission-denied", message);
    case "EACCES":
      // Windows distinguishes the two, and only `EPERM` carries the sharing
      // meaning above.
      return new ImportOperationError("permission-denied", message);
    case "EBUSY":
    case "ETXTBSY":
      // Windows reports an open handle this way; the file is fine, the moment
      // is wrong.
      return new ImportOperationError("destination-locked", message);
    case "ENOSPC":
      return new ImportOperationError("disk-full", message);
    case "EMLINK":
    case "ENOSYS":
    case "EOPNOTSUPP":
      return new ImportOperationError("hardlink-unsupported", message);
    case "ENOTSUP":
      /*
       * What the rclone mount of Google Drive at `D:` answers (WinFsp, 2026-10).
       * Node spells it apart from `EOPNOTSUPP`. Narrowed to `link` like
       * `EISDIR` below: it was why every subtitle write there failed as
       * `unknown` instead of falling back to a plain create.
       */
      if (syscall === "link") {
        return new ImportOperationError("hardlink-unsupported", message);
      }
      return new ImportOperationError("unknown", message);
    case "EISDIR":
      /*
       * What exFAT answers when asked for a hardlink: `EISDIR`, on two operands
       * that are both plainly files. Measured on a synthetic exFAT volume with
       * the same 128 KB cluster size as the media disk. It is Windows' way of
       * saying the filesystem has no hardlinks at all, and it was not among the
       * codes that mean that.
       *
       * The capability probe catches everything and answers `false`, so
       * strategy selection was never wrong — this is about a link that fails
       * anywhere else being described truthfully rather than as `unknown`.
       * `EISDIR` from any other call still means what it says.
       */
      if (syscall === "link") {
        return new ImportOperationError("hardlink-unsupported", message);
      }
      return new ImportOperationError("unknown", message);
    case "EEXIST":
      return new ImportOperationError("destination-occupied", message);
    case "EIO":
    case "ETIMEDOUT":
      /*
       * The genuinely ambiguous ones. An I/O error during a rename may have
       * been raised after the directory entry was written, so the only honest
       * answer is that nobody knows without looking.
       */
      return new ImportOperationError("commit-ambiguous", message, true);
    default:
      return new ImportOperationError("unknown", message);
  }
}

/**
 * Enough to tell "the file we put there" from "a file with the same name".
 *
 * Device and inode, which on Windows are the volume serial number and the file
 * index — the same pair a hardlink shares, which is exactly the question being
 * asked. Size is carried too, so a filesystem that reports no useful inode
 * still leaves something to compare.
 */
export interface FileIdentity {
  readonly key: string;
  readonly sizeBytes: number;
}

export async function identityOf(
  absolute: string,
): Promise<FileIdentity | null> {
  const stats = await stat(absolute).catch(() => null);
  if (!stats) return null;
  return {
    key: `dev:${stats.dev};ino:${stats.ino}`,
    sizeBytes: stats.size,
  };
}

export interface ImportOperations {
  readonly sourceRoot: string;
  readonly libraryRoot: string;
  /** Creates the destination's parent directories. */
  ensureDirectory(libraryRelative: string): Promise<void>;
  /** A second directory entry for the same bytes. Refuses to replace. */
  hardlink(sourceRelative: string, libraryRelative: string): Promise<void>;
  /** New bytes at a staging name. Refuses to replace. */
  copy(sourceRelative: string, libraryRelative: string): Promise<void>;
  /** A same-volume rename out of the download. Refuses to replace. */
  move(sourceRelative: string, libraryRelative: string): Promise<void>;
  /** Staging name to final name, inside the library. Refuses to replace. */
  activate(fromRelative: string, toRelative: string): Promise<void>;
  identity(libraryRelative: string): Promise<FileIdentity | null>;
  sourceIdentity(sourceRelative: string): Promise<FileIdentity | null>;
  exists(libraryRelative: string): Promise<boolean>;
  /** Removes a library path. Only this import's own staging or retirement. */
  discardStaging(libraryRelative: string): Promise<void>;
  /** Renames the file being replaced aside, keeping its bytes. */
  retire(destinationRelative: string, retiredRelative: string): Promise<void>;
  /** Removes a source path, once a destination is proven durable. */
  removeSource(sourceRelative: string): Promise<void>;
  /**
   * What this pair of roots actually supports, measured once.
   *
   * Writes a small file in the source root, tries to link it into the library
   * root, and removes both. The answer is a property of the two filesystems,
   * not of anything an import knows.
   */
  probeHardlink(): Promise<boolean>;
  /**
   * Whether the download can be renamed into the library at all.
   *
   * A failed hardlink probe does not answer this. exFAT refuses links on a
   * volume it will happily rename within, and a download on another volume
   * refuses both — the two cases need different strategies and look identical
   * from `probeHardlink` alone.
   */
  probeRename(): Promise<boolean>;
}

const STAGING_PREFIX = ".seyirlik-import";

/** The staging name an import writes under before activating it. */
export function stagingNameFor(
  idempotencyKey: string,
  destinationRelative: string,
): string {
  const directory = destinationRelative.split("/").slice(0, -1).join("/");
  const base = destinationRelative.split("/").at(-1) ?? "file";
  /*
   * Staged beside the destination rather than in a central scratch directory,
   * so activation is a rename within one directory — the only form of rename
   * that is atomic on every filesystem this will run on.
   */
  const name = `${STAGING_PREFIX}-${idempotencyKey}-${base}`;
  return directory ? `${directory}/${name}` : name;
}

export function isStagingName(relative: string): boolean {
  return (relative.split("/").at(-1) ?? "").startsWith(STAGING_PREFIX);
}

const RETIRED_PREFIX = ".seyirlik-retired";

/**
 * Where the file being replaced is put while the replacement goes in.
 *
 * An upgrade never deletes the old media and then hopes. The old file is
 * renamed aside — one atomic operation, its bytes entirely intact — the new
 * one is renamed into place, and only once that is recorded is the old one
 * removed. A reader in the gap between the two renames sees no file rather
 * than half of one, and a crash there leaves both files on disk under names
 * that say exactly what they are.
 */
export function retirementNameFor(
  idempotencyKey: string,
  destinationRelative: string,
): string {
  const directory = destinationRelative.split("/").slice(0, -1).join("/");
  const base = destinationRelative.split("/").at(-1) ?? "file";
  const name = `${RETIRED_PREFIX}-${idempotencyKey}-${base}`;
  return directory ? `${directory}/${name}` : name;
}

export function isRetiredName(relative: string): boolean {
  return (relative.split("/").at(-1) ?? "").startsWith(RETIRED_PREFIX);
}

async function refuseIfPresent(
  resolver: RootResolver,
  relative: string,
): Promise<string> {
  const absolute = resolver.resolve(relative);
  /*
   * Checked before every write. `rename` and `copyFile` replace silently on
   * POSIX, and this is the one thing that must never be what loses an
   * original. The check is not sufficient on its own — two workers can both
   * pass it — which is why the database constraint exists as well.
   */
  const existing = await stat(absolute).catch(() => null);
  if (existing) {
    throw new ImportOperationError(
      "destination-occupied",
      "Something is already at the destination.",
    );
  }
  return absolute;
}

export function createImportOperations(
  sourceRoot: string,
  libraryRoot: string,
): ImportOperations {
  const source = createRootResolver(sourceRoot);
  const library = createRootResolver(libraryRoot);
  let hardlinkSupport: Promise<boolean> | undefined;
  let renameSupport: Promise<boolean> | undefined;

  async function readableSource(relative: string): Promise<string> {
    const absolute = await source.resolveReal(relative);
    if (absolute === null) {
      throw new ImportOperationError(
        "source-missing",
        "The source file is no longer there.",
      );
    }
    return absolute;
  }

  return {
    sourceRoot: source.root,
    libraryRoot: library.root,

    ensureDirectory: async (libraryRelative) => {
      const parent = libraryRelative.split("/").slice(0, -1).join("/");
      const absolute = library.resolve(parent);
      try {
        await mkdir(absolute, { recursive: true });
      } catch (error) {
        throw classifyFsError(error);
      }
      // A pre-existing junction where a directory was expected would put every
      // later write outside the root; resolving after creation catches it.
      await library.resolveReal(parent);
    },

    hardlink: async (sourceRelative, libraryRelative) => {
      const from = await readableSource(sourceRelative);
      const to = await refuseIfPresent(library, libraryRelative);
      try {
        await link(from, to);
      } catch (error) {
        throw classifyFsError(error);
      }
    },

    copy: async (sourceRelative, libraryRelative) => {
      const from = await readableSource(sourceRelative);
      const to = await refuseIfPresent(library, libraryRelative);
      try {
        // COPYFILE_EXCL: the filesystem refuses an existing destination even
        // if something appeared between the check above and this call.
        await copyFile(from, to, 1 /* COPYFILE_EXCL */);
      } catch (error) {
        // A partial copy must never be left where a reader could find it.
        await rm(to, { force: true }).catch(() => undefined);
        throw classifyFsError(error);
      }
    },

    move: async (sourceRelative, libraryRelative) => {
      const from = await readableSource(sourceRelative);
      const to = await refuseIfPresent(library, libraryRelative);
      try {
        await rename(from, to);
      } catch (error) {
        throw classifyFsError(error);
      }
    },

    activate: async (fromRelative, toRelative) => {
      const from = library.resolve(fromRelative);
      const to = await refuseIfPresent(library, toRelative);
      try {
        await rename(from, to);
      } catch (error) {
        throw classifyFsError(error);
      }
    },

    retire: async (destinationRelative, retiredRelative) => {
      if (!isRetiredName(retiredRelative)) {
        throw new ImportOperationError(
          "path-escape",
          "A file may only be retired under a retirement name.",
        );
      }
      const from = library.resolve(destinationRelative);
      const to = await refuseIfPresent(library, retiredRelative);
      try {
        await rename(from, to);
      } catch (error) {
        throw classifyFsError(error);
      }
    },

    identity: async (libraryRelative) =>
      identityOf(library.resolve(libraryRelative)),

    sourceIdentity: async (sourceRelative) =>
      identityOf(source.resolve(sourceRelative)),

    exists: async (libraryRelative) =>
      (await stat(library.resolve(libraryRelative)).catch(() => null)) !== null,

    discardStaging: async (libraryRelative) => {
      /*
       * Deliberately refuses anything that is not staging. The only file this
       * import may delete inside the library is one it wrote under its own
       * name, and a deletion helper that would take any path is a deletion
       * helper that will eventually be given the wrong one.
       */
      if (!isStagingName(libraryRelative) && !isRetiredName(libraryRelative)) {
        throw new ImportOperationError(
          "path-escape",
          "Only an import's own staging or retired file may be discarded.",
        );
      }
      await rm(library.resolve(libraryRelative), { force: true });
    },

    removeSource: async (sourceRelative) => {
      const absolute = await source.resolveReal(sourceRelative);
      // Already gone is the desired end state, not a failure.
      if (absolute === null) return;
      try {
        await unlink(absolute);
      } catch (error) {
        throw classifyFsError(error);
      }
    },

    probeHardlink: async () => {
      hardlinkSupport ??= (async () => {
        const token = `${STAGING_PREFIX}-probe-${process.pid}-${Date.now()}`;
        const from = source.resolve(token);
        const to = library.resolve(token);
        try {
          await writeFile(from, "seyirlik hardlink probe");
          await link(from, to);
          /*
           * Linked is not enough: the two entries must actually be the same
           * file. A filesystem that satisfied the call with a copy would pass
           * a weaker test and then silently double the library's size.
           */
          const [a, b] = await Promise.all([identityOf(from), identityOf(to)]);
          return a !== null && b !== null && a.key === b.key;
        } catch {
          return false;
        } finally {
          await rm(from, { force: true }).catch(() => undefined);
          await rm(to, { force: true }).catch(() => undefined);
        }
      })();
      return hardlinkSupport;
    },

    probeRename: async () => {
      renameSupport ??= (async () => {
        const token = `${STAGING_PREFIX}-rename-probe-${process.pid}-${Date.now()}`;
        const from = source.resolve(token);
        const to = library.resolve(token);
        try {
          await writeFile(from, "seyirlik rename probe");
          await rename(from, to);
          return true;
        } catch {
          // EXDEV, or anything else that stops a rename. Either way the
          // importer must not plan a move it cannot carry out.
          return false;
        } finally {
          await rm(from, { force: true }).catch(() => undefined);
          await rm(to, { force: true }).catch(() => undefined);
        }
      })();
      return renameSupport;
    },
  };
}

export interface StrategyPolicy {
  /**
   * Whether the source must survive the import.
   *
   * True while a download is still being seeded or retained. It rules out
   * `move`, which has no source left afterwards.
   */
  readonly retainSource: boolean;
  /** Set when an operator has asked for real copies rather than links. */
  readonly forceCopy?: boolean;
}

export interface StrategyChoice {
  readonly strategy: ImportStrategy;
  readonly reason: string;
}

/**
 * Which operation this import will use, from what the filesystem can do.
 *
 * Hardlink first because it costs no space and no time; copy when the two
 * roots are not one filesystem; move only when the source is not wanted
 * afterwards and a link was not available, because it is the one choice that
 * cannot be undone by deleting what it created.
 */
export function chooseStrategy(
  hardlinkSupported: boolean,
  policy: StrategyPolicy,
  /**
   * Whether a rename from the download into the library can succeed.
   *
   * Defaulted to true so existing callers and tests keep their meaning; the
   * importer passes the probe's answer.
   */
  renameSupported = true,
): StrategyChoice {
  if (policy.forceCopy) {
    return { strategy: "copy", reason: "Copies were asked for." };
  }
  if (hardlinkSupported) {
    return {
      strategy: "hardlink",
      reason: "The library and the download share a filesystem that links.",
    };
  }
  if (policy.retainSource) {
    return {
      strategy: "copy",
      reason: "No link is possible and the download must be kept.",
    };
  }
  /*
   * A move is a rename, and a rename cannot cross a volume boundary. The
   * download directory here sits on the system disk while the library is on
   * external media, so planning a move produced EXDEV at the moment of
   * writing — after the plan had been recorded and the destination directory
   * created. Copying reaches the same end state: cleanup removes the download
   * afterwards, because the strategy is no longer `move`.
   */
  if (!renameSupported) {
    return {
      strategy: "copy",
      reason:
        "The download cannot be renamed into the library, so it is copied and then removed.",
    };
  }
  return {
    strategy: "move",
    reason: "No link is possible and the download is not being kept.",
  };
}
