import type { ProcessAbortReason } from "../processExecution";
import type {
  StorageIdentityProbe,
  StorageMedium,
  VolumeIdentity,
} from "./storageIdentity";

/**
 * Which volume a Windows path is on — the Windows half of `StorageIdentityProbe`.
 *
 * The Darwin probe resolves a path to a device with `df` and then asks
 * `diskutil` about the *device*, because a path is not something the volume
 * manager will answer for. Windows has the same shape of problem and the same
 * shape of answer: the path is resolved to its **volume** first, and only then
 * is the volume asked what it is.
 *
 * The resolution step here is pure and happens in this process. That is a
 * deliberate security property as much as a testing one: the only value that
 * ever reaches PowerShell is a single drive letter that has been matched
 * against `^[A-Za-z]$`, so a media path — which is attacker-influenced in the
 * sense that it comes from a filesystem — is never interpolated into script
 * text. See `buildVolumeQuery`.
 *
 * Nothing here mounts, scans, repairs, initialises or writes. Every field is
 * read from metadata the storage stack already has.
 */

/* ------------------------------------------------------------------ contract */

/**
 * Why an identity could not be established.
 *
 * `StorageIdentityProbe` returns `VolumeIdentity | null`, and `null` is what
 * every consumer already treats as "fail closed". That contract is kept exactly
 * as it is. But collapsing nine different failures into one `null` at the point
 * they happen throws away the only information an operator could act on, so the
 * typed result is produced first and narrowed to `null` at the boundary.
 */
export type WindowsIdentityFailure =
  /** A UNC or network path. Not a local volume, and it has no local identity. */
  | "not-a-local-volume"
  /** A relative path, a POSIX path, or a volume mounted into a folder. */
  | "no-drive-letter"
  /** The command did not run, or exited non-zero. */
  | "probe-failed"
  /** The command did not finish inside its budget and was terminated. */
  | "probe-timeout"
  /** Output was not JSON, or was not an object. */
  | "malformed-output"
  /** Output exceeded the ceiling a metadata probe can legitimately produce. */
  | "oversized-output"
  /** More than one volume record came back for one drive letter. */
  | "ambiguous-output"
  /** Parsed cleanly, but carries no usable identity. */
  | "incomplete-identity";

export type WindowsIdentityResult =
  | { ok: true; identity: VolumeIdentity }
  | { ok: false; failure: WindowsIdentityFailure; detail: string };

/**
 * A metadata document for one volume is a few hundred bytes. Anything past this
 * is not a volume record, and parsing megabytes of unexpected output to find
 * out is how a probe becomes the thing that wedges.
 */
export const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;

/* -------------------------------------------------------- path normalisation */

export type WindowsVolumeTarget =
  | { kind: "drive-letter"; letter: string }
  | { kind: "unc"; server: string; share: string | null }
  | { kind: "unsupported"; reason: WindowsIdentityFailure; detail: string };

const DRIVE_LETTER = /^[A-Za-z]$/;

/**
 * The volume a Windows path names, decided without touching the filesystem.
 *
 * Handles the variants that actually turn up: either slash style, either case,
 * a bare `D:`, a trailing separator, and the `\\?\` extended-length prefix that
 * long paths carry. A UNC path is recognised as such rather than being mangled
 * into a drive letter — `\\server\share` has no local volume, and pretending
 * otherwise is how a network mount comes to be treated as an internal disk.
 */
export function resolveWindowsVolumeTarget(
  rawPath: string,
): WindowsVolumeTarget {
  const path = rawPath.trim();
  if (path === "") {
    return {
      kind: "unsupported",
      reason: "no-drive-letter",
      detail: "The path is empty.",
    };
  }

  // Normalise slashes first: Node accepts `D:/media` and so must this.
  let candidate = path.replace(/\//g, "\\");

  // `\\?\UNC\server\share` is a UNC path wearing the extended-length prefix.
  const extendedUnc = /^\\\\[?.]\\UNC\\(.*)$/i.exec(candidate);
  if (extendedUnc?.[1] !== undefined) {
    candidate = `\\\\${extendedUnc[1]}`;
  } else {
    // `\\?\D:\media` -> `D:\media`. Only the prefix is stripped.
    const extended = /^\\\\[?.]\\(.*)$/.exec(candidate);
    if (extended?.[1] !== undefined) candidate = extended[1];
  }

  if (candidate.startsWith("\\\\")) {
    const segments = candidate
      .slice(2)
      .split("\\")
      .filter((s) => s !== "");
    const server = segments[0];
    if (!server) {
      return {
        kind: "unsupported",
        reason: "not-a-local-volume",
        detail: "The path is a UNC path with no server component.",
      };
    }
    return { kind: "unc", server, share: segments[1] ?? null };
  }

  const drive = /^([A-Za-z]):(?:\\|$)/.exec(candidate);
  if (drive?.[1] && DRIVE_LETTER.test(drive[1])) {
    return { kind: "drive-letter", letter: drive[1].toUpperCase() };
  }

  return {
    kind: "unsupported",
    reason: "no-drive-letter",
    detail:
      "The path does not begin with a drive letter, so it is a relative path or a volume mounted into a folder.",
  };
}

/* ------------------------------------------------------------ command building */

/**
 * The PowerShell invocation for one drive letter.
 *
 * The letter is validated against `^[A-Za-z]$` and upper-cased *before* it
 * reaches the script, so the only thing interpolated is one character from a
 * 26-symbol alphabet. Everything else is fixed text. A media path never appears
 * here, which is the point.
 *
 * `-NoProfile` keeps a user profile from changing the output shape,
 * `-NonInteractive` stops it waiting on a prompt for ever, and `-Compress`
 * keeps the document to the one line a probe should produce.
 */
export function buildVolumeQuery(letter: string): {
  command: string;
  args: readonly string[];
} {
  if (!DRIVE_LETTER.test(letter)) {
    // Unreachable through `resolveWindowsVolumeTarget`; a guard, not a check.
    throw new Error("A drive letter must be a single ASCII letter.");
  }
  const L = letter.toUpperCase();
  const script = [
    "$ErrorActionPreference='Stop';",
    `$v=Get-Volume -DriveLetter ${L};`,
    `$p=Get-Partition -DriveLetter ${L} -ErrorAction SilentlyContinue|Select-Object -First 1;`,
    "$d=if($p){Get-Disk -Number $p.DiskNumber -ErrorAction SilentlyContinue}else{$null};",
    "[pscustomobject]@{",
    "uniqueId=[string]$v.UniqueId;",
    "fileSystemType=[string]$v.FileSystemType;",
    "driveType=[string]$v.DriveType;",
    "driveLetter=[string]$v.DriveLetter;",
    "busType=[string]$d.BusType;",
    "serialNumber=[string]$d.SerialNumber;",
    "diskNumber=$p.DiskNumber;",
    "partitionNumber=$p.PartitionNumber",
    "}|ConvertTo-Json -Compress -Depth 3",
  ].join("");
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-Command",
      script,
    ],
  };
}

/* ------------------------------------------------------------------- parsing */

/**
 * The volume GUID, extracted from whatever shape `UniqueId` arrives in.
 *
 * `Get-Volume` reports `\\?\Volume{GUID}\` for a volume that has one. Some
 * volumes — notably FAT/exFAT media on older stacks — report a `Volume` prefix
 * with a different shape, or nothing at all. Only the GUID is kept, because the
 * decoration around it varies between Windows builds and the GUID does not.
 */
export function extractVolumeGuid(
  uniqueId: string | null | undefined,
): string | null {
  if (typeof uniqueId !== "string" || uniqueId.trim() === "") return null;
  const guid = /\{([0-9a-fA-F-]{36})\}/.exec(uniqueId);
  if (guid?.[1]) return guid[1].toLowerCase();
  return null;
}

/**
 * What kind of storage this is, from the two fields Windows will answer for.
 *
 * `driveType` settles the network case on its own — a mapped drive is a network
 * volume whatever bus the far end uses. Everything else is decided by bus type,
 * where `File Backed Virtual` is the answer that matters most: it is Windows
 * naming a VHD as a VHD, which is the disk-image case the whole identity system
 * exists to catch, and it is a *better* signal than anything Darwin exposes.
 */
export function classifyWindowsMedium(
  driveType: string | null,
  busType: string | null,
): StorageMedium {
  const drive = (driveType ?? "").trim().toLowerCase();
  const bus = (busType ?? "").trim().toLowerCase();

  // `4` is the Win32_LogicalDisk numeric form; newer PowerShell emits the name.
  if (drive === "network" || drive === "4") return "network";
  if (bus === "file backed virtual" || bus === "filebackedvirtual")
    return "disk-image";
  if (
    bus === "usb" ||
    bus === "1394" ||
    bus === "thunderbolt" ||
    bus === "sd" ||
    bus === "mmc"
  ) {
    return "physical-external";
  }
  if (
    bus === "sata" ||
    bus === "ata" ||
    bus === "nvme" ||
    bus === "raid" ||
    bus === "sas" ||
    bus === "scsi" ||
    bus === "ide" ||
    bus === "raid0"
  ) {
    return "physical-internal";
  }
  // Bus unknown: `Removable` is still a usable signal, `Fixed` is not — a fixed
  // drive on an unrecognised bus could be anything, and guessing "internal"
  // would be the dangerous direction.
  if (drive === "removable" || drive === "2") return "physical-external";
  return "unknown";
}

/**
 * One volume document into an identity.
 *
 * Strict where Darwin is tolerant, because the failure modes differ. `diskutil`
 * emits a fixed plist and a missing key genuinely means "unknown". Here the
 * document is produced by a script this file wrote, so a document that does not
 * match the schema means something went wrong upstream — a profile writing to
 * stdout, a partial read, an error object — and treating that as "unknown"
 * would hand a fabricated identity to a system whose entire job is to refuse
 * fabricated identities.
 */
export function parseWindowsVolumeDocument(
  stdout: string,
  fallbackMountPath: string,
): WindowsIdentityResult {
  if (stdout.length > MAX_PROBE_OUTPUT_BYTES) {
    return {
      ok: false,
      failure: "oversized-output",
      detail:
        "The volume query produced more output than a metadata document can contain.",
    };
  }

  const text = stdout.trim();
  if (text === "") {
    return {
      ok: false,
      failure: "malformed-output",
      detail: "The volume query produced no output.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      failure: "malformed-output",
      detail: "The volume query did not produce a JSON document.",
    };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length > 1) {
      return {
        ok: false,
        failure: "ambiguous-output",
        detail: "More than one volume was reported for a single drive letter.",
      };
    }
    parsed = parsed[0];
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      failure: "malformed-output",
      detail: "The volume query did not produce a volume record.",
    };
  }

  const record = parsed as Record<string, unknown>;
  const asText = (key: string): string | null => {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number") return String(value);
    return null;
  };

  const volumeUuid = extractVolumeGuid(asText("uniqueId"));
  const fsTypeRaw = asText("fileSystemType");
  const medium = classifyWindowsMedium(asText("driveType"), asText("busType"));

  /*
   * No GUID and no medium is not a reading. The Darwin probe makes the same
   * judgement for the same reason: an identity nobody can distinguish from a
   * blank one must not be allowed to satisfy a comparison later.
   */
  if (volumeUuid === null && medium === "unknown") {
    return {
      ok: false,
      failure: "incomplete-identity",
      detail:
        "The volume reported neither an identifier nor a recognisable kind of storage.",
    };
  }

  const diskNumber = asText("diskNumber");
  const partitionNumber = asText("partitionNumber");
  const letter = asText("driveLetter");

  return {
    ok: true,
    identity: {
      volumeUuid,
      /*
       * Reporting only, exactly as on Darwin. A disk and partition number is
       * what an operator types back into `Get-Partition`; it is not identity,
       * because Windows renumbers disks on every enumeration.
       */
      deviceNode:
        diskNumber !== null && partitionNumber !== null
          ? `\\\\.\\PhysicalDrive${diskNumber}#${partitionNumber}`
          : null,
      medium,
      /*
       * Lower-cased so the recorded and observed values compare on shape rather
       * than on which tool spelled them. Windows says `NTFS` and `exFAT`;
       * `diskutil` says `exfat`. Keeping one casing means a volume that keeps
       * its filesystem is never read as reformatted.
       */
      fsType: fsTypeRaw ? fsTypeRaw.toLowerCase() : null,
      /*
       * The volume's own root, not the directory that was asked about —
       * `D:\media` is one folder on `D:\`, and the identity belongs to the
       * volume.
       */
      mountPath: letter ? `${letter.toUpperCase()}:\\` : fallbackMountPath,
      /*
       * The physical disk's own serial. Unlike the disk number beside it this
       * does not move: Windows renumbers disks on every enumeration, and the
       * serial is stamped on the device.
       *
       * `Get-Disk` pads it on some controllers, and `asText` has already
       * trimmed it; a controller that reports nothing yields null, which every
       * consumer treats as "not known" rather than as a mismatch.
       */
      physicalSerial: asText("serialNumber"),
    },
  };
}

/* --------------------------------------------------------------------- probe */

/**
 * The abort reasons that mean "it ran out of time", named by the type that
 * defines them.
 *
 * `import type` is erased at build time, so this module still carries no
 * runtime dependency on the process layer — but the strings are now checked by
 * the compiler instead of being remembered. That distinction is not academic:
 * the first version of this file tested for `"timeout"`, which
 * `ProcessAbortReason` has never had. Nothing failed, because the only thing
 * that ever produced that shape was the fake in the test beside it, and on a
 * real Windows host every expired probe was reported as `probe-failed` — the
 * one classification that tells an operator to go and look at the storage.
 */
const TIMEOUT_ABORT_REASONS = new Set<ProcessAbortReason>(["wall-clock"]);

/**
 * Whether a rejection was the runner terminating a process that overran.
 *
 * Duck-typed rather than imported, so this module stays free of a runtime
 * dependency on the process layer and remains testable with a plain fake.
 */
function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; reason?: unknown };
  return (
    candidate.name === "ProcessAbortedError" &&
    typeof candidate.reason === "string" &&
    TIMEOUT_ABORT_REASONS.has(candidate.reason as ProcessAbortReason)
  );
}

/**
 * The typed Windows probe.
 *
 * Separated from the `StorageIdentityProbe` adapter below so that the reason a
 * volume could not be identified survives long enough to be logged or asserted
 * on. Consumers of the shared abstraction still receive `null`.
 */
export function createWindowsVolumeIdentityQuery(options: {
  run: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string>;
  timeoutMs?: number;
}): (path: string) => Promise<WindowsIdentityResult> {
  return async (path: string) => {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const target = resolveWindowsVolumeTarget(path);

    if (target.kind === "unsupported") {
      return { ok: false, failure: target.reason, detail: target.detail };
    }

    /*
     * A network path is answered without running anything. The medium is known
     * with certainty from the path's own shape, and no local query can produce
     * an identifier for a share. Reporting `network` with a null identifier is
     * strictly more useful than reporting nothing: `satisfiesRecovery` can let
     * an operator recover a share (which has no disk to have been swapped)
     * while still refusing it in place of physical media, and
     * `requiresOperatorAfterUncleanRestart` makes the cautious choice it exists
     * to make.
     */
    if (target.kind === "unc") {
      return {
        ok: true,
        identity: {
          volumeUuid: null,
          deviceNode: null,
          medium: "network",
          fsType: null,
          mountPath: target.share
            ? `\\\\${target.server}\\${target.share}`
            : `\\\\${target.server}`,
        },
      };
    }

    const { command, args } = buildVolumeQuery(target.letter);
    let stdout: string;
    try {
      stdout = await options.run(command, args, timeoutMs);
    } catch (error) {
      if (isTimeout(error)) {
        return {
          ok: false,
          failure: "probe-timeout",
          detail: "The volume query did not finish inside its time budget.",
        };
      }
      /*
       * Deliberately not the thrown message. A failing command's stderr can
       * carry the path it was asked about, and this string reaches an operator
       * UI. The reason a query failed is useful; the host's directory layout is
       * not.
       */
      return {
        ok: false,
        failure: "probe-failed",
        detail: `No volume could be read for drive ${target.letter}:.`,
      };
    }

    return parseWindowsVolumeDocument(stdout, `${target.letter}:\\`);
  };
}

/**
 * The Windows identity probe, in the shape the rest of the system consumes.
 *
 * Adapts the typed result to `VolumeIdentity | null`. Every failure becomes
 * `null`, which is what the storage guard and the job runner already treat as
 * "cannot be established" and refuse to build a decision on.
 */
export function createWindowsIdentityProbe(options: {
  run: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string>;
  timeoutMs?: number;
  /** Notified on failure, for logs. Never receives raw command output. */
  onFailure?: (failure: WindowsIdentityFailure, detail: string) => void;
}): StorageIdentityProbe {
  const query = createWindowsVolumeIdentityQuery(options);
  return async (path: string) => {
    const result = await query(path);
    if (result.ok) return result.identity;
    options.onFailure?.(result.failure, result.detail);
    return null;
  };
}
