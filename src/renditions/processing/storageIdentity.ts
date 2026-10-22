/**
 * Which volume this actually is — as opposed to which path it turned up at.
 *
 * Every identity check in this system was a string comparison on a mount path,
 * and a real incident showed what that is worth. A disk image containing a
 * partition named `Expansion` was mounted for tests while the failed physical
 * `Expansion` HDD was unplugged. `mount` reported
 * `/dev/disk4s1 on /Volumes/Expansion (exfat)`, every path-based check agreed
 * this was the dangerous drive, and it was in fact a 2.9 GB synthetic image
 * holding `E2E Title (2026)/video/{144p…720p}.mp4`.
 *
 * The failure runs both ways and both are unacceptable:
 *
 *  - **False positive.** A test image mounted at the quarantined path inherits
 *    the quarantine, so the E2E suite stops for a fault on hardware it has
 *    never touched.
 *  - **False negative, and far worse.** A quarantine recorded against a failing
 *    USB drive is *satisfied* by mounting any volume at the same path. Plug in a
 *    different disk, or attach an image, and the recovery check passes — which
 *    would hand back a green light for storage nobody has repaired.
 *
 * So identity is what the volume *is*: a UUID that survives remounting and
 * rebooting, and a medium that says whether it is physical external media, an
 * internal disk, a network mount, or a file pretending to be a disk. The path
 * is where it happens to be today and is never, on its own, evidence.
 *
 * Nothing here reads media. The probe asks the OS for volume metadata, is
 * injected everywhere it is used, and is never called in a loop.
 */

/**
 * What kind of storage this is.
 *
 * `disk-image` is a first-class answer rather than a footnote, because telling
 * it from `physical-external` is the whole point of this file: they look
 * identical from `/Volumes`, they are equally detachable, and exactly one of
 * them can put the machine into a kernel I/O storm.
 */
export type StorageMedium =
  /** USB, Thunderbolt, FireWire — media that can be unplugged and can fail. */
  | "physical-external"
  /** The boot disk or another fixed internal device. */
  | "physical-internal"
  /** A `.dmg`, a sparse bundle, anything backed by a file. */
  | "disk-image"
  /** SMB, NFS, AFP. Detachable, but its failures are not a local disk's. */
  | "network"
  /** The probe could not say. Treated cautiously by every caller. */
  | "unknown";

export interface VolumeIdentity {
  /**
   * The volume's own UUID. Stable across unmount, remount and reboot, which is
   * exactly what a device node is not.
   */
  volumeUuid: string | null;
  /** `/dev/disk4s1`. Useful for an operator, useless as identity: it is
   * reassigned on every mount. */
  deviceNode: string | null;
  medium: StorageMedium;
  /** `exfat`, `hfs`, `apfs`. Recorded because a reformat is a different volume. */
  fsType: string | null;
  /**
   * Where the volume itself is mounted — `/Volumes/Expansion`, not the
   * `/Volumes/Expansion/media` a caller may have asked about. Reporting only:
   * nothing compares it, because a path is never evidence of identity.
   */
  mountPath: string | null;
  /**
   * The serial of the physical device underneath, when the platform reports one.
   *
   * Optional, and absent is the normal case rather than a fault: Darwin does
   * not supply it here, and an identity recorded before this field existed has
   * none. That is what makes it safe to add — it can only ever strengthen a
   * comparison, never fail one that would otherwise have passed.
   *
   * A volume UUID identifies a filesystem; this identifies the hardware it sits
   * on. They answer different questions, and the pair catches the case neither
   * catches alone: a volume restored or cloned onto a different physical disk
   * keeps its UUID while being, in every sense that matters to a failing drive,
   * somewhere else.
   */
  physicalSerial?: string | null;
}

/**
 * Asks the OS which volume is underneath a path. Injected everywhere.
 *
 * The path is any existing path — a configured media root, a scratch
 * directory, a claimed workspace — and the implementation resolves it to its
 * filesystem itself. Callers do not know, and must not have to know, where a
 * volume happens to be mounted.
 */
export type StorageIdentityProbe = (
  path: string,
) => Promise<VolumeIdentity | null>;

export function unknownIdentity(
  mountPath: string | null = null,
): VolumeIdentity {
  return {
    volumeUuid: null,
    deviceNode: null,
    medium: "unknown",
    fsType: null,
    mountPath,
  };
}

/**
 * Whether losing this volume is an ordinary event that a person should be asked
 * about before a multi-hour encode restarts unattended.
 *
 * This is what replaces the `root.startsWith("/Volumes/")` test. The old test
 * was wrong in both directions at once: it held up work on a synthetic image
 * mounted under `/Volumes` (which is why the E2E suite must be exempt), and it
 * would have waved through a failing external drive mounted anywhere else.
 *
 * A disk image is deliberately *not* included. It is detachable, but its
 * disappearance is somebody stopping a test, not a bridge chip failing, and
 * making the E2E suite wait for an operator would teach everyone to click
 * through the prompt.
 */
/**
 * Whether a path names a Windows network share.
 *
 * `\\server\share` is one, and so is `\\?\UNC\server\share`. `\\?\D:\media` is
 * not — the `\\?\` and `\\.\` prefixes introduce a *local* device path, and
 * reading the leading pair of slashes as "network" would misclassify every long
 * local path on the machine.
 */
function isUncNetworkPath(candidate: string): boolean {
  const normalized = candidate.replace(/\//g, "\\");
  if (!normalized.startsWith("\\\\")) return false;
  const rest = normalized.slice(2);
  if (/^[?.]\\UNC\\/i.test(rest)) return true;
  // `\\?\...` and `\\.\...` are device paths, not shares.
  if (/^[?.]\\/.test(rest)) return false;
  return rest !== "" && !rest.startsWith("\\");
}

export function requiresOperatorAfterUncleanRestart(
  identity: VolumeIdentity | null,
  fallbackPath: string,
): boolean {
  if (identity && identity.medium !== "unknown") {
    return (
      identity.medium === "physical-external" || identity.medium === "network"
    );
  }
  /*
   * No identity available — the probe failed, or this deployment has no
   * implementation. Fall back to the path heuristic, because being cautious
   * about a volume nobody can identify is the safe direction, and it preserves
   * exactly the behaviour that shipped before identity existed.
   *
   * A UNC path is included because it is the one Windows path shape that names
   * its own medium with certainty: `\\server\share` is a network volume and
   * cannot be anything else. Before this, every Windows path fell through to
   * `false`, so a share that vanished mid-encode was treated as an ordinary
   * local disk and work resumed unattended.
   *
   * A drive letter is deliberately *not* treated as cautious. `D:` may be a USB
   * disk or the second internal SSD, the path cannot tell which, and answering
   * `true` for every lettered volume would hold work on internal scratch after
   * any unclean restart — which teaches an operator to click through the prompt
   * that exists for the external drive.  That distinction is what the probe is
   * for, and when the probe answers this heuristic is not consulted.
   */
  return (
    isUncNetworkPath(fallbackPath) ||
    fallbackPath.startsWith("/Volumes/") ||
    fallbackPath.startsWith("/media/") ||
    fallbackPath.startsWith("/mnt/") ||
    fallbackPath.startsWith("/net/")
  );
}

export type RecoveryIdentityVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Whether the volume present now is the one the quarantine was recorded
 * against.
 *
 * The rule is deliberately strict and deliberately fails closed, because the
 * cost of the two errors is wildly asymmetric. Refusing a genuine drive costs
 * an operator a support question. Accepting the wrong one hands back a green
 * light for hardware nobody has repaired, and the last time this system got a
 * storage question wrong the machine had to be power-cycled twice.
 */
export function satisfiesRecovery(
  recorded: VolumeIdentity | null,
  current: VolumeIdentity | null,
): RecoveryIdentityVerdict {
  if (!current) {
    return { ok: false, reason: "No volume is mounted at that path." };
  }

  /*
   * A network share — the Google Drive mount the library moved to when the
   * Expansion drive died — has no local identity to match, by nature rather
   * than by fault: there is no disk under it to have been swapped. Requiring
   * one made a quarantine on such a mount impossible to clear (verify could
   * not match, adopt had no UUID to record). The medium is certain here (the
   * probe reads it from the UNC path itself, and a guard's root never
   * changes), so this cannot be a USB disk passing itself off as the share.
   * The operator's separate resume press is still what lifts the hold.
   *
   * It does not extend to a quarantine recorded against anything other than a
   * network volume: physical media keeps every check below.
   */
  if (
    current.medium === "network" &&
    (!recorded || recorded.medium === "network")
  ) {
    return { ok: true };
  }

  /*
   * A quarantine recorded before identity was captured — an incident carried
   * across the upgrade that added this file, or one written while the probe was
   * unavailable. There is nothing to compare against, so this cannot be
   * *automatically* satisfied; the operator's explicit resume is what clears it.
   * Silently passing would make the check decorative for exactly the incidents
   * that predate it.
   */
  if (!recorded || recorded.volumeUuid === null) {
    return {
      ok: false,
      reason:
        "The quarantine was recorded without a volume identity, so it cannot be matched automatically.",
    };
  }

  /*
   * The medium is checked before the UUID, because it is the check that catches
   * the mistake that actually happened: a disk image standing in for physical
   * media at the same path. A synthetic volume can be given any name; what it
   * cannot be is a USB disk.
   */
  if (current.medium !== recorded.medium) {
    return {
      ok: false,
      reason: `The volume at that path is ${describeMedium(current.medium)}, but the quarantine was recorded against ${describeMedium(recorded.medium)}.`,
    };
  }

  if (current.volumeUuid === null) {
    return {
      ok: false,
      reason: "The volume at that path did not report an identity.",
    };
  }

  if (current.volumeUuid !== recorded.volumeUuid) {
    return {
      ok: false,
      reason:
        "A different volume is mounted at that path than the one that was quarantined.",
    };
  }

  /*
   * A reformat produces the same path and, on some systems, a recycled UUID
   * while being a different filesystem entirely. Cheap to check and it costs
   * nothing to be sure.
   */
  if (
    recorded.fsType !== null &&
    current.fsType !== null &&
    recorded.fsType !== current.fsType
  ) {
    return {
      ok: false,
      reason: "The volume at that path has been reformatted.",
    };
  }

  /*
   * Both sides must actually report a serial. A one-sided comparison would
   * turn every identity recorded before this field existed — and every
   * platform that does not supply one — into an unsatisfiable quarantine,
   * which is a false negative introduced by a check meant to prevent one.
   */
  if (
    recorded.physicalSerial != null &&
    current.physicalSerial != null &&
    recorded.physicalSerial !== current.physicalSerial
  ) {
    return {
      ok: false,
      reason:
        "The volume at that path is on a different physical disk than the one that was quarantined.",
    };
  }

  return { ok: true };
}

export function describeMedium(medium: StorageMedium): string {
  switch (medium) {
    case "physical-external":
      return "external physical media";
    case "physical-internal":
      return "an internal disk";
    case "disk-image":
      return "a disk image";
    case "network":
      return "a network volume";
    case "unknown":
      return "storage of an unknown kind";
  }
}

/**
 * Turns one `diskutil info -plist` document into an identity.
 *
 * Bounded, and metadata only: it describes what the volume manager already
 * knows and never opens a file on the volume. Kept behind the injectable probe
 * type so no test ever runs `diskutil`, and so a non-macOS deployment simply
 * has no identity and falls back to the path heuristic above.
 *
 * `fallbackMountPath` is used only when the document does not say where the
 * volume is mounted — see `mountPath` below for why diskutil's own answer wins.
 *
 * The parse is deliberately tolerant, and deliberately generous about key
 * names. A missing key means "unknown", never a throw — an identity probe that
 * can fail loudly during recovery would be one more thing standing between an
 * operator and a repaired drive. But a key that is merely *spelled* differently
 * from the fixture somebody captured years ago is not a missing key, and
 * treating it as one is how a healthy USB disk came to be classified `unknown`:
 * current macOS emits `Internal`, while the fixtures here were written against
 * `DeviceInternal`.
 */
export function parseDiskutilPlist(
  plist: string,
  fallbackMountPath: string,
): VolumeIdentity {
  const stringValue = (key: string): string | null => {
    const pattern = new RegExp(
      `<key>${key}</key>\\s*<string>([^<]*)</string>`,
      "i",
    );
    const found = pattern.exec(plist);
    return found?.[1]?.trim() || null;
  };
  const boolValue = (key: string): boolean | null => {
    const pattern = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`, "i");
    const found = pattern.exec(plist);
    return found ? found[1]?.toLowerCase() === "true" : null;
  };

  const protocol = stringValue("BusProtocol") ?? stringValue("Protocol");
  /*
   * `Internal` first, because that is what macOS emits today; `DeviceInternal`
   * second, because the captured fixtures use it and an older host may too.
   * `??` rather than `||` so an explicit `false` — the answer that means
   * "external", the one that matters most here — is never discarded.
   */
  const internal = boolValue("Internal") ?? boolValue("DeviceInternal");
  const virtualOrPhysical = stringValue("VirtualOrPhysical");

  let medium: StorageMedium = "unknown";
  if (
    protocol === "Disk Image" ||
    virtualOrPhysical === "Virtual" ||
    boolValue("DiskImage") === true
  ) {
    medium = "disk-image";
  } else if (protocol && /smb|nfs|afp|network/i.test(protocol)) {
    medium = "network";
  } else if (internal === true) {
    medium = "physical-internal";
  } else if (internal === false) {
    medium = "physical-external";
  }

  /*
   * `DeviceNode` is what diskutil normally gives; `DeviceIdentifier` is the
   * same device without the `/dev/` prefix, and reconstructing the node from it
   * keeps the field in one shape for the operator who pastes it back into
   * `diskutil`.
   */
  const deviceIdentifier = stringValue("DeviceIdentifier");
  const deviceNode =
    stringValue("DeviceNode") ??
    (deviceIdentifier ? `/dev/${deviceIdentifier}` : null);

  return {
    volumeUuid: stringValue("VolumeUUID"),
    deviceNode,
    medium,
    fsType: stringValue("FilesystemType") ?? stringValue("FilesystemName"),
    /*
     * The volume's own mount point in preference to the path the caller asked
     * about, because this record describes a *volume*: `/Volumes/Expansion` is
     * the identity, `/Volumes/Expansion/media` is one directory that happens to
     * sit on it. Nothing compares this field — recovery is decided on UUID,
     * medium and filesystem — and the incident row stores the configured root
     * separately, so it is reporting only, and the more useful thing to report
     * is where the volume actually is.
     */
    mountPath: stringValue("MountPoint") ?? fallbackMountPath,
  };
}

/**
 * The filesystem `df` says is backing a path.
 *
 * `df -P` guarantees one header line and one single-line entry per operand, so
 * the device is the first field of the second line. Anything else — no data
 * row, an empty first field — is a refusal rather than a guess.
 */
export function parseDfDevice(stdout: string): string | null {
  const rows = stdout.split("\n").filter((line) => line.trim() !== "");
  const data = rows[1];
  if (!data) return null;
  const device = data.trim().split(/\s+/)[0];
  return device && device !== "Filesystem" ? device : null;
}

/**
 * The macOS identity probe.
 *
 * Takes **any existing path** and answers for the volume underneath it. That
 * generality is the whole point and it was missing: `diskutil info` only
 * accepts a device or a mount point, so asking it about the configured media
 * root `/Volumes/Expansion/media` exits non-zero, the probe returned `null`,
 * and the fail-closed identity gate parked every job on a healthy USB disk with
 * `recovery-pending`. No caller should have to know where a volume happens to
 * be mounted in order to ask what it is.
 *
 * So the path is resolved to its backing filesystem first, by `df -P`, and it
 * is `df` that is asked rather than the pathname that is parsed: guessing
 * `/Volumes/<first segment>` would be wrong for the internal scratch root,
 * wrong across an APFS firmlink, and wrong for anything mounted anywhere else.
 *
 * Both steps are bounded and metadata-only: neither `df` nor `diskutil info`
 * opens a file on the volume, which matters because this runs at exactly the
 * moment a disk is least worth exercising. Returns `null` on any failure —
 * unresolvable path, failing `diskutil`, or a document that says nothing — a
 * probe that threw during recovery would be one more thing between an operator
 * and a repaired drive, and `null` already fails closed everywhere it is
 * consumed.
 */
export function createDiskutilIdentityProbe(options: {
  run: (
    command: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string>;
  timeoutMs?: number;
}): StorageIdentityProbe {
  return async (path: string) => {
    const timeoutMs = options.timeoutMs ?? 10_000;
    try {
      const device = parseDfDevice(
        await options.run("/bin/df", ["-P", path], timeoutMs),
      );
      /*
       * Nothing to ask about. Falling back to handing `diskutil` the original
       * path is exactly the behaviour being fixed, and inventing an identity
       * is worse than having none.
       */
      if (!device) return null;

      const stdout = await options.run(
        "/usr/sbin/diskutil",
        ["info", "-plist", device],
        timeoutMs,
      );
      const identity = parseDiskutilPlist(stdout, path);
      /*
       * A parse that found nothing at all is not an identity. Returning it
       * would let `medium: "unknown"` masquerade as a reading, when the honest
       * answer is that nothing was learned.
       */
      return identity.volumeUuid === null && identity.medium === "unknown"
        ? null
        : identity;
    } catch {
      return null;
    }
  };
}
