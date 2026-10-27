import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { ADAPTIVE_PROFILE_VERSION } from "./adaptive/profile";
import { RENDITION_PROFILE_VERSION } from "./policy";

export const RENDITION_REGISTRY_SCHEMA_VERSION = 1;
const FINGERPRINT_SAMPLE_BYTES = 64 * 1024;

const ADAPTIVE_REGISTRY_STATUSES = new Set<AdaptiveRegistryStatus>([
  "pending",
  "ready",
  "failed",
  "validation-failed",
  "deferred-for-storage",
  "incompatible",
  "interrupted",
  "stale",
]);

export type AdaptiveRegistryStatus =
  | "pending"
  | "ready"
  | "failed"
  | "validation-failed"
  | "deferred-for-storage"
  | "incompatible"
  | "interrupted"
  | "stale";

export interface RenditionRegistryItem {
  id: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
  sourceFingerprint: string;
  profileVersion: string;
  lastSeenAt: string;
  status?:
    | "pending"
    | "processing"
    | "ready"
    | "failed"
    | "deferred-for-storage"
    | "stale"
    | "already-valid"
    | "interrupted"
    | "validation-failed";
  lastError?: string;
  /**
   * State of this title's adaptive package, tracked alongside the legacy one
   * rather than replacing it.
   *
   * The two generations are independent: a title can have a valid legacy
   * package and no adaptive package, or both, and a failed adaptive run must
   * never make the legacy package look unusable. Keeping the adaptive fields
   * separate is what guarantees that — a single shared `status` would have made
   * the two overwrite each other on every run.
   */
  adaptiveStatus?: AdaptiveRegistryStatus;
  adaptiveProfileVersion?: string;
  adaptiveLastError?: string;
}

export interface RenditionRegistry {
  schemaVersion: number;
  profileVersion: string;
  updatedAt: string;
  items: RenditionRegistryItem[];
}

export interface RegistrySourceInput {
  relativePath: string;
  size: number;
  mtimeMs: number;
  sourceFingerprint: string;
}

export function createEmptyRenditionRegistry(): RenditionRegistry {
  return {
    schemaVersion: RENDITION_REGISTRY_SCHEMA_VERSION,
    profileVersion: RENDITION_PROFILE_VERSION,
    updatedAt: new Date().toISOString(),
    items: [],
  };
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isRegistryItem(value: unknown): value is RenditionRegistryItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<RenditionRegistryItem>;
  return (
    typeof item.id === "string" &&
    /^[0-9a-f-]{36}$/i.test(item.id) &&
    typeof item.relativePath === "string" &&
    typeof item.size === "number" &&
    Number.isFinite(item.size) &&
    item.size >= 0 &&
    typeof item.mtimeMs === "number" &&
    Number.isFinite(item.mtimeMs) &&
    typeof item.sourceFingerprint === "string" &&
    /^[0-9a-f]{64}$/i.test(item.sourceFingerprint) &&
    typeof item.profileVersion === "string" &&
    typeof item.lastSeenAt === "string" &&
    (item.adaptiveStatus === undefined ||
      ADAPTIVE_REGISTRY_STATUSES.has(item.adaptiveStatus)) &&
    (item.adaptiveProfileVersion === undefined ||
      typeof item.adaptiveProfileVersion === "string") &&
    (item.adaptiveLastError === undefined ||
      typeof item.adaptiveLastError === "string")
  );
}

function parseRegistry(value: unknown): RenditionRegistry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Rendition registry is invalid.");
  }
  const registry = value as Partial<RenditionRegistry>;
  if (
    registry.schemaVersion !== RENDITION_REGISTRY_SCHEMA_VERSION ||
    typeof registry.profileVersion !== "string" ||
    typeof registry.updatedAt !== "string" ||
    !Array.isArray(registry.items) ||
    !registry.items.every(isRegistryItem)
  ) {
    throw new Error("Rendition registry schema is invalid or unsupported.");
  }
  return registry as RenditionRegistry;
}

/**
 * The registry file exists but did not read back as JSON.
 *
 * Through an rclone mount this is usually a moment rather than a fault: the
 * mount can report the file as zero bytes for a while, and the read comes back
 * empty. It is never treated as an empty registry, because saving that would
 * erase every package's identity.
 */
export class RenditionRegistryUnreadableError extends Error {
  constructor(registryPath: string, cause: unknown) {
    super(
      `The rendition registry at ${registryPath} could not be read (${
        cause instanceof Error ? cause.message : String(cause)
      }).`,
      { cause },
    );
    this.name = "RenditionRegistryUnreadableError";
  }
}

export interface LoadRenditionRegistryOptions {
  /** How long an empty or unparseable read keeps being retried. */
  unreadableWaitMs?: number;
  unreadablePollMs?: number;
  signal?: AbortSignal;
  /** Called once, on the first unreadable read that will be retried. */
  onUnreadable?: (error: RenditionRegistryUnreadableError) => void;
}

export function parseRenditionRegistry(value: unknown): RenditionRegistry {
  return parseRegistry(value);
}

export async function loadRenditionRegistry(
  registryPath: string,
  options: LoadRenditionRegistryOptions = {},
): Promise<RenditionRegistry> {
  const { unreadableWaitMs = 0, unreadablePollMs = 5_000, signal } = options;
  const deadline = Date.now() + unreadableWaitMs;
  let reported = false;
  for (;;) {
    let text: string;
    try {
      text = await readFile(registryPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyRenditionRegistry();
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      const unreadable = new RenditionRegistryUnreadableError(
        registryPath,
        error,
      );
      if (signal?.aborted || Date.now() + unreadablePollMs > deadline) {
        throw unreadable;
      }
      if (!reported) {
        reported = true;
        options.onUnreadable?.(unreadable);
      }
      await delay(unreadablePollMs, signal);
      continue;
    }
    return parseRegistry(value);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * How a save replaces the registry file.
 *
 * On Windows the registry lives on the rclone Drive mount, where a rename onto
 * a file rclone still holds open (it keeps every closed handle for 5 s, so any
 * read just before a save counts) fails inside rclone's cache with "Access is
 * denied" while the rename itself reports success. The new contents are then
 * orphaned in the cache, the mount serves an empty file, and Drive either
 * keeps the old registry or receives an empty one. Deleting the old file first
 * is no better: the name is gone from Drive at once and its replacement
 * uploads only after the write-back delay, and an absent registry reads as
 * empty. Writing the file in place goes through rclone's ordinary write path
 * and keeps the name present throughout.
 */
export type RegistryWriteMode = "rename" | "in-place";

const DEFAULT_REGISTRY_WRITE_MODE: RegistryWriteMode =
  process.platform === "win32" ? "in-place" : "rename";

export async function saveRenditionRegistry(
  registryPath: string,
  registry: RenditionRegistry,
  options: { writeMode?: RegistryWriteMode } = {},
): Promise<void> {
  registry.updatedAt = new Date().toISOString();
  const validated = parseRegistry(registry);
  const contents = `${JSON.stringify(validated, null, 2)}\n`;
  await mkdir(path.dirname(registryPath), { recursive: true });
  if ((options.writeMode ?? DEFAULT_REGISTRY_WRITE_MODE) === "in-place") {
    await writeFile(registryPath, contents, "utf8");
  } else {
    const temporaryPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporaryPath, registryPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  /*
   * A save that did not land must fail where it happened. Otherwise a package
   * publishes with no registry entry pointing at it, and nothing notices until
   * playback cannot find it.
   */
  let readBack: string;
  try {
    const written = await readFile(registryPath, "utf8");
    if (written === contents) return;
    readBack = `${written.length} characters`;
  } catch (error) {
    readBack = (error as NodeJS.ErrnoException).code ?? String(error);
  }
  throw new Error(
    `Rendition registry save did not land: ${registryPath} reads back ${readBack}, expected ${contents.length} characters.`,
  );
}

/**
 * Where the rendition registry is kept, and the one way to change it.
 *
 * Every change is a read-modify-write of the whole registry, so a writer that
 * loads a copy, keeps it for the hours an encode takes and then saves it
 * undoes every change made in between. `update` closes that window: it reads
 * the current registry, applies `mutate`, and persists the result before any
 * other writer through the same store can read. `mutate` must be synchronous
 * and must not keep the registry it was handed.
 */
export interface RenditionRegistryStore {
  /** A fresh copy; changing it changes nothing stored. */
  read(): Promise<RenditionRegistry>;
  update<T>(mutate: (registry: RenditionRegistry) => T): Promise<T>;
  /** Changes whenever the registry does, and costs less than `read`. */
  revision(): Promise<string>;
}

/**
 * The registry as one JSON file, for the offline CLI and for tests.
 *
 * Updates are serialised within this process only. Two processes, or two
 * machines sharing a network mount, can still lose each other's writes; the
 * running services use the database store for that reason.
 */
export function createFileRenditionRegistryStore(
  registryPath: string,
): RenditionRegistryStore {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read: () => loadRenditionRegistry(registryPath),
    update<T>(mutate: (registry: RenditionRegistry) => T): Promise<T> {
      const result = queue.then(async () => {
        const registry = await loadRenditionRegistry(registryPath);
        const value = mutate(registry);
        await saveRenditionRegistry(registryPath, registry);
        return value;
      });
      queue = result.catch(() => undefined);
      return result;
    },
    async revision() {
      try {
        const stats = await stat(registryPath);
        return `${stats.size}:${stats.mtimeMs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return "missing";
        throw error;
      }
    },
  };
}

export async function computeSourceFingerprint(
  filePath: string,
  stats: Pick<Stats, "size" | "mtimeMs">,
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(
    `seyirlik-source-v1\0${stats.size}\0${Math.trunc(stats.mtimeMs)}\0`,
  );
  const handle = await open(filePath, "r");
  try {
    const headLength = Math.min(FINGERPRINT_SAMPLE_BYTES, stats.size);
    const head = Buffer.alloc(headLength);
    if (headLength > 0) {
      const { bytesRead } = await handle.read(head, 0, headLength, 0);
      hash.update(head.subarray(0, bytesRead));
    }

    if (stats.size > headLength) {
      const tailLength = Math.min(
        FINGERPRINT_SAMPLE_BYTES,
        stats.size - headLength,
      );
      const tail = Buffer.alloc(tailLength);
      const tailPosition = Math.max(headLength, stats.size - tailLength);
      const { bytesRead } = await handle.read(
        tail,
        0,
        tailLength,
        tailPosition,
      );
      hash.update(tail.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export function upsertRegistrySource(
  registry: RenditionRegistry,
  source: RegistrySourceInput,
): RenditionRegistryItem {
  const relativePath = normalizeRelativePath(source.relativePath);
  const pathMatchIndex = registry.items.findIndex(
    (item) =>
      item.relativePath.toLocaleLowerCase("en-US") ===
      relativePath.toLocaleLowerCase("en-US"),
  );
  const fingerprintMatchIndex = registry.items.findIndex(
    (item) =>
      source.sourceFingerprint !== "0".repeat(64) &&
      item.sourceFingerprint === source.sourceFingerprint,
  );
  const matchIndex =
    pathMatchIndex >= 0 ? pathMatchIndex : fingerprintMatchIndex;
  const previous = matchIndex >= 0 ? registry.items[matchIndex] : undefined;
  const sourceFingerprintChanged = Boolean(
    previous && previous.sourceFingerprint !== source.sourceFingerprint,
  );
  const sourceChanged = Boolean(
    previous &&
    (sourceFingerprintChanged ||
      previous.profileVersion !== registry.profileVersion),
  );
  const next: RenditionRegistryItem = {
    id: previous?.id ?? randomUUID(),
    relativePath,
    size: source.size,
    mtimeMs: source.mtimeMs,
    sourceFingerprint: source.sourceFingerprint,
    profileVersion: registry.profileVersion,
    lastSeenAt: new Date().toISOString(),
    status: sourceChanged ? "stale" : (previous?.status ?? "pending"),
    ...(sourceChanged
      ? {}
      : previous?.lastError
        ? { lastError: previous.lastError }
        : {}),
    // A changed source invalidates both generations, but only the source
    // changing does: an ordinary re-analysis must carry the adaptive state
    // forward untouched, or every run would report every adaptive package as
    // needing regeneration.
    ...(sourceFingerprintChanged
      ? {}
      : {
          ...(previous?.adaptiveStatus
            ? { adaptiveStatus: previous.adaptiveStatus }
            : {}),
          ...(previous?.adaptiveProfileVersion
            ? { adaptiveProfileVersion: previous.adaptiveProfileVersion }
            : {}),
          ...(previous?.adaptiveLastError
            ? { adaptiveLastError: previous.adaptiveLastError }
            : {}),
        }),
  };

  if (matchIndex >= 0) registry.items.splice(matchIndex, 1, next);
  else registry.items.push(next);
  registry.updatedAt = new Date().toISOString();
  return next;
}

/**
 * The record playback serves these source bytes from, looked up exactly as
 * the playback service looks it up.
 *
 * A record that disagrees with the file describes some other version of it.
 * Size is decisive. The modification time counts only when the record has
 * one: a zero is an absent measurement, not evidence that the file changed.
 */
export function findRegistryItemForSource(
  registry: Pick<RenditionRegistry, "items">,
  source: { relativePath: string; size: number; mtimeMs: number },
): RenditionRegistryItem | undefined {
  const key = normalizeRelativePath(source.relativePath).toLowerCase();
  const item = registry.items.find(
    (entry) => entry.relativePath.toLowerCase() === key,
  );
  const registeredMtime = Math.trunc(item?.mtimeMs ?? 0);
  if (
    !item ||
    item.size !== source.size ||
    (registeredMtime > 0 && registeredMtime !== Math.trunc(source.mtimeMs))
  ) {
    return undefined;
  }
  return item;
}

/**
 * Why playback could not yet serve these source bytes from their adaptive
 * package, or null when it can.
 *
 * Asked before a source is removed: the registry entry is the only way
 * playback finds a package, so a source removed before its entry is in place
 * and ready leaves the title with nothing to play.
 */
export function registryGapForPlayback(
  registry: Pick<RenditionRegistry, "items">,
  source: {
    relativePath: string;
    size: number;
    mtimeMs: number;
    sourceFingerprint: string;
  },
): string | null {
  const entry = findRegistryItemForSource(registry, source);
  if (!entry)
    return `the rendition registry has no entry for ${source.relativePath} at this size`;
  if (entry.sourceFingerprint !== source.sourceFingerprint)
    return `the rendition registry entry for ${source.relativePath} describes other source bytes`;
  if (
    entry.adaptiveStatus !== "ready" ||
    entry.adaptiveProfileVersion !== ADAPTIVE_PROFILE_VERSION
  )
    return `the rendition registry entry for ${source.relativePath} is ${entry.adaptiveStatus ?? "not adaptive"} at ${entry.adaptiveProfileVersion ?? "no profile"}`;
  return null;
}

export function findRegistryItemById(
  registry: RenditionRegistry,
  mediaId: string,
): RenditionRegistryItem | undefined {
  return registry.items.find((item) => item.id === mediaId);
}
