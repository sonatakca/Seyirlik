import { describe, expect, it } from "vitest";
import type {
  AvailableQualityFile,
  QualityPreferenceMode,
} from "../../renditions/contracts";
import {
  adaptiveQualityRequestForMode,
  AUTO_QUALITY_LEVELS,
  canonicalRungClass,
  selectAdaptiveTargetRung,
  loadQualityPreference,
  isQualityAudioCompatible,
  resolveManualHeight,
  resolvePlaybackQualityTarget,
  saveQualityPreference,
  displayTargetHeight,
  selectAutoQuality,
  selectHigherResolutionQuality,
  selectHigherResolutionRung,
  selectModeRungs,
  selectModeRungsFromAutoHeight,
  selectLowDataQuality,
  selectLowDataRung,
  selectManualQuality,
  shouldSwitchFileQuality,
} from "./qualityPreference";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const qualities: AvailableQualityFile[] = [
  {
    id: "original",
    label: "Original (2160p)",
    kind: "original",
    width: 3840,
    height: 2160,
    playbackUrl: "/original",
  },
  {
    id: "generated-1080",
    label: "1080p",
    kind: "generated",
    width: 1920,
    height: 1080,
    playbackUrl: "/1080.mp4",
  },
  {
    id: "generated-720",
    label: "720p",
    kind: "generated",
    width: 1280,
    height: 720,
    playbackUrl: "/720.mp4",
  },
  {
    id: "generated-480",
    label: "480p",
    kind: "generated",
    width: 854,
    height: 480,
    playbackUrl: "/480.mp4",
  },
];

describe("quality preference persistence", () => {
  it("keeps native Auto uncapped while biased and Advanced modes stay bounded", () => {
    expect(adaptiveQualityRequestForMode("auto", 1080)).toEqual({});
    expect(adaptiveQualityRequestForMode("low-data", 720)).toEqual({
      maxHeight: 720,
    });
    expect(adaptiveQualityRequestForMode("higher-resolution", 1440)).toEqual({
      maxHeight: 1440,
    });
    expect(adaptiveQualityRequestForMode("advanced", 2160)).toEqual({
      qualityHeight: 2160,
    });
  });

  it("defaults to Auto and isolates preferences by user", () => {
    const storage = new MemoryStorage();
    saveQualityPreference({ mode: "low-data" }, "user-a", storage);

    expect(loadQualityPreference("user-a", storage)).toEqual({
      mode: "low-data",
    });
    expect(loadQualityPreference("user-b", storage)).toEqual({ mode: "auto" });
  });

  it("persists a stable manual quality id and rejects invalid values safely", () => {
    const storage = new MemoryStorage();
    saveQualityPreference(
      {
        mode: "advanced",
        preferredHeight: 720,
        preferredQualityId: "generated-720",
      },
      "user-a",
      storage,
    );
    expect(loadQualityPreference("user-a", storage)).toEqual({
      mode: "advanced",
      preferredHeight: 720,
      preferredQualityId: "generated-720",
    });

    storage.setItem(
      "seyirlik:quality-preference:user-a",
      '{"mode":"ultra","preferredHeight":999}',
    );
    expect(loadQualityPreference("user-a", storage)).toEqual({ mode: "auto" });
  });

  it("persists an automatic mode without a stale derived resolution", () => {
    const storage = new MemoryStorage();
    saveQualityPreference(
      {
        mode: "higher-resolution",
        preferredHeight: 1440,
        preferredQualityId: "generated-1440",
      },
      "user-a",
      storage,
    );

    expect(loadQualityPreference("user-a", storage)).toEqual({
      mode: "higher-resolution",
    });
    expect(storage.getItem("seyirlik:quality-preference:user-a")).toBe(
      '{"mode":"higher-resolution"}',
    );
  });

  it("chooses the nearest lower manual height and never silently upgrades", () => {
    expect(resolveManualHeight(1080, [2160, 720, 480])).toBe(720);
    expect(resolveManualHeight(360, [2160, 720, 480])).toBe(480);
    expect(resolveManualHeight(720, [1080, 720, 480])).toBe(720);
  });
});

describe("deriving the biased modes from a stable anchor", () => {
  const ladder = [144, 240, 360, 480, 720, 1080, 1440, 2160].map((height) => ({
    id: `${height}p`,
    height,
  }));

  /**
   * The ratchet this guards.
   *
   * Low Data was derived from the rung currently on screen. Applying it capped
   * playback at 1080p, so the next read saw 1080p as "what Auto chose" and
   * offered 720p instead — the menu walked downwards every time it was opened,
   * and Auto itself appeared to fall from 2160p to 1080p.
   */
  it("does not move its own target when the bias is applied", () => {
    const fromAuto = selectModeRungsFromAutoHeight(ladder, 2160);
    expect(fromAuto.anchor?.id).toBe("2160p");
    expect(fromAuto.lowData?.id).toBe("1080p");

    /*
     * The anchor is remembered from Auto, so asking again while Low Data is
     * active — when the decoded rung is 1080p — must give the same answer.
     */
    const askedAgain = selectModeRungsFromAutoHeight(ladder, 2160);
    expect(askedAgain.lowData?.id).toBe("1080p");
    expect(askedAgain.anchor?.id).toBe("2160p");
  });

  /** Reading the anchor from the capped rung is what produced the slide. */
  it("shows how deriving from the capped rung would slide downwards", () => {
    const first = selectModeRungsFromAutoHeight(ladder, 2160).lowData!.height;
    const second = selectModeRungsFromAutoHeight(ladder, first).lowData!.height;
    const third = selectModeRungsFromAutoHeight(ladder, second).lowData!.height;

    // Each step is strictly lower — exactly the behaviour the fix prevents by
    // never re-learning the anchor while a bias is in force.
    expect(first).toBeGreaterThan(second);
    expect(second).toBeGreaterThan(third);
  });

  it("keeps Higher Quality above the anchor and bounded by the ladder", () => {
    expect(selectModeRungsFromAutoHeight(ladder, 1080).higher?.id).toBe(
      "1440p",
    );
    // At the top there is nowhere further to go.
    expect(selectModeRungsFromAutoHeight(ladder, 2160).higher?.id).toBe(
      "2160p",
    );
  });
});

describe("complete-file quality selection", () => {
  it("does not silently replace a selected audio track with a generated file encoded from another track", () => {
    const generated = qualities.find(
      (quality) => quality.id === "generated-720",
    )!;
    const original = qualities.find((quality) => quality.kind === "original")!;
    const generatedWithAudio = { ...generated, sourceAudioStreamIndex: 1 };

    expect(isQualityAudioCompatible(generatedWithAudio, 1)).toBe(true);
    expect(isQualityAudioCompatible(generatedWithAudio, 2)).toBe(false);
    expect(isQualityAudioCompatible(original, 2)).toBe(true);
  });

  it("selects only existing files for Low Data and Higher Resolution", () => {
    /*
     * This ladder prices nothing, so the anchor rests on the unmeasured-link
     * ceiling of 1080p — Low Data is the rung below it and Higher Resolution
     * the rung above, rather than the ends of the array.
     */
    expect(selectLowDataQuality(qualities)?.id).toBe("generated-720");
    // Higher Quality asks for 1440p, then falls back downward to the existing
    // 1080p file rather than jumping to the 2160p source.
    expect(selectHigherResolutionQuality(qualities)?.id).toBe("generated-1080");
    // Remove the anchor itself and the whole menu shifts down with it.
    expect(
      selectLowDataQuality(
        qualities.filter((quality) => quality.height !== 1080),
      )?.id,
    ).toBe("generated-480");
  });

  it("selects Auto from player size and conservative network information", () => {
    expect(
      selectAutoQuality(qualities, {
        playerHeight: 360,
        devicePixelRatio: 1,
        saveData: true,
      })?.height,
    ).toBe(480);
    expect(
      selectAutoQuality(qualities, {
        playerHeight: 600,
        devicePixelRatio: 1,
      })?.height,
    ).toBe(720);
    // Safari and Firefox report no connection info. Auto used to cap at 720p
    // there no matter how large the player was, so it could never climb.
    expect(
      selectAutoQuality(qualities, {
        playerHeight: 1000,
        devicePixelRatio: 2,
      })?.height,
    ).toBe(1080);
    expect(
      selectAutoQuality(qualities, {
        playerHeight: 900,
        devicePixelRatio: 1,
        downlinkMbps: 15,
      })?.height,
    ).toBe(1080);
    expect(
      selectAutoQuality(qualities, {
        playerHeight: 2160,
        devicePixelRatio: 2,
        downlinkMbps: 30,
      })?.height,
    ).toBe(2160);
  });

  /**
   * A ladder with real costs, so bandwidth decisions can be checked rather than
   * only screen-size ones.
   */
  const priced: AvailableQualityFile[] = [
    {
      id: "p144",
      label: "144p",
      kind: "generated",
      width: 256,
      height: 144,
      bitrate: 181_231,
      playbackUrl: "/144",
    },
    {
      id: "p240",
      label: "240p",
      kind: "generated",
      width: 426,
      height: 240,
      bitrate: 350_980,
      playbackUrl: "/240",
    },
    {
      id: "p360",
      label: "360p",
      kind: "generated",
      width: 640,
      height: 360,
      bitrate: 700_834,
      playbackUrl: "/360",
    },
    {
      id: "p480",
      label: "480p",
      kind: "generated",
      width: 854,
      height: 480,
      bitrate: 1_399_773,
      playbackUrl: "/480",
    },
    {
      id: "p720",
      label: "720p",
      kind: "generated",
      width: 1280,
      height: 720,
      bitrate: 2_997_311,
      playbackUrl: "/720",
    },
    {
      id: "p1080",
      label: "1080p",
      kind: "generated",
      width: 1920,
      height: 1080,
      bitrate: 5_500_436,
      playbackUrl: "/1080",
    },
  ];

  /**
   * The regression this guards: every constraint used to short-circuit to the
   * bottom of the ladder, so Auto was binary — top rung or 144p — and one
   * modest `navigator.connection.downlink` reading pinned a capable link to the
   * floor for good. The rungs in between were never chosen at all.
   */
  it("walks down the ladder in proportion to the measured link", () => {
    const at = (downlinkMbps: number) =>
      selectAutoQuality(priced, {
        playerHeight: 1080,
        devicePixelRatio: 1,
        downlinkMbps,
      })?.height;

    expect(at(20)).toBe(1080);
    expect(at(6)).toBe(720);
    expect(at(3)).toBe(480);
    expect(at(1.6)).toBe(360);
    expect(at(0.8)).toBe(240);
    expect(at(0.35)).toBe(144);
  });

  it("does not drop to the floor merely because the link is under 2.5 Mbps", () => {
    expect(
      selectAutoQuality(priced, {
        playerHeight: 1080,
        devicePixelRatio: 1,
        downlinkMbps: 2.4,
      })?.height,
    ).toBe(480);
  });

  /** Stalls tighten the budget by degrees rather than emptying it at once. */
  it("gives up one rung at a time as stalls accumulate", () => {
    const at = (recentStallCount: number) =>
      selectAutoQuality(priced, {
        playerHeight: 1080,
        devicePixelRatio: 1,
        downlinkMbps: 9,
        recentStallCount,
      })?.height;

    expect(at(0)).toBe(1080);
    expect(at(1)).toBe(720);
    expect(at(2)).toBe(480);
  });

  /** A stated preference to spend less data is obeyed, unlike a measurement. */
  it("still honours save-data absolutely", () => {
    expect(
      selectAutoQuality(priced, {
        playerHeight: 1080,
        devicePixelRatio: 1,
        downlinkMbps: 50,
        saveData: true,
      })?.height,
    ).toBe(144);
  });

  /** The display still decides the ceiling when bandwidth is ample. */
  it("never exceeds what the display can show", () => {
    expect(
      selectAutoQuality(priced, {
        playerHeight: 400,
        devicePixelRatio: 1,
        downlinkMbps: 100,
      })?.height,
    ).toBe(480);
  });

  /**
   * Ford v Ferrari's real ladder. These are the average bitrates, because that
   * is what the quality manifest reports to the player — the master's own
   * BANDWIDTH figures are peaks and would misjudge every budget.
   */
  const fordLadder = [
    { id: "144p", height: 144, bitrate: 326_344 },
    { id: "240p", height: 240, bitrate: 450_605 },
    { id: "360p", height: 360, bitrate: 662_704 },
    { id: "480p", height: 480, bitrate: 1_358_229 },
    { id: "720p", height: 720, bitrate: 2_158_280 },
    { id: "1080p", height: 1080, bitrate: 3_187_375 },
    { id: "2160p", height: 2160, bitrate: 6_891_111 },
  ];

  it("derives the exact bounded targets from the canonical ladder", () => {
    expect(AUTO_QUALITY_LEVELS).toEqual([
      144, 240, 360, 480, 720, 1080, 1440, 2160,
    ]);

    const expected = [
      [144, 144, 720],
      [240, 144, 720],
      [360, 240, 720],
      [480, 360, 720],
      [720, 480, 1080],
      [1080, 720, 1440],
      [1440, 1080, 2160],
      [2160, 1080, 2160],
    ] as const;

    for (const [auto, lowData, higher] of expected) {
      expect(resolvePlaybackQualityTarget(auto, "low-data")).toBe(lowData);
      expect(resolvePlaybackQualityTarget(auto, "auto")).toBe(auto);
      expect(resolvePlaybackQualityTarget(auto, "higher-resolution")).toBe(
        higher,
      );
    }
  });

  it("tracks a changing Auto recommendation without freezing the old target", () => {
    const targetsAt = (auto: number) => [
      resolvePlaybackQualityTarget(auto, "low-data"),
      resolvePlaybackQualityTarget(auto, "auto"),
      resolvePlaybackQualityTarget(auto, "higher-resolution"),
    ];

    expect(targetsAt(720)).toEqual([480, 720, 1080]);
    expect(targetsAt(1080)).toEqual([720, 1080, 1440]);
    const modes: Array<Exclude<QualityPreferenceMode, "advanced">> = [
      "low-data",
      "auto",
      "higher-resolution",
      "low-data",
      "auto",
      "higher-resolution",
    ];
    expect(
      modes.map((mode) => resolvePlaybackQualityTarget(1080, mode)),
    ).toEqual([720, 1080, 1440, 720, 1080, 1440]);
  });

  it("derives mode labels from the Auto rung the playback engine reached", () => {
    const reached4k = selectModeRungsFromAutoHeight(fordLadder, 2160);
    expect(reached4k.anchor?.id).toBe("2160p");
    expect(reached4k.lowData?.id).toBe("1080p");
    expect(reached4k.higher?.id).toBe("2160p");

    const droppedTo720 = selectModeRungsFromAutoHeight(fordLadder, 720);
    expect(droppedTo720.anchor?.id).toBe("720p");
    expect(droppedTo720.lowData?.id).toBe("480p");
    expect(droppedTo720.higher?.id).toBe("1080p");
  });

  /**
   * The regression: both modes were the ends of the array. Low Data handed a
   * viewer 144p on a link that would carry 240p for the same intent, and
   * Higher Resolution served 2160p to a 1080p window — several times the
   * bandwidth to paint pixels the screen cannot resolve.
   */
  /**
   * The whole model: one measured decision, with a safer and a sharper
   * neighbour either side of it.
   *
   * Each mode used to carry its own hardcoded budget, so they disagreed about
   * the same connection — Low Data spent a flat 750 kbps whatever the link
   * could do, which on this ladder meant 360p while Auto sustained 4K, and
   * Higher Resolution answered from screen size while ignoring bandwidth
   * entirely. Anchored, the menu always reads as three adjacent rungs.
   */
  it("offers the anchor with one rung either side of it", () => {
    const big = { displayHeight: 2160, devicePixelRatio: 1 };
    const at = (bandwidthBps: number) => {
      const { anchor, lowData, higher } = selectModeRungs(fordLadder, {
        ...big,
        bandwidthBps,
      });
      return [lowData?.id, anchor?.id, higher?.id].join(" < ");
    };

    // Comfortably carrying the 3.19 Mbps 1080p rung.
    // The desired 1440p target is unavailable, so the safe fallback is 1080p.
    expect(at(9_000_000)).toBe("720p < 1080p < 1080p");
    // Enough for 720p, so Low Data is 480p and Higher Resolution is 1080p.
    expect(at(4_000_000)).toBe("480p < 720p < 1080p");
    expect(at(2_500_000)).toBe("360p < 480p < 720p");
  });

  /** At the ends of the ladder there is no neighbour to step to. */
  it("clamps at the ends of the ladder instead of inventing rungs", () => {
    const top = selectModeRungs(fordLadder, {
      displayHeight: 2160,
      devicePixelRatio: 1,
      bandwidthBps: 100_000_000,
    });
    expect(top.anchor?.id).toBe("2160p");
    expect(top.higher?.id).toBe("2160p");
    expect(top.lowData?.id).toBe("1080p");

    const floor = selectModeRungs(fordLadder, {
      displayHeight: 2160,
      devicePixelRatio: 1,
      bandwidthBps: 200_000,
    });
    expect(floor.anchor?.id).toBe("144p");
    expect(floor.lowData?.id).toBe("144p");
    expect(floor.higher?.id).toBe("720p");
  });

  /**
   * The anchor is what the *connection* justifies, so a small window still
   * caps it: paying for rows the window cannot show is the one saving always
   * available for free.
   */
  it("lets the display cap the anchor as well as the link", () => {
    const { anchor, lowData, higher } = selectModeRungs(fordLadder, {
      displayHeight: 480,
      devicePixelRatio: 1,
      bandwidthBps: 100_000_000,
    });
    expect([lowData?.id, anchor?.id, higher?.id]).toEqual([
      "360p",
      "480p",
      "720p",
    ]);
  });

  /** Save-data is a stated preference, not a measurement, so it wins. */
  it("honours save-data absolutely", () => {
    const { anchor, lowData } = selectModeRungs(fordLadder, {
      displayHeight: 2160,
      devicePixelRatio: 1,
      bandwidthBps: 100_000_000,
      saveData: true,
    });
    expect(anchor?.id).toBe("144p");
    expect(lowData?.id).toBe("144p");
  });

  /** With nothing measured, the anchor opens at a safe 1080p rather than 4K. */
  it("opens conservatively when nothing has measured the link", () => {
    const { anchor, higher } = selectModeRungs(fordLadder, {
      displayHeight: 2160,
      devicePixelRatio: 1,
    });
    expect(anchor?.id).toBe("1080p");
    expect(higher?.id).toBe("1080p");
  });

  /** Repeated stalls shrink the budget, so all three modes step down together. */
  it("steps the whole menu down after repeated stalls", () => {
    const steady = selectModeRungs(fordLadder, {
      displayHeight: 2160,
      devicePixelRatio: 1,
      bandwidthBps: 12_000_000,
    });
    const stalling = selectModeRungs(fordLadder, {
      displayHeight: 2160,
      devicePixelRatio: 1,
      bandwidthBps: 12_000_000,
      recentStallCount: 2,
    });
    expect(steady.anchor?.id).toBe("2160p");
    expect(stalling.anchor?.id).toBe("720p");
    expect(stalling.lowData?.id).toBe("480p");
  });

  it("keeps the legacy rung helpers agreeing with the anchor", () => {
    const context = {
      displayHeight: 2160,
      devicePixelRatio: 1,
      bandwidthBps: 9_000_000,
    };
    expect(selectLowDataRung(fordLadder, context)?.id).toBe("720p");
    expect(selectHigherResolutionRung(fordLadder, context)?.id).toBe("1080p");
  });

  it("resolves missing and source-limited renditions safely", () => {
    const missingTargets = [
      { id: "240p", height: 240 },
      { id: "480p", height: 480 },
      { id: "1080p", height: 1080 },
    ];
    const resolved = selectModeRungs(missingTargets, {
      displayHeight: 720,
      bandwidthBps: 100_000_000,
    });
    expect(resolved.anchor?.height).toBe(1080);
    expect(resolved.lowData?.height).toBe(480);
    expect(resolved.higher?.height).toBe(1080);

    const sourceLimited = selectModeRungs(
      missingTargets.filter((quality) => quality.height <= 480),
      { displayHeight: 2160, bandwidthBps: 100_000_000 },
    );
    expect(sourceLimited.anchor?.height).toBe(480);
    expect(sourceLimited.higher?.height).toBe(480);
  });

  it("resolves Advanced only to a quality actually present", () => {
    expect(
      selectManualQuality(qualities, {
        mode: "advanced",
        preferredQualityId: "generated-720",
      })?.playbackUrl,
    ).toBe("/720.mp4");

    // A different title rarely carries the same generated file, so the saved
    // height falls back to the nearest lower available quality.
    expect(
      selectManualQuality(
        qualities.filter((quality) => quality.id !== "generated-720"),
        {
          mode: "advanced",
          preferredQualityId: "generated-720",
          preferredHeight: 720,
        },
      )?.playbackUrl,
    ).toBe("/480.mp4");

    // When nothing lower exists the lowest available quality is used, never a
    // silent upgrade.
    expect(
      selectManualQuality(
        qualities.filter((quality) => quality.height >= 1080),
        {
          mode: "advanced",
          preferredQualityId: "generated-720",
          preferredHeight: 720,
        },
      )?.playbackUrl,
    ).toBe("/1080.mp4");

    // Without a usable height there is nothing to resolve to.
    expect(
      selectManualQuality(qualities, {
        mode: "advanced",
        preferredQualityId: "generated-1440",
      }),
    ).toBeUndefined();
  });

  it("reports what the display can use, with the pixel ratio capped at 2", () => {
    expect(displayTargetHeight(1000, 2)).toBe(2000);
    expect(displayTargetHeight(1000, 4)).toBe(2000);
    expect(displayTargetHeight(1000, undefined)).toBe(1000);
    // A container measured before layout must not collapse the target to zero.
    expect(displayTargetHeight(0, 2)).toBe(2);
  });

  it("uses cooldown and hysteresis while allowing repeated-stall downgrades", () => {
    expect(
      shouldSwitchFileQuality({
        currentHeight: 720,
        candidateHeight: 1080,
        now: 10_000,
        lastSwitchAt: 0,
      }),
    ).toBe(false);
    expect(
      shouldSwitchFileQuality({
        currentHeight: 1080,
        candidateHeight: 720,
        now: 10_000,
        lastSwitchAt: 5_000,
        recentStallCount: 2,
      }),
    ).toBe(true);
    expect(
      shouldSwitchFileQuality({
        currentHeight: 720,
        candidateHeight: 1080,
        now: 40_000,
        lastSwitchAt: 0,
      }),
    ).toBe(true);
  });
});

describe("canonicalRungClass", () => {
  it("files a 16:9 rung under its own height", () => {
    expect(canonicalRungClass(1280, 720)).toBe(720);
    expect(canonicalRungClass(3840, 2160)).toBe(2160);
  });

  it("recovers the class of a letterboxed cinema rung from its width", () => {
    // The real Ford v Ferrari ladder: 2.39:1, so every frame height sits one
    // or two classes below the rung it actually is.
    expect(canonicalRungClass(256, 108)).toBe(144);
    expect(canonicalRungClass(426, 178)).toBe(240);
    expect(canonicalRungClass(640, 268)).toBe(360);
    expect(canonicalRungClass(854, 358)).toBe(480);
    expect(canonicalRungClass(1280, 536)).toBe(720);
    expect(canonicalRungClass(1920, 804)).toBe(1080);
    expect(canonicalRungClass(2560, 1072)).toBe(1440);
    expect(canonicalRungClass(3840, 1608)).toBe(2160);
  });

  it("recovers the class of a pillarboxed rung from its height", () => {
    expect(canonicalRungClass(960, 720)).toBe(720);
  });

  it("falls back to height when width is unknown", () => {
    expect(canonicalRungClass(0, 1080)).toBe(1080);
  });
});

describe("selectAdaptiveTargetRung", () => {
  const ladder = (
    heights: readonly number[],
    bitrateFor = (h: number) => h * 4000,
  ) => heights.map((height) => ({ height, bitrate: bitrateFor(height) }));
  const full = ladder([144, 240, 360, 480, 720, 1080, 1440, 2160]);

  it("stays on the cheapest rung when bandwidth is below the whole ladder", () => {
    expect(
      selectAdaptiveTargetRung(full, "auto", { bandwidthBps: 100_000 })?.height,
    ).toBe(144);
  });

  it("takes a rung whose bitrate fits inside the safety margin", () => {
    // 480p costs 1.92 Mbps; two thirds of 3 Mbps is 2 Mbps, so it fits.
    expect(
      selectAdaptiveTargetRung(full, "auto", { bandwidthBps: 3_000_000 })
        ?.height,
    ).toBe(480);
  });

  it("does not take a rung that only fits without the safety margin", () => {
    // 720p costs 2.88 Mbps, which fits 3 Mbps raw but not 2 Mbps of budget.
    expect(
      selectAdaptiveTargetRung(full, "auto", { bandwidthBps: 3_000_000 })
        ?.height,
    ).not.toBe(720);
  });

  it("climbs the whole ladder when bandwidth is plentiful", () => {
    expect(
      selectAdaptiveTargetRung(full, "auto", {
        bandwidthBps: 200_000_000,
      })?.height,
    ).toBe(2160);
  });

  it("charges recent stalls against the budget", () => {
    const steady = selectAdaptiveTargetRung(full, "auto", {
      bandwidthBps: 6_000_000,
    })?.height;
    const stalling = selectAdaptiveTargetRung(full, "auto", {
      bandwidthBps: 6_000_000,
      recentStallCount: 2,
    })?.height;
    expect(stalling).toBeLessThan(steady!);
  });

  it("steps Low Data one class below Auto and Higher Quality one above", () => {
    // 8 Mbps of budget: 1440p costs 5.76 Mbps and fits, 2160p costs 8.64 and
    // does not.
    const context = { bandwidthBps: 12_000_000 };
    expect(selectAdaptiveTargetRung(full, "auto", context)?.height).toBe(1440);
    expect(selectAdaptiveTargetRung(full, "low-data", context)?.height).toBe(
      1080,
    );
    expect(
      selectAdaptiveTargetRung(full, "higher-resolution", context)?.height,
    ).toBe(2160);
  });

  it("keeps Higher Quality's 720p floor when the link carries 720p", () => {
    // 3 Mbps measured: Auto's two-thirds budget buys 480p (1.92 Mbps); 720p
    // costs 2.88 Mbps, which the link itself carries.
    const context = { bandwidthBps: 3_000_000 };
    expect(selectAdaptiveTargetRung(full, "auto", context)?.height).toBe(480);
    expect(
      selectAdaptiveTargetRung(full, "higher-resolution", context)?.height,
    ).toBe(720);
  });

  it("judges Higher Quality's step by the link, not a probe's allowance", () => {
    // A probe scales the bandwidth it passes; the step must still fit the link.
    expect(
      selectAdaptiveTargetRung(full, "higher-resolution", {
        bandwidthBps: 12_000_000,
        linkBps: 8_000_000,
      })?.height,
    ).toBe(1440);
  });

  it("does not step Higher Quality onto a rung the link cannot carry", () => {
    // 120 kbps measured: no floor is worth a rung that cannot be delivered.
    expect(
      selectAdaptiveTargetRung(full, "higher-resolution", {
        bandwidthBps: 120_000,
      })?.height,
    ).toBe(144);
    // A sparse ladder whose step up is two classes away: 2160p (8.64 Mbps)
    // does not fit 7 Mbps, 1440p (5.76) does, so Higher settles between.
    const sparse = ladder([480, 720, 1080, 1440, 2160], (h) =>
      h === 1080 ? 3_000_000 : h * 4000,
    );
    expect(
      selectAdaptiveTargetRung(sparse, "higher-resolution", {
        bandwidthBps: 7_000_000,
      })?.height,
    ).toBeLessThanOrEqual(1440);
    expect(
      selectAdaptiveTargetRung(sparse, "higher-resolution", {
        bandwidthBps: 7_000_000,
      })?.height,
    ).toBeGreaterThanOrEqual(
      selectAdaptiveTargetRung(sparse, "auto", { bandwidthBps: 7_000_000 })!
        .height,
    );
  });

  it("never lets Low Data exceed 1080p", () => {
    const context = { bandwidthBps: 500_000_000 };
    expect(selectAdaptiveTargetRung(full, "auto", context)?.height).toBe(2160);
    expect(selectAdaptiveTargetRung(full, "low-data", context)?.height).toBe(
      1080,
    );
  });

  it("resolves to a rung that exists on an incomplete ladder", () => {
    const sparse = ladder([480, 720, 1080]);
    const context = { bandwidthBps: 12_000_000 };
    expect(selectAdaptiveTargetRung(sparse, "auto", context)?.height).toBe(
      1080,
    );
    expect(selectAdaptiveTargetRung(sparse, "low-data", context)?.height).toBe(
      720,
    );
    // 1440p does not exist, so the step up settles on the tallest that does.
    expect(
      selectAdaptiveTargetRung(sparse, "higher-resolution", context)?.height,
    ).toBe(1080);
  });

  it("handles a ladder with a large gap in the middle", () => {
    const gapped = ladder([720, 2160]);
    const context = { bandwidthBps: 8_000_000 };
    const auto = selectAdaptiveTargetRung(gapped, "auto", context)?.height;
    expect([720, 2160]).toContain(auto);
    // Nothing below 720p exists, so Low Data cannot go lower than the floor.
    expect(selectAdaptiveTargetRung(gapped, "low-data", context)?.height).toBe(
      720,
    );
  });

  it("honours an explicit save-data preference over any measurement", () => {
    expect(
      selectAdaptiveTargetRung(full, "auto", {
        bandwidthBps: 200_000_000,
        saveData: true,
      })?.height,
    ).toBe(144);
  });

  it("returns nothing when the ladder is empty", () => {
    expect(
      selectAdaptiveTargetRung([], "auto", { bandwidthBps: 5_000_000 }),
    ).toBeUndefined();
  });

  it("rises and falls with the measured link", () => {
    const collapsed = selectAdaptiveTargetRung(full, "auto", {
      bandwidthBps: 400_000,
    })?.height;
    const recovered = selectAdaptiveTargetRung(full, "auto", {
      bandwidthBps: 40_000_000,
    })?.height;
    expect(collapsed).toBe(144);
    expect(recovered).toBeGreaterThan(collapsed!);
  });
});
