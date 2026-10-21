import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
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

export async function saveRenditionRegistry(
  registryPath: string,
  registry: RenditionRegistry,
): Promise<void> {
  registry.updatedAt = new Date().toISOString();
  const validated = parseRegistry(registry);
  await mkdir(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(temporaryPath, registryPath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" &&
      process.platform !== "win32"
    ) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await rm(registryPath, { force: true });
    await rename(temporaryPath, registryPath);
  }
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

export function findRegistryItemById(
  registry: RenditionRegistry,
  mediaId: string,
): RenditionRegistryItem | undefined {
  return registry.items.find((item) => item.id === mediaId);
}
