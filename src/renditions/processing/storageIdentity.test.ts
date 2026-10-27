import { describe, expect, it } from "vitest";
import {
  createDiskutilIdentityProbe,
  describeMedium,
  isUncNetworkPath,
  parseDfDevice,
  parseDiskutilPlist,
  requiresOperatorAfterUncleanRestart,
  satisfiesRecovery,
  unknownIdentity,
  type VolumeIdentity,
} from "./storageIdentity";

/**
 * Telling the failed drive from a file pretending to be one.
 *
 * The incident behind this file: a disk image with a partition named
 * `Expansion` was mounted for tests while the failed physical `Expansion` HDD
 * was unplugged. `mount` reported `/dev/disk4s1 on /Volumes/Expansion (exfat)`,
 * and every path-based check in the system agreed that the dangerous drive was
 * back. It was a 2.9 GB image holding synthetic `E2E Title (2026)` media.
 *
 * Nothing here touches a volume: identities are plain objects, and the one
 * `diskutil` test parses a captured plist string.
 */

/** The failed drive, as it would have been recorded when quarantined. */
const EXPANSION: VolumeIdentity = {
  volumeUuid: "11111111-2222-3333-4444-555555555555",
  deviceNode: "/dev/disk6s1",
  medium: "physical-external",
  fsType: "exfat",
  mountPath: "/Volumes/Expansion",
};

/** The E2E image, which has turned up at the same path. */
const E2E_IMAGE: VolumeIdentity = {
  volumeUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  deviceNode: "/dev/disk4s2",
  medium: "disk-image",
  fsType: "hfs",
  mountPath: "/Volumes/SeyirlikE2EMedia",
};

/** Some other USB drive an operator plugged in. */
const OTHER_EXTERNAL: VolumeIdentity = {
  volumeUuid: "99999999-8888-7777-6666-555555555555",
  deviceNode: "/dev/disk6s1",
  medium: "physical-external",
  fsType: "exfat",
  mountPath: "/Volumes/Expansion",
};

describe("what can satisfy recovery for a quarantined drive", () => {
  it("accepts the same physical volume coming back", () => {
    expect(satisfiesRecovery(EXPANSION, { ...EXPANSION })).toEqual({
      ok: true,
    });
  });

  /**
   * Requirement 2. This is the false negative that matters: if mounting an
   * image at the quarantined path satisfied recovery, anyone could hand back a
   * green light for hardware nobody has repaired.
   */
  it("refuses a disk image mounted where the drive used to be", () => {
    const verdict = satisfiesRecovery(EXPANSION, {
      ...E2E_IMAGE,
      mountPath: "/Volumes/Expansion",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("a disk image");
  });

  /** Requirement 3. A different drive at the same path is not the same drive. */
  it("refuses a different external volume at the same path", () => {
    const verdict = satisfiesRecovery(EXPANSION, OTHER_EXTERNAL);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(
      "A different volume",
    );
  });

  /**
   * Requirement 4, stated directly: the decision must not be derivable from the
   * path. Both of these sit at `/Volumes/Expansion`; one is the drive and one
   * is not.
   */
  it("does not decide from the mount path", () => {
    const atSamePath = { ...E2E_IMAGE, mountPath: "/Volumes/Expansion" };
    expect(atSamePath.mountPath).toBe(EXPANSION.mountPath);
    expect(satisfiesRecovery(EXPANSION, atSamePath).ok).toBe(false);

    // And the genuine drive is still recognised when it comes back elsewhere.
    const movedPath = { ...EXPANSION, mountPath: "/Volumes/Expansion 1" };
    expect(satisfiesRecovery(EXPANSION, movedPath)).toEqual({ ok: true });
  });

  /** The Google Drive mount the library moved to: a share with no disk under it. */
  const DRIVE_SHARE: VolumeIdentity = {
    volumeUuid: null,
    deviceNode: null,
    medium: "network",
    fsType: null,
    mountPath: "\\\\seyirlik\\drive",
  };

  it("lets an operator recover a network share, which has no disk to match", () => {
    expect(satisfiesRecovery(null, DRIVE_SHARE)).toEqual({ ok: true });
    expect(satisfiesRecovery(DRIVE_SHARE, { ...DRIVE_SHARE })).toEqual({
      ok: true,
    });
  });

  it("still refuses a network share in place of a quarantined physical drive", () => {
    expect(satisfiesRecovery(EXPANSION, DRIVE_SHARE).ok).toBe(false);
    expect(
      satisfiesRecovery({ ...EXPANSION, volumeUuid: null }, DRIVE_SHARE).ok,
    ).toBe(false);
  });

  it("refuses when nothing is mounted there at all", () => {
    expect(satisfiesRecovery(EXPANSION, null).ok).toBe(false);
  });

  it("refuses a volume that reports no identity", () => {
    expect(
      satisfiesRecovery(EXPANSION, unknownIdentity("/Volumes/Expansion")).ok,
    ).toBe(false);
  });

  /**
   * An incident carried across the upgrade that added identity has nothing to
   * compare. It must not pass silently, or the check is decorative for exactly
   * the incidents that predate it — which includes the one that motivated it.
   */
  it("refuses to auto-satisfy a quarantine recorded without an identity", () => {
    const verdict = satisfiesRecovery(
      { ...EXPANSION, volumeUuid: null },
      EXPANSION,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain(
      "without a volume identity",
    );
  });

  /** A reformat is a different filesystem wearing a recycled identity. */
  it("refuses a volume that has been reformatted", () => {
    const verdict = satisfiesRecovery(EXPANSION, {
      ...EXPANSION,
      fsType: "apfs",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("reformatted");
  });

  /*
   * A restore onto replacement hardware keeps the filesystem's UUID while
   * changing the disk underneath it. Every check above this one passes, which
   * is exactly why the serial is worth recording.
   */
  it("refuses the same filesystem sitting on a different physical disk", () => {
    const verdict = satisfiesRecovery(
      { ...EXPANSION, physicalSerial: "00000000NT1FJWY0" },
      { ...EXPANSION, physicalSerial: "SOMEOTHERDISK123" },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("physical disk");
  });

  it("accepts the same disk when both readings agree on its serial", () => {
    const withSerial = { ...EXPANSION, physicalSerial: "00000000NT1FJWY0" };
    expect(satisfiesRecovery(withSerial, { ...withSerial }).ok).toBe(true);
  });

  /*
   * The backward-compatible half, and the reason the check is null-guarded on
   * both sides. Identities recorded before this field existed carry no serial,
   * and a platform that does not report one never will; neither may become an
   * unsatisfiable quarantine.
   */
  it("does not hold a missing serial against a volume on either side", () => {
    expect(
      satisfiesRecovery(EXPANSION, {
        ...EXPANSION,
        physicalSerial: "00000000NT1FJWY0",
      }).ok,
    ).toBe(true);
    expect(
      satisfiesRecovery(
        { ...EXPANSION, physicalSerial: "00000000NT1FJWY0" },
        { ...EXPANSION, physicalSerial: null },
      ).ok,
    ).toBe(true);
  });
});

describe("which volumes need an operator after an unclean restart", () => {
  /**
   * Requirement 5. Holding the E2E suite for an operator because its image sits
   * under `/Volumes` would make the whole mechanism something people learn to
   * click through.
   */
  it("does not hold work on a disk image", () => {
    expect(
      requiresOperatorAfterUncleanRestart(
        E2E_IMAGE,
        "/Volumes/SeyirlikE2EMedia",
      ),
    ).toBe(false);
  });

  it("holds work on external physical media", () => {
    expect(
      requiresOperatorAfterUncleanRestart(EXPANSION, "/Volumes/Expansion"),
    ).toBe(true);
  });

  it("holds work on a network volume", () => {
    expect(
      requiresOperatorAfterUncleanRestart(
        { ...EXPANSION, medium: "network" },
        "/mnt/library",
      ),
    ).toBe(true);
  });

  it("does not hold work on an internal disk", () => {
    expect(
      requiresOperatorAfterUncleanRestart(
        { ...EXPANSION, medium: "physical-internal" },
        "/srv/media",
      ),
    ).toBe(false);
  });

  /**
   * With no identity available the path heuristic stands, which is both the
   * cautious direction and exactly the behaviour that shipped before identity
   * existed.
   */
  it("falls back to the path when identity is unavailable", () => {
    expect(
      requiresOperatorAfterUncleanRestart(null, "/Volumes/Expansion/media"),
    ).toBe(true);
    expect(requiresOperatorAfterUncleanRestart(null, "/srv/media")).toBe(false);
    expect(
      requiresOperatorAfterUncleanRestart(
        unknownIdentity("/Volumes/Expansion"),
        "/Volumes/Expansion/media",
      ),
    ).toBe(true);
  });
});

describe("the fallback heuristic on a Windows host", () => {
  /**
   * The regression this fixes. With no probe — which is every Windows
   * deployment before the Windows implementation, and any host whose probe
   * fails — identity is `null` and this heuristic is the only thing standing
   * between an unclean restart and an unattended resume. It knew four POSIX
   * prefixes and nothing else, so every Windows path answered `false`,
   * including a network share that had gone away mid-encode.
   */
  it("holds work on a vanished network share", () => {
    expect(requiresOperatorAfterUncleanRestart(null, "\\\\nas\\media")).toBe(
      true,
    );
    expect(requiresOperatorAfterUncleanRestart(null, "//nas/media")).toBe(true);
    expect(
      requiresOperatorAfterUncleanRestart(null, "\\\\?\\UNC\\nas\\media"),
    ).toBe(true);
  });

  it("does not read a long local path as a network share", () => {
    // `\\?\D:\media` is the extended-length form of a local drive. Treating
    // its leading slashes as UNC would hold work on internal storage.
    expect(requiresOperatorAfterUncleanRestart(null, "\\\\?\\D:\\media")).toBe(
      false,
    );
    expect(requiresOperatorAfterUncleanRestart(null, "\\\\.\\D:\\media")).toBe(
      false,
    );
  });

  it("does not hold work on a lettered volume, which the path cannot classify", () => {
    // `D:` may be the USB disk or a second internal SSD. Answering `true` for
    // every letter would prompt after any restart and teach an operator to
    // dismiss the prompt that matters. The probe is what tells them apart.
    expect(requiresOperatorAfterUncleanRestart(null, "D:\\media")).toBe(false);
    expect(requiresOperatorAfterUncleanRestart(null, "C:\\scratch")).toBe(
      false,
    );
  });

  it("still answers for the POSIX prefixes it already knew", () => {
    expect(
      requiresOperatorAfterUncleanRestart(null, "/Volumes/Expansion"),
    ).toBe(true);
    expect(requiresOperatorAfterUncleanRestart(null, "/mnt/media")).toBe(true);
    expect(requiresOperatorAfterUncleanRestart(null, "/srv/media")).toBe(false);
  });

  it("prefers a real identity over the path, on Windows as anywhere", () => {
    // A UNC path whose probe said "internal" is internal. Identity wins.
    expect(
      requiresOperatorAfterUncleanRestart(
        { ...unknownIdentity("\\\\nas\\media"), medium: "physical-internal" },
        "\\\\nas\\media",
      ),
    ).toBe(false);
  });
});

describe("reading a volume's identity from diskutil", () => {
  /** The shape macOS actually returns for an attached USB disk. */
  it("recognises external physical media", () => {
    const identity = parseDiskutilPlist(
      `<plist><dict>
         <key>VolumeUUID</key><string>11111111-2222-3333-4444-555555555555</string>
         <key>DeviceNode</key><string>/dev/disk6s1</string>
         <key>BusProtocol</key><string>USB</string>
         <key>DeviceInternal</key><false/>
         <key>FilesystemType</key><string>exfat</string>
       </dict></plist>`,
      "/Volumes/Expansion",
    );
    expect(identity.medium).toBe("physical-external");
    expect(identity.volumeUuid).toBe("11111111-2222-3333-4444-555555555555");
    expect(identity.fsType).toBe("exfat");
  });

  /** And for the image that caused the confusion. */
  it("recognises a disk image, however it is named or mounted", () => {
    const identity = parseDiskutilPlist(
      `<plist><dict>
         <key>VolumeUUID</key><string>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</string>
         <key>DeviceNode</key><string>/dev/disk4s2</string>
         <key>BusProtocol</key><string>Disk Image</string>
         <key>DeviceInternal</key><false/>
         <key>VirtualOrPhysical</key><string>Virtual</string>
         <key>FilesystemType</key><string>hfs</string>
       </dict></plist>`,
      "/Volumes/Expansion",
    );
    /*
     * Mounted at the dangerous path, reporting `DeviceInternal false` exactly
     * as a USB disk does. Only the protocol tells them apart, which is why the
     * path was never going to be enough.
     */
    expect(identity.medium).toBe("disk-image");
  });

  it("recognises an internal disk", () => {
    const identity = parseDiskutilPlist(
      `<plist><dict>
         <key>BusProtocol</key><string>PCI-Express</string>
         <key>DeviceInternal</key><true/>
       </dict></plist>`,
      "/",
    );
    expect(identity.medium).toBe("physical-internal");
  });

  /** A probe that cannot say must say so, not guess. */
  it("reports unknown rather than inventing a medium", () => {
    const identity = parseDiskutilPlist("<plist><dict></dict></plist>", "/x");
    expect(identity.medium).toBe("unknown");
    expect(identity.volumeUuid).toBeNull();
  });

  it("does not throw on malformed output", () => {
    expect(() => parseDiskutilPlist("not a plist at all", "/x")).not.toThrow();
  });
});

describe("how a medium is described to an operator", () => {
  it("uses words that distinguish the two that were confused", () => {
    expect(describeMedium("physical-external")).toBe("external physical media");
    expect(describeMedium("disk-image")).toBe("a disk image");
  });
});

/**
 * The durability audit, stated as the ten cases that decide whether a
 * quarantine can be satisfied.
 *
 * The rule under test: a volume UUID is the only authoritative identity. A
 * device node is a diagnostic; a medium and a filesystem are attributes; a
 * mount path is a location. None of the last three, alone or together,
 * identifies a disk.
 */
describe("what is and is not a durable storage identity", () => {
  /** 1. Disk numbers are assigned in attachment order, so they move. */
  it("treats the same UUID at a different /dev/diskN as the same volume", () => {
    const reconnected = { ...EXPANSION, deviceNode: "/dev/disk9s1" };
    expect(satisfiesRecovery(EXPANSION, reconnected)).toEqual({ ok: true });
  });

  /** 2. macOS mounts a second volume of the same name at "Expansion 1". */
  it("treats the same UUID at a different mount path as the same volume", () => {
    const moved = { ...EXPANSION, mountPath: "/Volumes/Expansion 1" };
    expect(satisfiesRecovery(EXPANSION, moved)).toEqual({ ok: true });
  });

  /** 3. The converse: the old number handed to a different disk. */
  it("treats a different UUID at the same /dev/diskN as a different volume", () => {
    const impostor = {
      ...EXPANSION,
      volumeUuid: "00000000-0000-0000-0000-000000000000",
    };
    expect(satisfiesRecovery(EXPANSION, impostor).ok).toBe(false);
  });

  /** 4. And the same at the quarantined path. */
  it("treats a different UUID at /Volumes/Expansion as a different volume", () => {
    expect(
      satisfiesRecovery(EXPANSION, {
        ...OTHER_EXTERNAL,
        mountPath: "/Volumes/Expansion",
      }).ok,
    ).toBe(false);
  });

  /**
   * 5. The case that most tempts a shortcut: everything matches except the one
   * field that identifies anything. "external + exfat at /Volumes/Expansion"
   * describes a great many disks.
   */
  it("refuses a volume matching on medium, filesystem and path but not UUID", () => {
    const lookalike: VolumeIdentity = {
      volumeUuid: "deadbeef-0000-0000-0000-000000000000",
      deviceNode: EXPANSION.deviceNode,
      medium: EXPANSION.medium,
      fsType: EXPANSION.fsType,
      mountPath: EXPANSION.mountPath,
    };
    expect(lookalike.medium).toBe(EXPANSION.medium);
    expect(lookalike.fsType).toBe(EXPANSION.fsType);
    expect(lookalike.mountPath).toBe(EXPANSION.mountPath);
    expect(satisfiesRecovery(EXPANSION, lookalike).ok).toBe(false);
  });

  /** 6. The image that started all of this. */
  it("never accepts a disk image as the physical Expansion storage", () => {
    const namedExpansion: VolumeIdentity = {
      ...E2E_IMAGE,
      mountPath: "/Volumes/Expansion",
    };
    const verdict = satisfiesRecovery(EXPANSION, namedExpansion);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("a disk image");
  });

  /** 7. No identity, after a hard quarantine, is a refusal — never a pass. */
  it("fails closed when the current volume reports no UUID", () => {
    expect(
      satisfiesRecovery(EXPANSION, { ...EXPANSION, volumeUuid: null }).ok,
    ).toBe(false);
    expect(satisfiesRecovery(EXPANSION, unknownIdentity()).ok).toBe(false);
    expect(satisfiesRecovery(EXPANSION, null).ok).toBe(false);
  });

  /**
   * 8. A reboot renumbers everything. The drive that was `/dev/disk6s1` may come
   * back as `/dev/disk4s1`, and an unrelated disk may take `/dev/disk6s1` — so
   * matching on the node would both reject the real drive and accept a stranger.
   */
  it("cannot be satisfied by device-node reuse across a reboot", () => {
    const strangerOnOldNode: VolumeIdentity = {
      volumeUuid: "77777777-7777-7777-7777-777777777777",
      deviceNode: "/dev/disk6s1",
      medium: "physical-external",
      fsType: "exfat",
      mountPath: "/Volumes/Expansion",
    };
    expect(strangerOnOldNode.deviceNode).toBe(EXPANSION.deviceNode);
    expect(satisfiesRecovery(EXPANSION, strangerOnOldNode).ok).toBe(false);

    // And the genuine drive on a new node is still accepted.
    expect(
      satisfiesRecovery(EXPANSION, { ...EXPANSION, deviceNode: "/dev/disk4s1" })
        .ok,
    ).toBe(true);
  });

  /** 9. The E2E image cannot release the drive, wherever it is mounted. */
  it("never lets SeyirlikE2EMedia release Expansion", () => {
    for (const mountPath of [
      "/Volumes/SeyirlikE2EMedia",
      "/Volumes/Expansion",
      "/Volumes/Expansion 1",
    ]) {
      expect(satisfiesRecovery(EXPANSION, { ...E2E_IMAGE, mountPath }).ok).toBe(
        false,
      );
    }
  });

  /**
   * 10. The node is still worth having — it is what an operator types into
   * `diskutil` — but it is carried, never compared.
   */
  it("keeps the device node for diagnostics without giving it authority", () => {
    const parsed = parseDiskutilPlist(
      `<plist><dict>
         <key>VolumeUUID</key><string>11111111-2222-3333-4444-555555555555</string>
         <key>DeviceNode</key><string>/dev/disk6s1</string>
         <key>BusProtocol</key><string>USB</string>
         <key>DeviceInternal</key><false/>
       </dict></plist>`,
      "/Volumes/Expansion",
    );
    expect(parsed.deviceNode).toBe("/dev/disk6s1");

    /*
     * Authority test: hold the node constant and vary only the UUID, then hold
     * the UUID constant and vary only the node. If the node had any authority
     * the two would not disagree.
     */
    const sameNodeDifferentUuid = {
      ...EXPANSION,
      volumeUuid: "55555555-5555-5555-5555-555555555555",
    };
    const differentNodeSameUuid = { ...EXPANSION, deviceNode: "/dev/disk11s3" };
    expect(satisfiesRecovery(EXPANSION, sameNodeDifferentUuid).ok).toBe(false);
    expect(satisfiesRecovery(EXPANSION, differentNodeSameUuid).ok).toBe(true);
  });
});

/**
 * The bug that parked a healthy drive.
 *
 * The media root is configured as `/Volumes/Expansion/media`, and the probe
 * handed that straight to `diskutil info -plist`, which only accepts a device
 * or a mount point and exits 1 on anything else. The probe returned `null`, the
 * fail-closed identity gate had no identity to gate on, and every processing
 * job was parked `recovery-pending` against a USB disk with nothing wrong with
 * it.
 *
 * The plists below are trimmed captures of what this machine actually returned
 * for `/dev/disk4s1` (the Expansion HDD) and `/dev/disk3s5` (the internal APFS
 * data volume the scratch root lives on) — including the `Internal` key that
 * current macOS emits in place of the `DeviceInternal` the older fixtures use.
 */
describe("resolving an arbitrary path to the volume underneath it", () => {
  const EXPANSION_PLIST = `<plist><dict>
     <key>BusProtocol</key><string>USB</string>
     <key>DeviceIdentifier</key><string>disk4s1</string>
     <key>DeviceNode</key><string>/dev/disk4s1</string>
     <key>FilesystemType</key><string>exfat</string>
     <key>Internal</key><false/>
     <key>MountPoint</key><string>/Volumes/Expansion</string>
     <key>VolumeUUID</key><string>885D7C8D-8088-315E-AAFF-0B9537DADFD8</string>
   </dict></plist>`;

  const INTERNAL_PLIST = `<plist><dict>
     <key>BusProtocol</key><string>Apple Fabric</string>
     <key>DeviceIdentifier</key><string>disk3s5</string>
     <key>DeviceNode</key><string>/dev/disk3s5</string>
     <key>FilesystemType</key><string>apfs</string>
     <key>Internal</key><true/>
     <key>MountPoint</key><string>/System/Volumes/Data</string>
     <key>VolumeUUID</key><string>A0B2DA7F-6472-4ADA-85A9-7AA6E181686A</string>
   </dict></plist>`;

  const df = (device: string, mountedOn: string) =>
    `Filesystem   512-blocks       Used  Available Capacity  Mounted on\n${device} 3906904320 2754344448 1152559872    71%    ${mountedOn}\n`;

  /**
   * A fake host: `df` answers for the two real paths, `diskutil` answers only
   * for a device node. Handing it a directory fails exactly as the real tool
   * does, which is what makes this a regression test rather than a restatement.
   */
  function host(overrides: { failDf?: boolean; failDiskutil?: boolean } = {}) {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const run = async (
      command: string,
      args: readonly string[],
      timeoutMs: number,
    ) => {
      calls.push({ command, args });
      expect(timeoutMs).toBeGreaterThan(0);
      if (command === "/bin/df") {
        if (overrides.failDf) throw new Error("df: No such file or directory");
        const target = args[args.length - 1];
        if (target?.startsWith("/Volumes/Expansion")) {
          return df("/dev/disk4s1", "/Volumes/Expansion");
        }
        if (target?.startsWith("/Users/")) {
          return df("/dev/disk3s5", "/System/Volumes/Data");
        }
        throw new Error("df: No such file or directory");
      }
      if (overrides.failDiskutil) {
        throw new Error("the volume identity probe failed with exit code 1");
      }
      const device = args[args.length - 1];
      if (device === "/dev/disk4s1") return EXPANSION_PLIST;
      if (device === "/dev/disk3s5") return INTERNAL_PLIST;
      // Exactly what the old code hit: diskutil will not take a directory.
      throw new Error("the volume identity probe failed with exit code 1");
    };
    return { run, calls };
  }

  /** A. The production failure, in the shape it actually occurred. */
  it("identifies the external volume from a nested path inside it", async () => {
    const { run, calls } = host();
    const probe = createDiskutilIdentityProbe({ run });

    const identity = await probe("/Volumes/Expansion/media");

    expect(identity).not.toBeNull();
    expect(identity?.volumeUuid).toBe("885D7C8D-8088-315E-AAFF-0B9537DADFD8");
    expect(identity?.medium).toBe("physical-external");
    expect(identity?.fsType).toBe("exfat");
    expect(identity?.deviceNode).toBe("/dev/disk4s1");
    // The volume, not the directory that happened to be configured.
    expect(identity?.mountPath).toBe("/Volumes/Expansion");

    // Resolution first, and `diskutil` is asked about a device, never a path.
    expect(calls[0]).toEqual({
      command: "/bin/df",
      args: ["-P", "/Volumes/Expansion/media"],
    });
    expect(calls[1]).toEqual({
      command: "/usr/sbin/diskutil",
      args: ["info", "-plist", "/dev/disk4s1"],
    });
  });

  /**
   * B. The scratch root, which is the same question and must not grow a second
   * answer: a nested path on an internal APFS volume, reached through a
   * firmlink, where guessing `/Volumes/<name>` from the pathname gets nowhere.
   */
  it("identifies the internal volume behind a nested scratch path", async () => {
    const probe = createDiskutilIdentityProbe({ run: host().run });

    const identity = await probe(
      "/Users/sonat/Documents/.seyirlik/processing-scratch",
    );

    expect(identity?.volumeUuid).toBe("A0B2DA7F-6472-4ADA-85A9-7AA6E181686A");
    expect(identity?.medium).toBe("physical-internal");
    expect(identity?.fsType).toBe("apfs");
  });

  /** C. No resolution, no identity. Nothing is invented from the pathname. */
  it("returns null when the path cannot be resolved to a filesystem", async () => {
    const { run, calls } = host({ failDf: true });
    expect(
      await createDiskutilIdentityProbe({ run })("/Volumes/Gone"),
    ).toBeNull();
    // And it did not fall back to asking diskutil about the path itself.
    expect(calls.every((call) => call.command === "/bin/df")).toBe(true);
  });

  it("returns null when df says nothing usable", async () => {
    const probe = createDiskutilIdentityProbe({
      run: async () =>
        "Filesystem 512-blocks Used Available Capacity Mounted on\n",
    });
    expect(await probe("/Volumes/Expansion/media")).toBeNull();
  });

  /** D. `diskutil` itself failing is the same answer: none. */
  it("returns null when diskutil fails", async () => {
    const probe = createDiskutilIdentityProbe({
      run: host({ failDiskutil: true }).run,
    });
    expect(await probe("/Volumes/Expansion/media")).toBeNull();
  });

  it("returns null rather than an empty identity when the plist says nothing", async () => {
    const probe = createDiskutilIdentityProbe({
      run: async (command) =>
        command === "/bin/df"
          ? df("/dev/disk4s1", "/Volumes/Expansion")
          : "<plist><dict></dict></plist>",
    });
    expect(await probe("/Volumes/Expansion/media")).toBeNull();
  });

  it("bounds every subprocess it runs", async () => {
    const timeouts: number[] = [];
    const inner = host().run;
    const probe = createDiskutilIdentityProbe({
      run: async (command, args, timeoutMs) => {
        timeouts.push(timeoutMs);
        return inner(command, args, timeoutMs);
      },
      timeoutMs: 4_000,
    });
    await probe("/Volumes/Expansion/media");
    expect(timeouts).toEqual([4_000, 4_000]);
  });
});

describe("the keys current macOS actually emits", () => {
  /** The live spelling. This is the second half of the production failure. */
  it("reads `Internal` for an external volume", () => {
    const identity = parseDiskutilPlist(
      `<plist><dict>
         <key>VolumeUUID</key><string>885D7C8D-8088-315E-AAFF-0B9537DADFD8</string>
         <key>DeviceIdentifier</key><string>disk4s1</string>
         <key>BusProtocol</key><string>USB</string>
         <key>Internal</key><false/>
         <key>FilesystemType</key><string>exfat</string>
         <key>MountPoint</key><string>/Volumes/Expansion</string>
       </dict></plist>`,
      "/Volumes/Expansion/media",
    );
    expect(identity.medium).toBe("physical-external");
    expect(identity.fsType).toBe("exfat");
    expect(identity.mountPath).toBe("/Volumes/Expansion");
    // No DeviceNode in this capture: rebuilt from the identifier, one shape.
    expect(identity.deviceNode).toBe("/dev/disk4s1");
  });

  it("reads `Internal` for an internal volume", () => {
    const identity = parseDiskutilPlist(
      `<plist><dict>
         <key>Internal</key><true/>
         <key>FilesystemType</key><string>apfs</string>
         <key>VolumeUUID</key><string>A0B2DA7F-6472-4ADA-85A9-7AA6E181686A</string>
       </dict></plist>`,
      "/Users/sonat/Documents/.seyirlik/processing-scratch",
    );
    expect(identity.medium).toBe("physical-internal");
  });

  /**
   * E. The older spelling still decides, because a host that emits it is a host
   * whose volumes must still be classified — and because the fixtures above in
   * this file are written that way.
   */
  it("still understands DeviceInternal where that is all there is", () => {
    expect(
      parseDiskutilPlist(
        `<plist><dict><key>DeviceInternal</key><false/>
           <key>VolumeUUID</key><string>1</string></dict></plist>`,
        "/x",
      ).medium,
    ).toBe("physical-external");
    expect(
      parseDiskutilPlist(
        `<plist><dict><key>DeviceInternal</key><true/></dict></plist>`,
        "/x",
      ).medium,
    ).toBe("physical-internal");
  });

  /** A disk image still wins over `Internal false`, which it also reports. */
  it("keeps a disk image a disk image under the new key", () => {
    expect(
      parseDiskutilPlist(
        `<plist><dict>
           <key>BusProtocol</key><string>Disk Image</string>
           <key>Internal</key><false/>
           <key>VolumeUUID</key><string>aaaa</string>
         </dict></plist>`,
        "/Volumes/Expansion",
      ).medium,
    ).toBe("disk-image");
  });

  it("falls back to the caller's path when the plist has no mount point", () => {
    expect(
      parseDiskutilPlist(
        `<plist><dict><key>VolumeUUID</key><string>1</string></dict></plist>`,
        "/Volumes/Expansion/media",
      ).mountPath,
    ).toBe("/Volumes/Expansion/media");
  });

  it("reads a df data row and refuses a header-only one", () => {
    expect(
      parseDfDevice(
        "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk4s1 1 1 1 71% /Volumes/Expansion\n",
      ),
    ).toBe("/dev/disk4s1");
    expect(parseDfDevice("Filesystem 512-blocks Mounted on\n")).toBeNull();
    expect(parseDfDevice("")).toBeNull();
  });
});

describe("isUncNetworkPath", () => {
  it("recognises the Drive mount as the Windows hosts see it", () => {
    expect(
      isUncNetworkPath(
        "\\\\seyirlik\\drive\\media\\Series\\House of the Dragon\\Season 2\\src\\House of the Dragon - S02E04.mkv",
      ),
    ).toBe(true);
    expect(isUncNetworkPath("\\\\?\\UNC\\seyirlik\\drive\\media")).toBe(true);
  });

  it("does not mistake local paths for shares", () => {
    expect(isUncNetworkPath("D:\\media\\film.mkv")).toBe(false);
    expect(isUncNetworkPath("\\\\?\\D:\\media\\film.mkv")).toBe(false);
    expect(isUncNetworkPath("/Volumes/Expansion/film.mkv")).toBe(false);
  });
});
