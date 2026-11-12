/**
 * Which rung a real player opens on, and how quickly it corrects, against a
 * real server whose latency and bandwidth are throttled.
 *
 * Runs Seyirlik's own attachment (`attachSourceToVideo`, real hls.js, real
 * MSE or ManagedMediaSource) against the priced-ladder fixture served through
 * the fixture server's simulated link. The unit tests prove the policy's
 * arithmetic; these prove the parts only a browser can: that hls.js really
 * opens on the rung chosen from the remembered estimate, that it never spends
 * a bitrate-test fragment first, that real fragment timings are measured and
 * remembered, and that the next playback opens from what this one learned.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LADDER_FIXTURE_RUNGS } from "../test/ladderFixtureRungs";
import { rememberDeliveredThroughput } from "./throughputMemory";
import { attachSourceToVideo, type AttachedVideoSource } from "./videoSource";

interface AbrEntry {
  at: string;
  event: string;
  detail: Record<string, unknown>;
}

function abrLogSince(startedAt: string): AbrEntry[] {
  const reader = (
    window as unknown as { __seyirlikAbr: () => { log: AbrEntry[] } }
  ).__seyirlikAbr;
  return reader().log.filter((entry) => entry.at >= startedAt);
}

function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (performance.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}.`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

const mounted: Array<{ video: HTMLVideoElement; source: AttachedVideoSource }> =
  [];

beforeEach(() => {
  window.localStorage.clear();
  performance.setResourceTimingBufferSize(5000);
  performance.clearResourceTimings();
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    entry.source.destroy();
    entry.video.remove();
  }
});

/** The rung each fixture variant playlist belongs to, in request order. */
function variantRequests(): number[] {
  return performance
    .getEntriesByType("resource")
    .map((entry) => /\/test-ladder\/.*media\/(\d+)p\.m3u8/.exec(entry.name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
}

/** The highest rung the policy's two-thirds margin affords at `bps`. */
function affordableAt(bps: number): number {
  const affordable = LADDER_FIXTURE_RUNGS.filter(
    (rung) => rung.averageBps <= bps * (2 / 3) && rung.height <= 1080,
  );
  return affordable.at(-1)?.height ?? LADDER_FIXTURE_RUNGS[0].height;
}

/**
 * Plays the fixture through a link of `kbps` and `latencyMs` until `fragments`
 * main fragments are buffered, in a 1080-tall player (so the display ceiling
 * is 1080p and never the deciding factor below it).
 */
async function play(kbps: number, latencyMs: number, fragments: number) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.style.width = "1920px";
  video.style.height = "1080px";
  document.body.append(video);

  let buffered = 0;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let firstFrameMs: number | undefined;
  video.addEventListener(
    "playing",
    () => {
      firstFrameMs = performance.now() - started;
    },
    { once: true },
  );

  const source = attachSourceToVideo(
    video,
    `/test-ladder/__link/${kbps}/${latencyMs}/master.m3u8`,
    "application/vnd.apple.mpegurl",
    {
      adaptiveRendition: true,
      onHlsEvent: (event) => {
        if (
          event.name === "hlsFragBuffered" &&
          (event.data as { frag?: { type?: string } })?.frag?.type === "main"
        ) {
          buffered += 1;
        }
      },
    },
  );
  mounted.push({ video, source });
  void video.play().catch(() => undefined);

  await waitFor(() => buffered >= fragments, 45_000, `${fragments} fragments`);
  const log = abrLogSince(startedAt);
  const levels = log.filter((entry) => entry.event === "level");
  return {
    source,
    log,
    levels,
    opening: log.find((entry) => entry.event === "opening-estimate")!.detail,
    firstFrameMs,
    elapsedMs: performance.now() - started,
    finish() {
      source.destroy();
      mounted.splice(
        mounted.findIndex((entry) => entry.source === source),
        1,
      );
      video.remove();
    },
  };
}

function remembered(): number | undefined {
  const raw = window.localStorage.getItem("seyirlik:delivery-throughput:v1");
  if (!raw) return undefined;
  return (JSON.parse(raw) as Record<string, { bps: number }>)[
    window.location.origin
  ]?.bps;
}

describe("the opening rung, against a real throttled server", () => {
  it("opens a first-time viewer at 720p without a bitrate test, then corrects at once on a fast link", async () => {
    const session = await play(20_000, 40, 4);

    expect(session.opening.source).toBe("default");
    // The first rung asked for is the opening choice itself. A bitrate test
    // would have fetched the bottom rung's playlist and a fragment first.
    expect(variantRequests()[0]).toBe(720);
    expect(variantRequests()).not.toContain(144);

    const correction = session.levels.find(
      (entry) => entry.detail.reason === "start-correct-up",
    );
    expect(correction?.detail.height).toBe(1080);
    const correctedAfterMs =
      Date.parse(correction!.at) - Date.parse(session.log[0]!.at);
    console.info("[opening-rung] fast link, cold", {
      correctedAfterMs,
      firstFrameMs: session.firstFrameMs,
      variants: variantRequests(),
    });
    // Two fragments of evidence, not a two-second hold on top of them.
    expect(correctedAfterMs).toBeLessThan(4000);

    session.finish();
    const learned = remembered();
    expect(learned).toBeGreaterThan(8_000_000);
    expect(learned).toBeLessThan(25_000_000);
  });

  it("opens the next playback on a slow server where the last one ended up", async () => {
    /*
     * First visit: opens at the default 720p, measures the link, steps down.
     * Every fixture rung really costs 2.4 Mbps, so the link is given headroom
     * over that; a machine busy with other suites still delivers less than
     * the nominal rate, which is why nothing below assumes the link is steady.
     */
    const first = await play(4_000, 60, 5);
    expect(first.opening.source).toBe("default");
    expect(variantRequests()[0]).toBe(720);
    expect(first.levels.some((entry) => entry.detail.reason === "down")).toBe(
      true,
    );
    first.finish();

    const learned = remembered();
    expect(learned).toBeGreaterThan(1_500_000);
    expect(learned).toBeLessThan(4_400_000);

    // Next title, moments later: opens from what the first one learned.
    performance.clearResourceTimings();
    const next = await play(4_000, 60, 4);
    expect(next.opening).toMatchObject({ source: "history", confidence: 1 });
    expect(variantRequests()[0]).toBe(affordableAt(learned!));
    expect(variantRequests()[0]).toBeLessThan(720);
    // Not opened too low either: the link never had to prove it could carry
    // more. (A step down is allowed — a loaded machine can deliver less than
    // the last session did, and following it down is the policy working.)
    expect(
      next.levels.some((entry) => entry.detail.reason === "start-correct-up"),
    ).toBe(false);
    console.info("[opening-rung] slow link, repeat", {
      learnedBps: Math.round(learned!),
      openedAt: variantRequests()[0],
      firstFrameMsCold: first.firstFrameMs,
      firstFrameMsRepeat: next.firstFrameMs,
    });
  });

  it("opens a returning viewer on a fast link at full quality straight away", async () => {
    rememberDeliveredThroughput(window.location.origin, 30_000_000);
    const session = await play(20_000, 40, 4);

    expect(session.opening.source).toBe("history");
    expect(variantRequests()[0]).toBe(1080);
    expect(
      session.levels.filter((entry) => entry.detail.reason !== "start"),
    ).toEqual([]);
  });
});
