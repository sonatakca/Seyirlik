import Hls, { type LoaderContext } from "hls.js";

import {
  type AutomaticQualityMode,
  canonicalRungClass,
  selectAdaptiveTargetRung,
} from "../components/player/qualityPreference";

export interface AttachedVideoSource {
  usingHlsJs: boolean;
  adaptiveController?: AdaptiveHlsController;
  destroy: () => void;
}

export interface AdaptiveHlsController {
  /**
   * `height` locks one level; null hands future fragments back to Seyirlik's
   * own adaptive policy for `mode`. It does not hand them to hls.js's ABR —
   * see `applyAdaptivePreference`.
   */
  setQualityHeight(
    height: number | null,
    maxHeight?: number | null,
    mode?: AutomaticQualityMode,
  ): void;
  setAudioStream(sourceStreamIndex: number): boolean;
  /**
   * What the engine has actually measured the link to carry, in bits/second.
   *
   * This is throughput observed while pulling real fragments, which is a far
   * better number than `navigator.connection.downlink` — that is a coarse,
   * rounded hint the browser volunteers, and Safari and Firefox do not
   * volunteer it at all. Undefined when no estimate exists yet.
   */
  getBandwidthEstimateBps(): number | undefined;
}

export interface HlsPlaybackEvent {
  name: string;
  data?: unknown;
}

export interface AttachSourceOptions {
  onHlsEvent?: (event: HlsPlaybackEvent) => void;
  onHlsFatalError?: (data: unknown) => void;
  /**
   * The level now on screen. `width` is reported alongside `height` because a
   * ladder rung is named by its class (1080p) while the frame it produces is
   * whatever the source's shape gives — a 2.39:1 master's "2160p" rung is
   * 3840x1608. Matching a rung by frame height alone therefore fails on every
   * letterboxed title, so the caller is given the width to match on instead.
   */
  onAdaptiveLevelChanged?: (level: { height: number; width: number }) => void;
  /**
   * True when the adaptive package offers no SDR rung. Only this shape is
   * affected by the native-HLS refusal, so only this shape is diverted.
   */
  hdrOnlyPackage?: boolean;
  /**
   * Play through hls.js whatever the engine could do natively. A downloaded
   * title needs this: its bytes come from the service worker's cache, and
   * Apple's native HLS fetches media outside the service worker entirely.
   */
  forceMediaSource?: boolean;
  /**
   * The source is one of Seyirlik's adaptive packages. Its rung is then chosen
   * by Seyirlik's own policy wherever hls.js can run, Safari included: native
   * HLS decides by itself, out of reach of anything here, and on a link with
   * real latency it sank to the bottom rung after a dip and took minutes to
   * climb back. Other HLS (a live transcode) keeps the native engine.
   */
  adaptiveRendition?: boolean;
}

/**
 * Keeps AirPlay available on a ManagedMediaSource element.
 *
 * hls.js turns remote playback off when it attaches through MMS, because MMS
 * will not open with remote playback on unless the element also offers a
 * source AirPlay can hand to a receiver. Offering that source instead keeps
 * the AirPlay button: the page plays from MMS, and a receiver is given the
 * ordinary HLS playlist and plays it itself. Verified in Safari 26: with the
 * alternative present MMS opens with `disableRemotePlayback` false; without it
 * it never opens.
 *
 * Runs after hls.js's own attach handler, which has just replaced the
 * element's sources with its blob URL and called `load()`; source selection is
 * asynchronous, so the alternative is in place before it runs.
 */
function offerAirPlayAlternative(
  videoElement: HTMLVideoElement,
  playbackUrl: string,
): void {
  const managedMediaSource = (
    window as unknown as { ManagedMediaSource?: unknown }
  ).ManagedMediaSource;
  if (typeof managedMediaSource === "undefined") return;
  const blobSource = videoElement.querySelector("source");
  if (!blobSource || !blobSource.src.startsWith("blob:")) return;
  if (videoElement.querySelector("source[data-seyirlik-airplay]")) return;
  const alternative = document.createElement("source");
  alternative.type = "application/x-mpegURL";
  alternative.src = playbackUrl;
  alternative.setAttribute("data-seyirlik-airplay", "");
  videoElement.appendChild(alternative);
  videoElement.disableRemotePlayback = false;
}

/**
 * How often the adaptive policy is allowed to reconsider.
 *
 * Every fragment moves the bandwidth estimate, so re-deciding on each one of
 * a burst means arguing with hls.js continuously for no gain. One decision a
 * second is far more often than the picture can usefully change and still
 * cheap: the work is a handful of comparisons over the ladder.
 */
const RUNG_EVALUATION_INTERVAL_MS = 1000;

/**
 * The policy's own clock, so decisions do not wait on fragment arrivals.
 *
 * Under ManagedMediaSource the engine loads in bursts: Safari asks for data,
 * hls.js fills the buffer to about thirty seconds in a second or two, and
 * then nothing is fetched at all until the buffer drains back to roughly ten.
 * Driving the policy from `FRAG_BUFFERED` alone therefore gave it one
 * opportunity to decide every twenty seconds, which multiplied every interval
 * below by ten or more: measured on the iPad, a climb the policy had already
 * decided on took a minute and a half to arrive. A timer makes the constants
 * mean what they say.
 */
const RUNG_TICK_INTERVAL_MS = 1000;

/**
 * How long a better rung has to keep looking affordable before it is taken.
 *
 * Down-switches apply immediately because a rung that no longer fits is
 * already costing the viewer a stall. Up-switches wait, because a single
 * optimistic sample is the cheapest way to start oscillating between two
 * rungs — which is more distracting than sitting one rung low for a moment.
 *
 * Two seconds, which at the tick above is two independent confirmations
 * rather than a single lucky fragment. The ladder is walked a rung at a time
 * and each rung has to re-earn the next — the estimate only learns what the
 * link can do by fetching the larger fragments a higher rung asks for — so
 * this interval is what the whole climb is paced by: at four seconds a
 * session that opened at 480p took the better part of a minute to arrive at
 * the rung it could have had, which reads as a player that is stuck.
 */
const UPSWITCH_HOLD_MS = 2000;

/** A stall stops counting against the budget once the link has behaved again. */
const STALL_MEMORY_MS = 30_000;

/**
 * How much buffered video counts as "this rung is comfortably sustainable".
 *
 * Throughput measured from a small fragment is mostly overhead: a 144p
 * fragment is ~120 kB and lands in milliseconds, so the estimate reads far
 * below what the link can do — measured at 0.9 Mbps on an idle LAN. A rung
 * chosen from that estimate then keeps the fragments small, which keeps the
 * estimate low. A buffer that keeps filling is the honest evidence the
 * estimate cannot give, so it is what licenses a climb out of that hole.
 *
 * Ten seconds, because that is the shape of the real buffer rather than the
 * configured maximum: measured on the iPad the forward buffer sits around
 * eleven to thirteen seconds while a session is refilling, so a threshold set
 * at the nominal thirty never once fired.
 */
const PROBE_BUFFER_SECONDS = 10;

/** A stall only says something about bandwidth if the buffer was actually short. */
const STARVED_BUFFER_SECONDS = 5;

/**
 * How long a stall keeps the ladder from being climbed again.
 *
 * A stall leaves the estimate stale-high — it only moves when a fragment
 * finishes, and none did — so the policy's first instinct afterwards is to
 * climb straight back to the rung that just failed. Long enough for the
 * cheaper rung's fragment to land and correct the estimate, short enough that
 * a one-off hiccup costs a few seconds of quality and nothing more.
 */
const STALL_UPSWITCH_BLOCK_MS = 6000;

/**
 * How long after a seek a stall is the seek's, not the link's.
 *
 * A seek empties the buffer by definition, so the stall that follows says
 * nothing about bandwidth — yet each one was charged like a real stall: 40% of
 * the budget, a rung down, and no climbing for six seconds. A party seeks every
 * time someone scrubs and every time a player catches up, which held the stall
 * count at its cap and the picture at the bottom of the ladder for as long as
 * the party lasted. A link that genuinely cannot carry the rung still stalls
 * after this, and is charged then.
 */
const SEEK_STALL_GRACE_MS = 5000;

/**
 * Below this much media ahead of the play head, loading is never left paused.
 *
 * Under ManagedMediaSource hls.js stops fetching on `endstreaming` and starts
 * again only on `startstreaming`. WebKit does not send that second event for a
 * seek out of the buffer: measured in WebKit 26.5, seven of eleven such seeks
 * left `streaming` false and the element `seeking` indefinitely, with nothing
 * requested — the picture froze until a reload built a new MediaSource. Two
 * seconds is under one fragment, so a play head this close to the edge of
 * what it has is one the browser should already have asked to feed.
 */
const MMS_RESUME_BUFFER_SECONDS = 2;

/** Decisions kept for `window.__seyirlikAbr()`. */
const ABR_LOG_SIZE = 200;

interface AbrLogEntry {
  at: string;
  event: string;
  detail: Record<string, unknown>;
}

const abrLog: AbrLogEntry[] = [];
let abrSnapshot: (() => Record<string, unknown>) | null = null;

/**
 * Every rung decision and its reason, readable from the tab that made it:
 * `window.__seyirlikAbr()` returns the current state and the recent decisions.
 * "It went blurry" is then answered from evidence — which rung, why, with what
 * estimate and buffer — instead of from guesses about the policy.
 */
function abrRecord(event: string, detail: Record<string, unknown>): void {
  abrLog.push({ at: new Date().toISOString(), event, detail });
  if (abrLog.length > ABR_LOG_SIZE) abrLog.shift();
}

if (typeof window !== "undefined") {
  (
    window as unknown as {
      __seyirlikAbr?: () => {
        state: Record<string, unknown> | null;
        log: AbrLogEntry[];
      };
    }
  ).__seyirlikAbr = () => ({
    state: abrSnapshot?.() ?? null,
    log: [...abrLog],
  });
}

/**
 * How much better than measured the probe is allowed to assume the link is.
 *
 * Three, against the policy's two-thirds safety margin, comes to a simple
 * rule: the probe may take a rung costing up to twice what the link has been
 * measured to carry — but only while the buffer says that measurement is the
 * thing that is wrong. Rungs sit between one and a half and two and a half
 * times apart in bitrate, so this reliably reaches the next one and rarely
 * more; the one-rung-per-turn clamp handles the ladders where it would.
 */
const PROBE_BANDWIDTH_OPTIMISM = 3;

/**
 * How long a rung the probe has just taken is protected from the estimate.
 *
 * The probe exists because the estimate is wrong, so the estimate cannot also
 * be the judge of whether the probe was right — and for the first seconds it
 * is all there is, because throughput at the new rung has not been measured
 * yet. Without this the two argued every second: the probe climbed, the stale
 * reading pulled it straight back, and the session flickered between two
 * rungs instead of settling on either.
 *
 * The buffer is the judge instead, and it revokes the protection early: a
 * stall, or a forward buffer that stops covering the probe's own threshold,
 * ends the grace immediately and the ordinary downgrade applies.
 */
const PROBE_GRACE_MS = 8000;

/**
 * How far back the probe looks when asking whether the link is still holding.
 *
 * Long enough to span several evaluation ticks, short enough that a link which
 * has recovered is not still being judged by how it behaved a minute ago.
 */
const BANDWIDTH_TREND_WINDOW_MS = 10_000;

/** Below this many samples there is no trend, only a reading. */
const BANDWIDTH_TREND_MIN_SAMPLES = 3;

/**
 * How far under its recent peak the estimate has to sit to count as falling.
 *
 * Deliberately coarse. The estimate a low rung produces is noisy — small
 * fragments, mostly overhead — so a tight threshold would read ordinary jitter
 * as a collapse and re-trap the session on the bottom rung, which is the exact
 * failure the probe exists to prevent. A third of the link disappearing is not
 * jitter.
 */
const BANDWIDTH_TREND_FALLING_RATIO = 0.7;

/** One reading of the engine's own estimate, kept only to see its direction. */
interface BandwidthSample {
  at: number;
  bps: number;
}

/**
 * Whether the measured link is meaningfully on its way down.
 *
 * The buffer probe trusts a full buffer over a low estimate, which is right
 * when the estimate is low because the fragments are small and wrong when it
 * is low because the link is collapsing — a buffer takes time to drain, so for
 * a few seconds both look identical. Measured on the iPad: during a 350 kbps
 * throttle the probe climbed a rung at 62 s on a buffer that had not caught up
 * yet, and Auto corrected it twelve seconds later. Reading the direction of
 * the estimate separates the two cases before the climb rather than after it.
 *
 * This is not a second estimator. The samples are the engine's own
 * `bandwidthEstimate`, recorded as the policy already reads it; only their
 * recent shape is new.
 */
export function isBandwidthFalling(
  samples: readonly BandwidthSample[],
  now: number,
): boolean {
  const recent = samples.filter(
    (sample) => now - sample.at <= BANDWIDTH_TREND_WINDOW_MS,
  );
  if (recent.length < BANDWIDTH_TREND_MIN_SAMPLES) return false;

  const latest = recent.at(-1)!;
  const peak = Math.max(...recent.map((sample) => sample.bps));
  if (!(peak > 0)) return false;

  return latest.bps <= peak * BANDWIDTH_TREND_FALLING_RATIO;
}

export function isHlsPlaybackUrl(
  playbackUrl: string,
  mimeType?: string,
): boolean {
  const lowerUrl = playbackUrl.toLowerCase();
  const lowerMime = mimeType?.toLowerCase() ?? "";

  return (
    lowerUrl.includes(".m3u8") ||
    lowerMime.includes("mpegurl") ||
    lowerMime.includes("x-mpegurl")
  );
}

function getNativeHlsSupport(
  videoElement: HTMLVideoElement,
): CanPlayTypeResult {
  const appleHlsSupport = videoElement.canPlayType(
    "application/vnd.apple.mpegurl",
  );

  return appleHlsSupport || videoElement.canPlayType("application/x-mpegURL");
}

function isAppleNativeHlsRuntime(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const userAgent = navigator.userAgent;

  if (/iPad|iPhone|iPod/i.test(userAgent)) {
    return true;
  }

  return (
    /Safari/i.test(userAgent) &&
    !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|SamsungBrowser/i.test(userAgent)
  );
}

/**
 * Whether this playback has to go through ManagedMediaSource to work at all.
 *
 * Apple's native HLS refuses a multivariant presentation whose every variant is
 * PQ when the display cannot present HDR. Measured on an iPad (9th generation,
 * iPadOS 26.1): the master and the chosen variant playlist load, the init
 * segment is fetched once, and playback then fails with `MEDIA_ERR_DECODE`
 * without a single media segment being requested. The device decodes the very
 * same bytes happily — `canPlayType` answers "probably" and the identical media
 * playlist opened directly plays — so this is a presentation decision, not a
 * decoding limit, and nothing about the encode or the playlist can talk it
 * round. Feeding the same renditions through MMS bypasses that decision.
 *
 * Deliberately not user-agent sniffing: the predicate asks about the package,
 * the display and the runtime, so a device that gains an HDR display stops
 * matching. Nothing here is cached — the display is read at attach time, so a
 * later session on an external HDR display takes the native path again.
 */
export function shouldUseManagedHdrFallback(options: {
  /** True when every rung carries the HDR grade, leaving no SDR variant. */
  hdrOnlyPackage: boolean;
}): boolean {
  if (!options.hdrOnlyPackage) return false;
  if (typeof window === "undefined") return false;

  // MMS is the transport that makes this work; plain MediaSource is not enough
  // on the affected devices, and hls.js is what drives it.
  const managedMediaSource = (
    window as unknown as { ManagedMediaSource?: unknown }
  ).ManagedMediaSource;
  if (typeof managedMediaSource === "undefined") return false;
  if (!Hls.isSupported()) return false;

  // A display that can present HDR is not affected, so it keeps native HLS —
  // and with it AirPlay, which MMS cannot offer.
  const displayPresentsHdr =
    window.matchMedia?.("(dynamic-range: high)")?.matches === true;
  return !displayPresentsHdr;
}

export function shouldUseNativeHls(videoElement: HTMLVideoElement): boolean {
  const nativeSupport = getNativeHlsSupport(videoElement);

  if (nativeSupport === "probably") {
    return true;
  }

  return nativeSupport === "maybe" && isAppleNativeHlsRuntime();
}

function getRequestedMaxHeight(playbackUrl: string): number | null {
  try {
    const url = new URL(playbackUrl);
    const rawMaxHeight =
      url.searchParams.get("maxHeight") ?? url.searchParams.get("MaxHeight");
    const maxHeight = rawMaxHeight ? Number(rawMaxHeight) : NaN;

    return Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : null;
  } catch {
    return null;
  }
}

function getBestAllowedHlsLevel(
  hls: Hls,
  requestedMaxHeight: number | null,
): number {
  let bestLevel = -1;
  let bestScore = -1;

  hls.levels.forEach((level, index) => {
    const height = level.height || 0;
    const bitrate = level.bitrate || 0;

    if (requestedMaxHeight !== null && height > requestedMaxHeight) {
      return;
    }

    const score = height * 10_000_000 + bitrate;

    if (score > bestScore) {
      bestScore = score;
      bestLevel = index;
    }
  });

  if (bestLevel >= 0) {
    return bestLevel;
  }

  return hls.levels.reduce((bestIndex, level, index) => {
    const bestLevelSoFar = hls.levels[bestIndex];

    if (!bestLevelSoFar) {
      return index;
    }

    const levelScore = (level.height || 0) * 10_000_000 + (level.bitrate || 0);
    const bestScoreSoFar =
      (bestLevelSoFar.height || 0) * 10_000_000 + (bestLevelSoFar.bitrate || 0);

    return levelScore > bestScoreSoFar ? index : bestIndex;
  }, 0);
}

export function attachSourceToVideo(
  videoElement: HTMLVideoElement,
  playbackUrl: string,
  mimeType?: string,
  options: AttachSourceOptions = {},
): AttachedVideoSource {
  const isHls = isHlsPlaybackUrl(playbackUrl, mimeType);
  const requestedMaxHeight = getRequestedMaxHeight(playbackUrl);

  const managedHdrFallback = shouldUseManagedHdrFallback({
    hdrOnlyPackage: options.hdrOnlyPackage === true,
  });

  const forceMediaSource =
    options.forceMediaSource === true && Hls.isSupported();
  const seyirlikChoosesRung =
    options.adaptiveRendition === true && Hls.isSupported();

  if (
    isHls &&
    !managedHdrFallback &&
    !forceMediaSource &&
    !seyirlikChoosesRung &&
    shouldUseNativeHls(videoElement)
  ) {
    videoElement.src = playbackUrl;
    return {
      usingHlsJs: false,
      destroy: () => {
        videoElement.removeAttribute("src");
        videoElement.load();
      },
    };
  }

  if (isHls && Hls.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      /*
       * Deliberately off. hls.js's own cap controller writes `autoLevelCapping`
       * on a timer, and this file writes it too whenever the viewer's choice
       * changes — two owners of one property, where whoever ran last wins. The
       * visible symptom is Auto ignoring the ladder: the cap the viewer's mode
       * implies gets overwritten a second later by a size-derived one, and an
       * element measured while it is hidden or mid-reattach measures zero,
       * which that controller reads as "the smallest rung will do". Capping is
       * done in `applyAdaptivePreference` instead, where both inputs are
       * considered together and a zero measurement is not mistaken for a
       * request for 144p.
       */
      capLevelToPlayerSize: false,
      lowLatencyMode: false,
      startLevel: -1,
      abrEwmaDefaultEstimate: 5_000_000,
      maxStarvationDelay: 4,
      maxLoadingDelay: 4,
      testBandwidth: true,
      /*
       * Recover from a dip roughly as fast as we fell into it.
       *
       * The defaults are tuned for the open internet, where a link that just
       * failed is assumed likely to fail again, so the estimate is slow to
       * forgive and up-switches demand a wide margin. Measured against this
       * ladder that produced a badly asymmetric Auto: a drop to the bottom rung
       * happened within seconds, while climbing back took minutes at a
       * bandwidth that had comfortably served a much higher rung on the way
       * down. To a viewer that reads as Auto going to 144p and staying there.
       *
       * A media server on a home network is the opposite case — the link is
       * usually excellent and a dip is usually transient — so the estimate is
       * given a shorter memory and up-switches a smaller margin. Down-switching
       * is deliberately left at its default: being quick to protect playback is
       * the behaviour that was already right.
       */
      /*
       * Only the slow half of the estimate is shortened. Speeding up the fast
       * half as well was measurably worse: at a bandwidth with little headroom
       * it re-tried the rung above on every sample and oscillated between two
       * rungs, which is more distracting to watch than simply sitting on the
       * lower one. The slow half is what carries the memory of a bad patch, so
       * it is the half worth shortening.
       */
      abrEwmaSlowVoD: 6.0,
      abrBandWidthUpFactor: 0.8,
      /*
       * Every request hls.js makes — multivariant playlist, media playlists,
       * init and media segments — is authorised by the same session cookie as
       * the rest of the own-API, and in the split deployment the media origin
       * (`VITE_OWN_API_BASE_URL`) is a different host from the page. A media
       * element attaches that cookie to its own requests without being asked;
       * an XHR or a fetch does not, so without this every hls.js playback
       * answered 401 at the very first manifest load. The same omission was
       * already found and fixed once in the manifest preload.
       *
       * Both hooks are set because the loader is a config choice, not a fixed
       * one: `xhrSetup` covers the default XhrLoader and `fetchSetup` the
       * FetchLoader that a progressive or overridden config selects instead.
       */
      xhrSetup: (xhr: XMLHttpRequest) => {
        xhr.withCredentials = true;
      },
      fetchSetup: (context: LoaderContext, initParams: RequestInit) =>
        new Request(context.url, { ...initParams, credentials: "include" }),
    });
    let lockedHeight: number | null = null;
    let maximumHeight: number | null = requestedMaxHeight;
    let adaptiveMode: AutomaticQualityMode = "auto";
    let appliedLevel: number | null = null;
    let upgradeCandidate: {
      level: number;
      since: number;
      probe: boolean;
    } | null = null;
    let probeHoldUntil = 0;
    let upswitchBlockedUntil = 0;
    let lastEvaluationAt = 0;
    let recentStallCount = 0;
    let lastStallAt = 0;
    let bandwidthSamples: BandwidthSample[] = [];
    let lastSeekAt = Number.NEGATIVE_INFINITY;
    const onSeeking = () => {
      lastSeekAt = Date.now();
    };
    videoElement.addEventListener("seeking", onSeeking);

    const levelAtOrBelow = (height: number | null): number => {
      if (height === null) return -1;
      const allowed = hls.levels
        .map((level, index) => ({ index, height: level.height || 0 }))
        .filter((level) => level.height <= height)
        .sort((left, right) => right.height - left.height);
      return allowed[0]?.index ?? getBestAllowedHlsLevel(hls, height);
    };

    /**
     * The best rung of a named class or below — what a lock or a mode ceiling
     * means. Compared by class, not frame height: a letterboxed "1440p" rung
     * is 2560x1066, so a frame-height comparison let a 1080p lock play the
     * 1440p rung. Frame height stays right for the display ceiling above,
     * which is a size in pixels.
     */
    const levelAtOrBelowClass = (rungClass: number): number => {
      const allowed = hls.levels
        .map((level, index) => ({
          index,
          rungClass: canonicalRungClass(level.width ?? 0, level.height ?? 0),
          bitrate: level.averageBitrate || level.bitrate || 0,
        }))
        .filter((level) => level.rungClass <= rungClass)
        .sort(
          (left, right) =>
            right.rungClass - left.rungClass || right.bitrate - left.bitrate,
        );
      return allowed[0]?.index ?? levelAtOrBelow(rungClass);
    };

    /**
     * The tallest rung this player is physically able to show, or null when
     * that cannot be known yet.
     *
     * Returning null rather than zero is the point: an element that is hidden,
     * detached, or between sources measures nothing, and treating that as a
     * ceiling would pin Auto to the bottom rung exactly when it is least able
     * to argue back. A cap is only applied once the element has a real size.
     */
    const displayCapHeight = (): number | null => {
      const rect = videoElement.getBoundingClientRect();
      const ratio =
        typeof window === "undefined"
          ? 1
          : Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
      const usable = Math.round(rect.height * ratio);
      return usable > 0 ? usable : null;
    };

    /**
     * The ladder as the quality policy understands it: canonical classes, not
     * frame heights, so a letterboxed rung is compared as the 720p it is
     * rather than as the 536 it measures.
     */
    const adaptiveRungs = () =>
      hls.levels.map((level, index) => ({
        index,
        height: canonicalRungClass(level.width ?? 0, level.height ?? 0),
        /*
         * What the rung costs to sustain, not its peak. The policy already
         * holds a third of the estimate in reserve, and the buffer is what
         * absorbs a peak; pricing every rung at its `BANDWIDTH` on top of that
         * asked for 12.7 Mbps before offering 1080p and 24 Mbps for 2160p,
         * which kept Auto one or two rungs under what the link carried.
         * Complete files are already judged on their average bitrate.
         */
        bitrate: level.averageBitrate || level.bitrate || undefined,
      }));

    /**
     * The rung Seyirlik's own policy wants, given what the link is currently
     * measured to carry.
     *
     * hls.js's ABR is deliberately not consulted. On the physical iPad it
     * answered level 0 at every sample — 144p on a link measured at 16.8 Mbps,
     * with its own cap set five rungs higher — so Auto and Higher Quality were
     * both pinned to the bottom of the ladder whatever the connection did.
     * hls.js still measures throughput and manages buffering; only the choice
     * of rung moves here.
     */
    const chooseAdaptiveLevel = (bandwidthOptimism = 1): number => {
      const rungs = adaptiveRungs();
      if (rungs.length === 0) return -1;

      const eligible =
        maximumHeight === null
          ? rungs
          : rungs.filter((rung) => rung.height <= maximumHeight!);
      // Every rung is above the ceiling, so the cheapest honours it best.
      const pool = eligible.length > 0 ? eligible : [rungs[0]!];

      const estimate = hls.bandwidthEstimate;
      const measured =
        typeof estimate === "number" &&
        Number.isFinite(estimate) &&
        estimate > 0
          ? estimate
          : undefined;
      const target = selectAdaptiveTargetRung(pool, adaptiveMode, {
        bandwidthBps:
          measured === undefined ? undefined : measured * bandwidthOptimism,
        displayHeight: videoElement.getBoundingClientRect().height || undefined,
        devicePixelRatio:
          typeof window === "undefined" ? undefined : window.devicePixelRatio,
        recentStallCount,
      });
      return target?.index ?? pool[0]!.index;
    };

    const driveLevel = (level: number, reason: string) => {
      if (level !== appliedLevel) {
        const rung = hls.levels[level];
        abrRecord("level", {
          reason,
          from: appliedLevel,
          to: level,
          height: rung?.height,
          estimateBps: Math.round(hls.bandwidthEstimate || 0),
          bufferedAheadS: Number(bufferedAhead().toFixed(1)),
          recentStallCount,
        });
      }
      hls.loadLevel = level;
      if (hls.nextLevel !== level) hls.nextLevel = level;
      appliedLevel = level;
    };

    /** Seconds of continuous media buffered ahead of the play head. */
    const bufferedAhead = (): number => {
      const { buffered, currentTime } = videoElement;
      for (let index = 0; index < buffered.length; index += 1) {
        if (
          buffered.start(index) <= currentTime + 0.25 &&
          buffered.end(index) > currentTime
        ) {
          return buffered.end(index) - currentTime;
        }
      }
      return 0;
    };

    /**
     * Restarts loading the browser paused and forgot to restart.
     *
     * See MMS_RESUME_BUFFER_SECONDS. hls.js obeys `endstreaming` by pausing
     * every loader; a play head with nothing under it is the one state in
     * which that pause can only be wrong, whatever `streaming` still says.
     * If the browser later decides the buffer is ample, its next
     * `endstreaming` pauses loading again exactly as before.
     */
    const resumeStarvedLoading = (reason: string) => {
      if (hls.bufferingEnabled) return;
      if (bufferedAhead() >= MMS_RESUME_BUFFER_SECONDS) return;
      abrRecord("resume-loading", {
        reason,
        currentTimeS: Number(videoElement.currentTime.toFixed(1)),
        bufferedAheadS: Number(bufferedAhead().toFixed(1)),
      });
      hls.resumeBuffering();
    };
    const onSeekingResume = () => resumeStarvedLoading("seeking");
    const onWaitingResume = () => resumeStarvedLoading("waiting");
    videoElement.addEventListener("seeking", onSeekingResume);
    videoElement.addEventListener("waiting", onWaitingResume);

    const evaluateAdaptiveTarget = (force = false) => {
      if (hls.levels.length === 0) return;
      const now = Date.now();
      if (!force && now - lastEvaluationAt < RUNG_EVALUATION_INTERVAL_MS)
        return;
      lastEvaluationAt = now;

      /*
       * Recorded whatever the mode, because the trend describes the link and
       * not the menu. Sampling only while Auto is in charge would hand a
       * session returning from a manual rung an empty history at exactly the
       * moment it has to decide, and an empty history reads as "steady".
       */
      const estimate = hls.bandwidthEstimate;
      if (
        typeof estimate === "number" &&
        Number.isFinite(estimate) &&
        estimate > 0
      ) {
        bandwidthSamples.push({ at: now, bps: estimate });
        bandwidthSamples = bandwidthSamples.filter(
          (sample) => now - sample.at <= BANDWIDTH_TREND_WINDOW_MS,
        );
      }

      // A locked rung is the viewer's decision; nothing here overrides it.
      if (lockedHeight !== null) return;

      if (recentStallCount > 0 && now - lastStallAt > STALL_MEMORY_MS) {
        recentStallCount = 0;
      }

      let target = chooseAdaptiveLevel();
      if (target < 0) return;
      const current = appliedLevel ?? -1;
      let probing = false;

      /*
       * Climb one rung on the buffer's evidence when the estimate has nothing
       * useful to say. Without this the session cannot leave a low rung it
       * arrived at during a rough start: the rung keeps the fragments small,
       * the small fragments keep the estimate low, and the low estimate keeps
       * the rung. Overshooting is self-correcting — the buffer stops filling,
       * a stall follows, and the ordinary immediate downgrade applies.
       */
      if (
        current >= 0 &&
        target <= current &&
        recentStallCount === 0 &&
        bufferedAhead() >= PROBE_BUFFER_SECONDS &&
        // A buffer that has not drained yet is not evidence the link is still
        // there. When the estimate is already on its way down, the buffer is
        // spending what the link no longer earns, so the probe stands aside
        // and lets the ordinary policy follow the estimate down.
        !isBandwidthFalling(bandwidthSamples, now)
      ) {
        /*
         * The question is put back to the same policy rather than answered
         * here, so everything the policy knows still applies — the display
         * ceiling above all. Stepping the level directly ignored that ceiling
         * and produced a loop: the probe climbed to a rung the screen cannot
         * show, the anchor pulled it straight back on the next tick, and the
         * session cycled 1080p -> 1440p -> 2160p -> 1080p indefinitely.
         */
        const optimistic = chooseAdaptiveLevel(PROBE_BANDWIDTH_OPTIMISM);
        if (optimistic > current) {
          target = Math.min(optimistic, current + 1);
          probing = true;
        }
      }

      if (current < 0 || target <= current) {
        upgradeCandidate = null;
        if (target === current) return;
        // See PROBE_GRACE_MS: a rung the probe has just taken is not given up
        // on the word of the reading it was taken in spite of — but only
        // while the buffer is still saying the same thing the probe heard.
        if (
          now < probeHoldUntil &&
          recentStallCount === 0 &&
          bufferedAhead() >= PROBE_BUFFER_SECONDS
        ) {
          return;
        }
        driveLevel(target, current < 0 ? "start" : "down");
        return;
      }

      // See STALL_UPSWITCH_BLOCK_MS: right after a stall the estimate still
      // describes the link as it was before it failed.
      if (now < upswitchBlockedUntil) {
        upgradeCandidate = null;
        return;
      }

      /*
       * The clock measures how long *some* better rung has been affordable,
       * not how long one particular rung has been the answer. Restarting it
       * whenever the target moved between two neighbouring rungs meant a
       * fluctuating estimate reset the timer on every sample, so the climb
       * never arrived: measured on the iPad, Auto sat on the bottom rung for
       * 42 s while the link comfortably carried 480p the entire time.
       */
      if (!upgradeCandidate) {
        upgradeCandidate = { level: target, since: now, probe: probing };
        return;
      }
      upgradeCandidate.level = target;
      upgradeCandidate.probe = probing;
      if (now - upgradeCandidate.since >= UPSWITCH_HOLD_MS) {
        const climbTo = upgradeCandidate.level;
        const climbWasProbed = upgradeCandidate.probe;
        upgradeCandidate = null;
        if (climbWasProbed) probeHoldUntil = now + PROBE_GRACE_MS;
        driveLevel(climbTo, climbWasProbed ? "probe-up" : "up");
      }
    };

    const applyAdaptivePreference = () => {
      if (hls.levels.length === 0) return;
      // Auto is capped to what the screen can show. A derived or manual mode
      // already incorporates Auto's display-aware baseline, so its explicit
      // target owns the cap; applying the display limit a second time would
      // erase Higher Quality's deliberate one-rung upward bias.
      const display = displayCapHeight();
      hls.autoLevelCapping =
        maximumHeight !== null
          ? levelAtOrBelowClass(maximumHeight)
          : levelAtOrBelow(display);

      if (lockedHeight === null) {
        /*
         * Back to automatic. The rung is chosen here rather than by hls.js, so
         * returning to Auto re-decides immediately instead of handing the
         * ladder to an ABR controller that answers 144p regardless of the
         * link. Nothing already buffered is thrown away to get there.
         */
        upgradeCandidate = null;
        appliedLevel = null;
        evaluateAdaptiveTarget(true);
        return;
      }

      // Leaving automatic: forget the pending climb so a stale candidate
      // cannot fire a switch after the viewer has taken manual control.
      upgradeCandidate = null;

      // An explicit rung is a promise to the viewer, so it has to become the
      // picture within a second or two. `loadLevel` alone only changes what is
      // fetched next, and a title whose whole timeline is already buffered has
      // nothing left to fetch — the click then does nothing visible for
      // minutes, until the old rung has finished playing out. `nextLevel`
      // replaces the buffer ahead of the play head while leaving the fragment
      // currently on screen alone, so the change lands quickly without the
      // black frame that flushing everything (`currentLevel`) would cause.
      const level = levelAtOrBelowClass(lockedHeight);
      driveLevel(level, "locked");
    };

    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.MANIFEST_PARSED, data });
      applyAdaptivePreference();
    });
    hls.on(Hls.Events.LEVELS_UPDATED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.LEVELS_UPDATED, data });
      applyAdaptivePreference();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.LEVEL_SWITCHED, data });
      const level = hls.levels[data.level];
      if (level?.height) {
        options.onAdaptiveLevelChanged?.({
          height: level.height,
          width: level.width ?? 0,
        });
      }

      console.info("[Seyirlik Playback] HLS level switched", {
        level: data.level,
        width: level?.width,
        height: level?.height,
        bitrate: level?.bitrate,
        requestedMaxHeight,
        autoLevelCapping: hls.autoLevelCapping,
      });
    });

    hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.FRAG_BUFFERED, data });
      // Each buffered fragment is a fresh throughput sample, and the only
      // regular tick available while playback is steady.
      evaluateAdaptiveTarget();
    });

    hls.on(Hls.Events.BUFFER_APPENDED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.BUFFER_APPENDED, data });
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.ERROR, data });

      if (data.fatal) {
        console.error("[Seyirlik Playback] hls.js fatal error", data);
        if (options.onHlsFatalError) {
          options.onHlsFatalError(data);
        } else {
          videoElement.dispatchEvent(new Event("error"));
        }
      } else {
        const seekInduced =
          videoElement.seeking || Date.now() - lastSeekAt < SEEK_STALL_GRACE_MS;
        if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
          abrRecord("stall", {
            charged: !seekInduced && bufferedAhead() < STARVED_BUFFER_SECONDS,
            seekInduced,
            level: appliedLevel,
            bufferedAheadS: Number(bufferedAhead().toFixed(1)),
            estimateBps: Math.round(hls.bandwidthEstimate || 0),
          });
        }
        if (
          data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR &&
          // See SEEK_STALL_GRACE_MS: the seek emptied the buffer, not the link.
          !seekInduced &&
          // A stall with a full buffer is not a bandwidth signal. Charging for
          // those let the ordinary flurry while a session fills its buffer
          // bankrupt the budget before playback had settled.
          bufferedAhead() < STARVED_BUFFER_SECONDS
        ) {
          /*
           * Capped at two. Each stall costs 40% of the budget, so allowing a
           * third let the ordinary flurry of stalls while a session is still
           * filling its buffer drive the budget under the cheapest rung on the
           * ladder — the penalty for a rough start became a session pinned to
           * 144p.
           */
          recentStallCount = Math.min(recentStallCount + 1, 2);
          lastStallAt = Date.now();
          /*
           * Step down at once, without waiting for the estimate to agree.
           *
           * The estimate cannot agree: it only moves when a fragment finishes,
           * and the fragment is precisely what is not finishing. Measured on
           * the iPad against a link too slow to deliver anything, the policy
           * therefore held 1080p throughout — and because an explicitly driven
           * level turns off hls.js's own abandon-and-retry rules, the stuck
           * fragment was never given up either. Playback came back about a
           * minute later, when the loader finally timed out.
           *
           * Dropping a rung writes `nextLevel`, which abandons that fragment
           * and asks for the cheaper rung's much smaller one instead. The
           * ladder is then climbed back in seconds if the stall was a blip.
           */
          upswitchBlockedUntil = lastStallAt + STALL_UPSWITCH_BLOCK_MS;
          if (
            lockedHeight === null &&
            appliedLevel !== null &&
            appliedLevel > 0
          ) {
            upgradeCandidate = null;
            probeHoldUntil = 0;
            driveLevel(appliedLevel - 1, "stall");
          }
          // A stall is evidence the current rung is too expensive, and the
          // policy charges for it — so re-decide without waiting for the tick.
          evaluateAdaptiveTarget(true);
        }
        console.warn("[Seyirlik Playback] hls.js warning", data);
      }
    });

    // A downloaded title plays from the service worker's cache; a receiver
    // could not reach those bytes, so it is not offered one.
    if (options.forceMediaSource !== true) {
      hls.on(Hls.Events.MEDIA_ATTACHING, () =>
        offerAirPlayAlternative(videoElement, playbackUrl),
      );
    }

    hls.loadSource(playbackUrl);
    hls.attachMedia(videoElement);

    const snapshot = () => {
      const level =
        appliedLevel === null ? undefined : hls.levels[appliedLevel];
      return {
        engine: "hls.js",
        managedMediaSource:
          typeof (window as unknown as { ManagedMediaSource?: unknown })
            .ManagedMediaSource !== "undefined",
        airplayOffered: videoElement.disableRemotePlayback === false,
        mode: lockedHeight === null ? adaptiveMode : "locked",
        lockedHeight,
        maximumHeight,
        appliedLevel,
        appliedHeight: level?.height,
        playingLevel: hls.currentLevel,
        decodedWidth: videoElement.videoWidth,
        decodedHeight: videoElement.videoHeight,
        estimateBps: Math.round(hls.bandwidthEstimate || 0),
        bufferedAheadS: Number(bufferedAhead().toFixed(1)),
        recentStallCount,
        upswitchBlockedForMs: Math.max(0, upswitchBlockedUntil - Date.now()),
        pendingClimb: upgradeCandidate,
        ladder: hls.levels.map((rung, index) => ({
          index,
          height: rung.height,
          averageBps: rung.averageBitrate,
          peakBps: rung.bitrate,
        })),
      };
    };
    abrSnapshot = snapshot;

    /*
     * The display ceiling changes with the window, with fullscreen, and simply
     * with the element gaining a size after layout. Re-evaluating on resize is
     * what lets a player that was measured at zero recover the moment it has
     * real dimensions, instead of staying capped for the rest of the session.
     */
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => applyAdaptivePreference());
    observer?.observe(videoElement);

    // See RUNG_TICK_INTERVAL_MS: the engine's own events arrive in bursts, so
    // the policy keeps its own clock rather than inheriting that shape.
    const rungTicker = setInterval(() => {
      // Also the backstop for a starved play head that raised no event.
      resumeStarvedLoading("tick");
      evaluateAdaptiveTarget();
    }, RUNG_TICK_INTERVAL_MS);

    return {
      usingHlsJs: true,
      adaptiveController: {
        setQualityHeight: (height, maxHeight = null, mode = "auto") => {
          lockedHeight = height;
          maximumHeight = maxHeight;
          adaptiveMode = mode;
          applyAdaptivePreference();
        },
        getBandwidthEstimateBps: () => {
          const estimate = hls.bandwidthEstimate;
          return typeof estimate === "number" &&
            Number.isFinite(estimate) &&
            estimate > 0
            ? estimate
            : undefined;
        },
        setAudioStream: (sourceStreamIndex) => {
          // The master names each rendition's source stream; a package laid
          // out by language has no `track-N` in its paths to go by.
          const marker = `track-${sourceStreamIndex}`;
          const index = hls.audioTracks.findIndex((track) => {
            const candidate = track as typeof track & { url?: string };
            return (
              candidate.attrs?.["X-SEYIRLIK-STREAM-INDEX"] ===
                String(sourceStreamIndex) ||
              candidate.url?.includes(marker) ||
              candidate.name.includes(marker)
            );
          });
          if (index < 0) return false;
          hls.audioTrack = index;
          return true;
        },
      },
      destroy: () => {
        clearInterval(rungTicker);
        observer?.disconnect();
        videoElement.removeEventListener("seeking", onSeeking);
        videoElement.removeEventListener("seeking", onSeekingResume);
        videoElement.removeEventListener("waiting", onWaitingResume);
        if (abrSnapshot === snapshot) abrSnapshot = null;
        hls.destroy();
        videoElement.removeAttribute("src");
        videoElement.load();
      },
    };
  }

  if (isHls) {
    throw new Error(
      "This browser cannot attach HLS playback. Safari supports HLS natively, while Chrome, Edge, and Firefox need MediaSource Extensions.",
    );
  }

  videoElement.src = playbackUrl;

  return {
    usingHlsJs: false,
    destroy: () => {
      videoElement.removeAttribute("src");
      videoElement.load();
    },
  };
}
