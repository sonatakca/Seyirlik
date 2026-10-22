import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const RENDITION_METADATA_SCHEMA_VERSION = 3;
export const RENDITION_POINTER_SCHEMA_VERSION = 2;

export interface RenditionFileMetadata {
  /** Standard label (1080/720/480) the file is offered and named as. */
  qualityHeight: number;
  /** Actual encoded pixel dimensions, which keep the source aspect ratio. */
  width: number;
  height: number;
  bitrate?: number;
  fileSize: number;
  videoCodec: "h264" | "hevc";
  audioCodec: "aac";
  container: "mp4";
  frameRate?: number;
  file: string;
  sourceAudioStreamIndex: number;
  audioLanguage?: string;
  /** Which encoder produced the file; recorded for diagnostics only. */
  videoEncoder?:
    | "libx264"
    | "h264_qsv"
    | "h264_videotoolbox"
    | "libx265"
    | "hevc_qsv"
    | "hevc_videotoolbox"
    | "h264_nvenc"
    | "hevc_nvenc";
  /** True when the file carries the source HDR10 grade rather than SDR. */
  hdr?: boolean;
  /** True when an HDR master was tone mapped to SDR for this rendition. */
  tonemappedFromHdr?: boolean;
}

export interface RenditionMetadata {
  schemaVersion: 3;
  mediaId: string;
  sourceFingerprint: string;
  profileVersion: string;
  createdAt: string;
  durationSeconds: number;
  original: {
    width: number;
    height: number;
    qualityHeight: number;
    codec: string;
  };
  files: RenditionFileMetadata[];
  audioStrategy: "default-track-only";
  subtitleStrategy: "original-playback-only";
  validation: {
    validatedAt: string;
    durationToleranceSeconds: number;
  };
}

interface CurrentRenditionPointer {
  schemaVersion: 2;
  versionDirectory: string;
  sourceFingerprint: string;
  profileVersion: string;
}

export type CompletedRenditionStatus =
  | "missing"
  | "ready"
  | "stale"
  | "validation-failed";

export interface CompletedRenditionInspection {
  status: CompletedRenditionStatus;
  versionRoot?: string;
  metadata?: RenditionMetadata;
  reason?: string;
}

const VERSION_DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const LOCAL_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}\.mp4$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function safeRenditionFile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    LOCAL_FILE_PATTERN.test(value) &&
    path.posix.basename(value) === value &&
    !value.toLowerCase().includes("partial")
  );
}

function parsePointer(value: unknown): CurrentRenditionPointer {
  if (!isRecord(value))
    throw new Error("Current rendition pointer is invalid.");
  if (
    value.schemaVersion !== RENDITION_POINTER_SCHEMA_VERSION ||
    typeof value.versionDirectory !== "string" ||
    !VERSION_DIRECTORY_PATTERN.test(value.versionDirectory) ||
    value.versionDirectory.includes("..") ||
    !validFingerprint(value.sourceFingerprint) ||
    typeof value.profileVersion !== "string"
  ) {
    throw new Error("Current rendition pointer is invalid.");
  }
  return value as unknown as CurrentRenditionPointer;
}

function parseFile(value: unknown): RenditionFileMetadata {
  if (!isRecord(value)) throw new Error("Rendition file metadata is invalid.");
  if (
    typeof value.qualityHeight !== "number" ||
    !Number.isInteger(value.qualityHeight) ||
    value.qualityHeight <= 0 ||
    typeof value.height !== "number" ||
    !Number.isInteger(value.height) ||
    value.height <= 0 ||
    typeof value.width !== "number" ||
    !Number.isInteger(value.width) ||
    value.width <= 0 ||
    (value.bitrate !== undefined &&
      (typeof value.bitrate !== "number" ||
        !Number.isFinite(value.bitrate) ||
        value.bitrate <= 0)) ||
    typeof value.fileSize !== "number" ||
    !Number.isSafeInteger(value.fileSize) ||
    value.fileSize <= 0 ||
    (value.videoCodec !== "h264" && value.videoCodec !== "hevc") ||
    value.audioCodec !== "aac" ||
    value.container !== "mp4" ||
    (value.frameRate !== undefined &&
      (typeof value.frameRate !== "number" || value.frameRate <= 0)) ||
    !safeRenditionFile(value.file) ||
    typeof value.sourceAudioStreamIndex !== "number" ||
    !Number.isInteger(value.sourceAudioStreamIndex) ||
    value.sourceAudioStreamIndex < 0 ||
    (value.audioLanguage !== undefined &&
      typeof value.audioLanguage !== "string")
  ) {
    throw new Error("Rendition file metadata is invalid.");
  }
  return value as unknown as RenditionFileMetadata;
}

function parseMetadata(value: unknown): RenditionMetadata {
  if (
    !isRecord(value) ||
    !isRecord(value.original) ||
    !isRecord(value.validation)
  ) {
    throw new Error("Rendition metadata is invalid.");
  }
  if (
    value.schemaVersion !== RENDITION_METADATA_SCHEMA_VERSION ||
    typeof value.mediaId !== "string" ||
    !value.mediaId ||
    !validFingerprint(value.sourceFingerprint) ||
    typeof value.profileVersion !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.durationSeconds !== "number" ||
    value.durationSeconds <= 0 ||
    typeof value.original.width !== "number" ||
    typeof value.original.height !== "number" ||
    typeof value.original.qualityHeight !== "number" ||
    typeof value.original.codec !== "string" ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.audioStrategy !== "default-track-only" ||
    value.subtitleStrategy !== "original-playback-only" ||
    typeof value.validation.validatedAt !== "string" ||
    typeof value.validation.durationToleranceSeconds !== "number"
  ) {
    throw new Error("Rendition metadata is invalid.");
  }
  const files = value.files.map(parseFile);
  if (
    new Set(files.map((file) => file.qualityHeight)).size !== files.length ||
    new Set(files.map((file) => file.file.toLowerCase())).size !== files.length
  ) {
    throw new Error("Rendition metadata contains duplicate files or heights.");
  }
  return {
    ...(value as unknown as Omit<RenditionMetadata, "files">),
    files,
  };
}

async function validateRegisteredFile(
  versionRoot: string,
  file: RenditionFileMetadata,
): Promise<void> {
  const filePath = path.join(versionRoot, file.file);
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    throw new Error(`Registered rendition file is missing: ${file.file}`);
  }
  if (!fileStats.isFile() || fileStats.size <= 0) {
    throw new Error(
      `Registered rendition file is empty or invalid: ${file.file}`,
    );
  }
  if (fileStats.size !== file.fileSize) {
    throw new Error(
      `Registered rendition file size does not match metadata: ${file.file}`,
    );
  }
}

export async function validateCompletedVersion({
  versionRoot,
  mediaId,
  sourceFingerprint,
  profileVersion,
}: {
  versionRoot: string;
  mediaId: string;
  sourceFingerprint: string;
  profileVersion: string;
}): Promise<RenditionMetadata> {
  const metadata = parseMetadata(
    JSON.parse(await readFile(path.join(versionRoot, "metadata.json"), "utf8")),
  );
  if (
    metadata.sourceFingerprint !== sourceFingerprint ||
    metadata.profileVersion !== profileVersion ||
    metadata.mediaId !== mediaId
  ) {
    throw new Error(
      "Rendition metadata does not match the requested source version.",
    );
  }
  for (const file of metadata.files) {
    await validateRegisteredFile(versionRoot, file);
  }
  return metadata;
}

export async function inspectCompletedRendition({
  mediaRoot,
  mediaId,
  sourceFingerprint,
  profileVersion,
}: {
  mediaRoot: string;
  mediaId: string;
  sourceFingerprint: string;
  profileVersion: string;
}): Promise<CompletedRenditionInspection> {
  let pointerText: string;
  try {
    pointerText = await readFile(path.join(mediaRoot, "current.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" };
    return {
      status: "validation-failed",
      reason: "Current rendition pointer could not be read.",
    };
  }

  try {
    const pointer = parsePointer(JSON.parse(pointerText));
    const versionRoot = path.join(mediaRoot, pointer.versionDirectory);
    const metadata = parseMetadata(
      JSON.parse(
        await readFile(path.join(versionRoot, "metadata.json"), "utf8"),
      ),
    );
    if (
      pointer.sourceFingerprint !== sourceFingerprint ||
      metadata.sourceFingerprint !== sourceFingerprint ||
      pointer.profileVersion !== profileVersion ||
      metadata.profileVersion !== profileVersion ||
      metadata.mediaId !== mediaId
    ) {
      return { status: "stale", versionRoot, metadata };
    }
    await validateCompletedVersion({
      versionRoot,
      mediaId,
      sourceFingerprint,
      profileVersion,
    });
    return { status: "ready", versionRoot, metadata };
  } catch (error) {
    return {
      status: "validation-failed",
      reason:
        error instanceof Error ? error.message : "Rendition validation failed.",
    };
  }
}
