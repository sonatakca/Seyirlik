import { beforeEach, describe, expect, it } from "vitest";
import {
  createThroughputAccumulator,
  currentNetworkSignature,
  deliveredThroughputSample,
  openingBandwidthEstimate,
  rememberDeliveredThroughput,
  UNKNOWN_LINK_ESTIMATE_BPS,
} from "./throughputMemory";

const ORIGIN = "https://media.example.test";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A 1080p-sized fragment over a tunnel: 1.5 MB, 120 ms to first byte. */
function transfer(
  totalMs: number,
  overrides: Partial<{ bytes: number; ttfbMs: number; aborted: boolean }> = {},
) {
  const ttfb = overrides.ttfbMs ?? 120;
  return {
    bytes: overrides.bytes ?? 1_500_000,
    requestStartMs: 1000,
    firstByteMs: 1000 + ttfb,
    endMs: 1000 + totalMs,
    ...(overrides.aborted ? { aborted: true } : {}),
  };
}

describe("deliveredThroughputSample", () => {
  it("prices the round trip into the rate, as sequential fragment loads pay it", () => {
    // 1.5 MB in 1.2 s including 120 ms to first byte is 10 Mbps delivered,
    // not the 11.1 Mbps the transfer alone would claim.
    expect(deliveredThroughputSample(transfer(1200))).toBeCloseTo(
      10_000_000,
      -3,
    );
  });

  it("refuses a browser-cache read as evidence about the network", () => {
    // Segments are immutable for a year; a rewatch answers from disk in ms.
    expect(
      deliveredThroughputSample(transfer(4, { ttfbMs: 2 })),
    ).toBeUndefined();
  });

  it("refuses a rate no path to this server can deliver", () => {
    expect(
      deliveredThroughputSample(transfer(10, { ttfbMs: 9 })),
    ).toBeUndefined();
  });

  it("refuses fragments too small to measure anything but latency", () => {
    expect(
      deliveredThroughputSample(transfer(200, { bytes: 20_000 })),
    ).toBeUndefined();
  });

  it("refuses aborted and malformed transfers", () => {
    expect(
      deliveredThroughputSample(transfer(1200, { aborted: true })),
    ).toBeUndefined();
    expect(
      deliveredThroughputSample({
        bytes: 1_500_000,
        requestStartMs: Number.NaN,
        firstByteMs: 5,
        endMs: 9,
      }),
    ).toBeUndefined();
    expect(
      deliveredThroughputSample({
        bytes: 1_500_000,
        requestStartMs: 10,
        firstByteMs: 10,
        endMs: 10,
      }),
    ).toBeUndefined();
  });
});

describe("createThroughputAccumulator", () => {
  it("says nothing until a handful of fragments have been measured", () => {
    const accumulator = createThroughputAccumulator();
    for (let index = 0; index < 3; index += 1) accumulator.add(transfer(1200));
    expect(accumulator.estimateBps()).toBeUndefined();
    accumulator.add(transfer(1200));
    expect(accumulator.estimateBps()).toBeCloseTo(10_000_000, -3);
  });

  it("weights by bytes, so one slow fragment drags harder than one fast one lifts", () => {
    const accumulator = createThroughputAccumulator();
    // Three at 10 Mbps, one at 2.5 Mbps: the arithmetic mean would be 8.1.
    for (let index = 0; index < 3; index += 1) accumulator.add(transfer(1200));
    accumulator.add(transfer(4800));
    expect(accumulator.estimateBps()!).toBeLessThan(6_000_000);
    expect(accumulator.estimateBps()!).toBeGreaterThan(5_000_000);
  });

  it("ignores cache reads entirely rather than letting them inflate the window", () => {
    const accumulator = createThroughputAccumulator();
    for (let index = 0; index < 4; index += 1) accumulator.add(transfer(1200));
    expect(accumulator.add(transfer(3, { ttfbMs: 1 }))).toBe(false);
    expect(accumulator.sampleCount).toBe(4);
    expect(accumulator.estimateBps()).toBeCloseTo(10_000_000, -3);
  });

  it("describes the recent link, not the whole session", () => {
    const accumulator = createThroughputAccumulator();
    for (let index = 0; index < 16; index += 1) accumulator.add(transfer(600));
    for (let index = 0; index < 16; index += 1) accumulator.add(transfer(6000));
    expect(accumulator.estimateBps()).toBeCloseTo(2_000_000, -3);
  });
});

describe("openingBandwidthEstimate", () => {
  let storage: Storage;
  beforeEach(() => {
    window.localStorage.clear();
    storage = window.localStorage;
  });

  const now = 1_800_000_000_000;

  it("opens a first-time viewer with no hint on the long-standing default", () => {
    expect(
      openingBandwidthEstimate(ORIGIN, { now, storage, network: undefined }),
    ).toEqual({
      bps: UNKNOWN_LINK_ESTIMATE_BPS,
      source: "default",
    });
  });

  it("uses a slow link hint as the ceiling it is", () => {
    expect(
      openingBandwidthEstimate(ORIGIN, {
        now,
        storage,
        network: { downlink: 1.5 },
      }),
    ).toEqual({
      bps: 1_500_000,
      source: "link-hint",
    });
  });

  it("does not let a fast link hint promise what the server's uplink may not deliver", () => {
    // Chromium caps downlink at 10; it describes the viewer's side only.
    expect(
      openingBandwidthEstimate(ORIGIN, {
        now,
        storage,
        network: { downlink: 10 },
      }).source,
    ).toBe("default");
  });

  it("trusts a measurement from minutes ago as measured", () => {
    rememberDeliveredThroughput(ORIGIN, 24_000_000, {
      now,
      storage,
      network: undefined,
    });
    expect(
      openingBandwidthEstimate(ORIGIN, {
        now: now + 20 * MINUTE,
        storage,
        network: undefined,
      }),
    ).toMatchObject({ bps: 24_000_000, source: "history", confidence: 1 });
  });

  it("holds back more of a measurement the older it is, and forgets it after two weeks", () => {
    rememberDeliveredThroughput(ORIGIN, 24_000_000, {
      now,
      storage,
      network: undefined,
    });
    const at = (age: number) =>
      openingBandwidthEstimate(ORIGIN, {
        now: now + age,
        storage,
        network: undefined,
      });
    expect(at(6 * HOUR)).toMatchObject({ bps: 18_000_000, confidence: 0.75 });
    expect(at(5 * DAY)).toMatchObject({ bps: 12_000_000, confidence: 0.5 });
    expect(at(15 * DAY).source).toBe("default");
  });

  it("prefers this server's own history over a link hint, which says nothing about its uplink", () => {
    rememberDeliveredThroughput(ORIGIN, 3_000_000, {
      now,
      storage,
      network: { effectiveType: "4g" },
    });
    expect(
      openingBandwidthEstimate(ORIGIN, {
        now,
        storage,
        network: { effectiveType: "4g", downlink: 10 },
      }),
    ).toMatchObject({ bps: 3_000_000, source: "history" });
  });

  it("does not carry a Wi-Fi measurement onto cellular", () => {
    rememberDeliveredThroughput(ORIGIN, 40_000_000, {
      now,
      storage,
      network: { type: "wifi", effectiveType: "4g" },
    });
    expect(
      openingBandwidthEstimate(ORIGIN, {
        now,
        storage,
        network: { type: "cellular", effectiveType: "4g", downlink: 2 },
      }),
    ).toEqual({ bps: 2_000_000, source: "link-hint" });
  });

  it("keeps measurements per origin", () => {
    rememberDeliveredThroughput(ORIGIN, 40_000_000, {
      now,
      storage,
      network: undefined,
    });
    expect(
      openingBandwidthEstimate("https://other.example.test", {
        now,
        storage,
        network: undefined,
      }).source,
    ).toBe("default");
  });

  it("treats a clock that went backwards as an old measurement, not a fresh one", () => {
    rememberDeliveredThroughput(ORIGIN, 24_000_000, {
      now,
      storage,
      network: undefined,
    });
    expect(
      openingBandwidthEstimate(ORIGIN, {
        now: now - HOUR,
        storage,
        network: undefined,
      }),
    ).toMatchObject({
      confidence: 0.5,
    });
  });

  it("survives corrupt, hostile or unavailable storage", () => {
    storage.setItem("seyirlik:delivery-throughput:v1", "{not json");
    expect(
      openingBandwidthEstimate(ORIGIN, { now, storage, network: undefined })
        .source,
    ).toBe("default");
    storage.setItem(
      "seyirlik:delivery-throughput:v1",
      JSON.stringify({
        [ORIGIN]: { bps: 1e15, at: now },
        other: { bps: "fast", at: now },
      }),
    );
    expect(
      openingBandwidthEstimate(ORIGIN, { now, storage, network: undefined })
        .source,
    ).toBe("default");

    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    expect(() =>
      rememberDeliveredThroughput(ORIGIN, 1e7, { now, storage: throwing }),
    ).not.toThrow();
    expect(
      openingBandwidthEstimate(ORIGIN, {
        now,
        storage: throwing,
        network: undefined,
      }).source,
    ).toBe("default");
  });

  it("keeps only the most recently used origins", () => {
    for (let index = 0; index < 6; index += 1) {
      rememberDeliveredThroughput(`https://m${index}.example.test`, 1e7, {
        now: now + index,
        storage,
        network: undefined,
      });
    }
    const kept = Object.keys(
      JSON.parse(storage.getItem("seyirlik:delivery-throughput:v1")!),
    );
    expect(kept).toHaveLength(4);
    expect(kept).not.toContain("https://m0.example.test");
  });
});

describe("currentNetworkSignature", () => {
  it("names only what the browser actually reports", () => {
    expect(currentNetworkSignature(undefined)).toBeUndefined();
    expect(currentNetworkSignature({ downlink: 10 })).toBeUndefined();
    expect(currentNetworkSignature({ effectiveType: "4g" })).toBe("4g");
    expect(currentNetworkSignature({ type: "wifi", effectiveType: "4g" })).toBe(
      "wifi/4g",
    );
  });
});
