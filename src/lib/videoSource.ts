import Hls, { type LoaderContext } from "hls.js";

import {
  type AutomaticQualityMode,
  canonicalRungClass,
  selectAdaptiveTargetRung,
} from "../components/player/qualityPreference";
import {
  createThroughputAccumulator,
  deliveryOrigin,
  openingBandwidthEstimate,
  rememberDeliveredThroughput,
  UNKNOWN_LINK_ESTIMATE_BPS,
  type OpeningEstimate,
} from "./throughputMemory";

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
    options?: QualitySelectionOptions,
  ): void;
  setAudioStream(sourceStreamIndex: number): boolean;
  /**
   * The estimate the adaptive policy is currently deciding by, in bits/second.
   *
   * Once a fragment has landed this is throughput observed while pulling real
   * fragments, which is a far better number than
   * `navigator.connection.downlink` — that is a coarse, rounded hint the
   * browser volunteers, and Safari and Firefox do not volunteer it at all.
   * Before then it is the opening estimate (see `throughputMemory.ts`), so the
   * menu labels itself from the same number the policy chose the opening rung
   * by.
   */
  getBandwidthEstimateBps(): number | undefined;
}

export interface QualitySelectionOptions {
  /**
   * The viewer just chose this in the menu, so it should become the picture
   * as soon as it can be fetched — replacing the media already buffered at
   * other rungs, however much of it there is. Left unset for everything the
   * player re-applies by itself (start-up, resizes, the periodic bias review),
   * which must never discard what is buffered.
   */
  immediate?: boolean;
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

/**
 * How much of the current buffer a replacement keeps in front of the cut.
 *
 * A replacement must never remove media the new rung cannot be fetched in
 * time to cover: the play head would run into the hole and stall, which is
 * exactly the interruption this exists to avoid. So the new rung takes over
 * beyond an estimate of how long its first fragment takes to land (latency
 * per request plus transfer at the link's measured rate), multiplied by a
 * safety factor, plus a floor for decode and append.
 *
 * A choice the viewer just made is bound by a deadline instead: it is on
 * screen within `SELECTED_DEADLINE_SECONDS` of the pick. The viewer's rule
 * (2026-11-12): "the maximum amount of time the transition must be 3
 * seconds; if that is going to take more than that, then after 3 seconds,
 * pause is okay. We do not want to wait." With the generous margin a pick
 * from 144p to 1080p took 8.5 s to appear on a clean 20 Mbps link, longer
 * over the tunnel. So a pick uses the tight margin (`SELECTED_SAFETY_FACTOR`,
 * `SELECTED_FLOOR_SECONDS`) when that lands inside the deadline — a seamless
 * switch, which is what a good, steady connection gets — and otherwise takes
 * over at the last fragment boundary inside the deadline, accepting a short
 * pause there if the new rung's first fragment is still on its way. Nothing
 * is taken over closer than `SELECTED_MIN_LEAD_SECONDS` to the play head,
 * which would replace frames the decoder is already holding. Automatic
 * replacements keep the generous margin, which their retained window dwarfs
 * regardless.
 */
const REPLACE_SAFETY_FACTOR = 2;
const REPLACE_FLOOR_SECONDS = 1;
const SELECTED_SAFETY_FACTOR = 1.5;
const SELECTED_FLOOR_SECONDS = 0.5;
const SELECTED_DEADLINE_SECONDS = 3;
const SELECTED_MIN_LEAD_SECONDS = 0.5;

/** How often, and for how long, a deadline takeover is watched for lateness. */
const LATE_TAKEOVER_POLL_MS = 50;
const LATE_TAKEOVER_WATCH_MS = 20_000;

/**
 * How far into the takeover fragment the old rung is cut; see the cut.
 *
 * Far enough past the fragment's slot to clear any B-frame reorder delay
 * (83 ms in Chromium and 167 ms in WebKit on the packages measured), and no
 * further: a takeover that arrives late pauses at the cut, so every tenth of
 * a second past the takeover is old picture shown after the deadline. Cut
 * halfway in, a late 1080p pick paused 2.7 s after the click; cut here, 2.1 s.
 */
const REPLACE_CUT_SECONDS = 0.4;

/**
 * How much lower-rung media an automatic climb keeps before replacing.
 *
 * Without replacement an automatic climb becomes visible only once everything
 * buffered at the old rung has played, which after a dip is a long time:
 * measured in Chromium on this ladder, the picture stayed at 480p for 88 s
 * after the link had recovered to 30 Mbps, and at 144p for most of a minute
 * after a collapse. So a climb replaces the forward buffer beyond a retained
 * window — the established practice: ExoPlayer discards lower-quality chunks
 * beyond a retained duration on an upgrade, dash.js calls it fast switching.
 *
 * The window is ten seconds when the measured link carries the new rung's
 * *peak* rate with `AUTO_UPGRADE_HEADROOM` to spare, so the refill plainly
 * outpaces playback. Otherwise the climb is partly a guess — the buffer probe
 * climbs precisely because the estimate cannot be trusted — and twenty
 * seconds stay behind: if the guess is wrong, the ordinary step down and the
 * engine's abandonment have that long to act before the viewer could notice.
 * Steps down never replace anything: what is buffered is better than what
 * would replace it, and it is the buffer that protects the viewer from the
 * dip.
 */
const AUTO_UPGRADE_HEADROOM = 1.5;
const AUTO_UPGRADE_RETAIN_SECONDS = 10;
const AUTO_UPGRADE_UNPROVEN_RETAIN_SECONDS = 20;

/**
 * Longest forward buffer, in seconds of media.
 *
 * hls.js sizes its buffer in bytes (60 MB) as well as seconds, so on a cheap
 * rung it kept buffering far past its 30 s goal — up to its 600 s ceiling;
 * measured, a 360p session held over a hundred seconds ahead. With switches
 * that no longer flush, that buffer is what a viewer watches before any
 * better rung can appear, and it is memory and data spent on the worst
 * picture. A minute is still twice the time-based goal.
 */
const MAX_FORWARD_BUFFER_SECONDS = 60;

/** Used when the engine has not measured a first-byte latency yet. */
const DEFAULT_TTFB_MS = 400;

/**
 * Measured fragments that may overturn the opening rung without the up-switch
 * hold.
 *
 * The hold exists so one lucky sample cannot start an oscillation. The opening
 * rung was not chosen from a sample at all — it was chosen from a prior, which
 * is weaker evidence than any measurement — so the first real readings are
 * allowed to correct it at once, upwards as well as down. Two, so the
 * correction rests on more than one fragment, which is the same evidence the
 * hold would have collected at the one-second tick. It applies once per
 * attachment; every later climb is paced by the hold as before.
 */
const STARTUP_CONFIRMING_FRAGMENTS = 2;

/** How often a playing session refreshes what it remembers about the link. */
const THROUGHPUT_PERSIST_INTERVAL_MS = 10_000;

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

type AbrControllerClass = typeof Hls.DefaultConfig.abrController;

/**
 * hls.js's own ABR controller, with the choice of rung handed to Seyirlik.
 *
 * This is the extension point hls.js provides for an application that owns
 * its adaptive policy, and using it is what keeps switches seamless. The engine
 * stays in its automatic mode, where a new rung only changes which rendition
 * the *next* fragment is fetched from: everything already buffered plays out
 * untouched and the new rung joins at the next fragment boundary, which the
 * packager aligns to the frame across every rendition. Driving levels manually
 * instead (`loadLevel`/`nextLevel`) put the engine in manual mode, where every
 * decision flushed the buffer ahead of the play head and refetched it — a
 * rebuffer risk on every switch, and on ManagedMediaSource a hole the browser
 * did not always ask to refill.
 *
 * Only the choice moves. Throughput and latency estimation, the emergency
 * abandonment of a fragment that will not arrive before the buffer runs dry,
 * and the level fallback after a delivery error all stay hls.js's — and all of
 * them only run in automatic mode, which manual driving had switched off.
 *
 * `readPolicyLevel` returns null until the policy has decided, and the engine's
 * own answer is used until then. A level the engine sets itself (abandonment,
 * error fallback) is reported through `onEngineLevel` so the policy can adopt
 * it instead of immediately overriding the engine's emergency decision.
 */
export function createPolicyAbrController(
  readPolicyLevel: () => number | null,
  onEngineLevel: (level: number) => void,
): AbrControllerClass {
  const Base = Hls.DefaultConfig.abrController;
  return class SeyirlikPolicyAbrController extends Base {
    get nextAutoLevel(): number {
      const level = readPolicyLevel();
      const count = this.hls?.levels?.length ?? 0;
      if (level !== null && level >= 0 && level < count) return level;
      return super.nextAutoLevel;
    }

    set nextAutoLevel(level: number) {
      super.nextAutoLevel = level;
      const policyLevel = readPolicyLevel();
      if (policyLevel !== null && level >= 0 && level !== policyLevel) {
        onEngineLevel(level);
      }
    }
  };
}

/** The fields of an hls.js fragment the switching logic reads. */
interface MainFragmentInfo {
  type?: string;
  sn?: number | string;
  level: number;
  start: number;
  duration: number;
}

/** A request to replace part of the forward video buffer with one rung. */
interface Replacement {
  level: number;
  /** Seconds ahead of the play head that are kept whatever the margin. */
  retainSeconds: number;
  /** Only media of a lower rung is replaced (an automatic upgrade). */
  onlyLower: boolean;
  reason: "manual" | "selected" | "upgrade";
}

function asMainFragment(data: unknown): MainFragmentInfo | null {
  const frag = (data as { frag?: MainFragmentInfo } | undefined)?.frag;
  if (!frag || frag.type !== "main" || typeof frag.level !== "number") {
    return null;
  }
  return frag;
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
    /*
     * A downloaded title plays from the service worker's cache, so it neither
     * learns from nor is told about the network: its "throughput" is a disk
     * read, and remembering it would open the next streamed title at the top
     * of the ladder.
     */
    const throughputOrigin =
      options.forceMediaSource === true
        ? undefined
        : deliveryOrigin(playbackUrl);
    const opening: OpeningEstimate = throughputOrigin
      ? openingBandwidthEstimate(throughputOrigin)
      : { bps: UNKNOWN_LINK_ESTIMATE_BPS, source: "default" };
    abrRecord("opening-estimate", {
      source: opening.source,
      bps: Math.round(opening.bps),
      ...(opening.ageMs === undefined
        ? {}
        : { ageS: Math.round(opening.ageMs / 1000) }),
      ...(opening.confidence === undefined
        ? {}
        : { confidence: opening.confidence }),
    });

    /*
     * The rung Seyirlik's policy wants while Auto is in charge, read by hls.js
     * through the controller below every time it picks the next fragment.
     * Declared before the engine exists because the engine builds its ABR
     * controller in its own constructor.
     */
    let policyLevel: number | null = null;
    let adoptEngineLevel: (level: number) => void = () => undefined;
    const hls = new Hls({
      enableWorker: true,
      abrController: createPolicyAbrController(
        () => policyLevel,
        (level) => adoptEngineLevel(level),
      ),
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
      maxMaxBufferLength: MAX_FORWARD_BUFFER_SECONDS,
      lowLatencyMode: false,
      startLevel: -1,
      /*
       * What the estimator reports until its first sample, and therefore what
       * the opening rung is chosen by: the policy decides at MANIFEST_PARSED,
       * before anything is fetched, and pins that rung as the start level
       * (see `driveLevel`). It was a fixed 5 Mbps, which under the policy's
       * two-thirds margin bought 720p for everyone. The estimator drops it
       * entirely on the first real sample.
       */
      abrEwmaDefaultEstimate: opening.bps,
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
    /** Main fragments buffered, i.e. samples hls.js's estimator has taken. */
    let measuredFragments = 0;
    /** See STARTUP_CONFIRMING_FRAGMENTS. Consumed by the first evaluation that has the evidence. */
    let startupCorrectionPending = true;
    const deliveredThroughput = createThroughputAccumulator();
    let lastThroughputPersistAt = Number.NEGATIVE_INFINITY;
    const persistDeliveredThroughput = (force = false) => {
      if (!throughputOrigin) return;
      const bps = deliveredThroughput.estimateBps();
      if (bps === undefined) return;
      const now = Date.now();
      if (
        !force &&
        now - lastThroughputPersistAt < THROUGHPUT_PERSIST_INTERVAL_MS
      )
        return;
      lastThroughputPersistAt = now;
      rememberDeliveredThroughput(throughputOrigin, bps, { now });
    };
    /*
     * Whether a fragment of the rung the policy last chose has actually been
     * fetched. A switch only changes what is fetched next, so until one such
     * fragment lands the estimate still describes the previous rung and says
     * nothing about whether the new one is sustainable. Climbing again before
     * that would be climbing on no evidence at all — under ManagedMediaSource,
     * where loading pauses for tens of seconds with a full buffer, a timer
     * alone would walk the whole ladder while nothing was downloaded.
     */
    let appliedLevelMeasured = false;
    let levelDecidedAt = 0;
    /** The rung the viewer locked, as last handed to the engine. */
    let manualLevel: number | null = null;
    /** Main-rendition fragments now buffered, by sequence number. */
    const bufferedMainFragments = new Map<
      string,
      { level: number; start: number; end: number; duration: number }
    >();
    let mainFragmentLoading: MainFragmentInfo | null = null;
    /** A manual pick whose buffer replacement waits for an old-rung fetch. */
    let pendingReplacement: Replacement | null = null;
    let anyMainFragmentBuffered = false;

    const onSeeking = () => {
      lastSeekAt = Date.now();
      // A replacement planned against the old position no longer applies;
      // the seek target is fetched from the locked rung anyway.
      pendingReplacement = null;
      clearLateTakeoverHold();
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

    /**
     * Hands an automatic decision to the engine without touching the buffer.
     *
     * The engine reads `policyLevel` when it picks the next fragment, so the
     * new rung joins at the next fragment boundary after what is already
     * buffered. Nothing is flushed, nothing in flight is cancelled and the
     * play head is never moved: the viewer keeps watching the media they
     * already have, which on a down-switch is exactly the media that protects
     * them from the dip that caused it.
     */
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
      if (level !== policyLevel) {
        appliedLevelMeasured = false;
        levelDecidedAt = Date.now();
      }
      // The first fragment has to come from the policy's rung too, without an
      // extra probe fragment from the bottom of the ladder.
      if (!anyMainFragmentBuffered) hls.startLevel = level;
      const previous = policyLevel;
      policyLevel = level;
      appliedLevel = level;
      /*
       * A step down is also told to the engine's abandonment rules, which then
       * treat a higher-rung fragment still downloading as blocking the switch.
       * They abandon it only if it would finish after the buffer runs dry and
       * the cheaper fragment would not; with a healthy buffer they leave it
       * alone and it is played like everything else already paid for.
       */
      if (previous !== null && level < previous) hls.nextAutoLevel = level;

      // A replacement still waiting for an older decision no longer applies.
      if (pendingReplacement && pendingReplacement.level !== level) {
        pendingReplacement = null;
      }
      /*
       * See AUTO_UPGRADE_RETAIN_SECONDS: a climb does not have to wait for the
       * whole lower-rung buffer to play out first. Never while the link is
       * wobbling or has just stalled, and the more the climb is a guess, the
       * more of the old buffer it keeps.
       */
      const estimate = hls.bandwidthEstimate;
      const peak = hls.levels[level]?.bitrate || 0;
      if (
        (reason === "up" || reason === "probe-up") &&
        previous !== null &&
        level > previous &&
        recentStallCount === 0 &&
        !isBandwidthFalling(bandwidthSamples, Date.now())
      ) {
        const proven = peak > 0 && estimate >= peak * AUTO_UPGRADE_HEADROOM;
        replaceBufferAhead({
          level,
          retainSeconds: proven
            ? AUTO_UPGRADE_RETAIN_SECONDS
            : AUTO_UPGRADE_UNPROVEN_RETAIN_SECONDS,
          onlyLower: true,
          reason: "upgrade",
        });
      }
    };

    /*
     * The engine overruled the policy: it abandoned a fragment that would not
     * arrive before the buffer ran dry, or fell back from a rung whose delivery
     * failed. Both are emergencies the engine is better placed to see, so the
     * policy adopts the level rather than steering straight back into the
     * problem, and a downward one is treated like a stall for climbing.
     */
    adoptEngineLevel = (level: number) => {
      if (lockedHeight !== null || level === appliedLevel) return;
      abrRecord("engine-level", {
        from: appliedLevel,
        to: level,
        height: hls.levels[level]?.height,
        estimateBps: Math.round(hls.bandwidthEstimate || 0),
        bufferedAheadS: Number(bufferedAhead().toFixed(1)),
      });
      if (appliedLevel !== null && level < appliedLevel) {
        upswitchBlockedUntil = Date.now() + STALL_UPSWITCH_BLOCK_MS;
        probeHoldUntil = 0;
      }
      upgradeCandidate = null;
      appliedLevelMeasured = false;
      levelDecidedAt = Date.now();
      policyLevel = level;
      appliedLevel = level;
    };

    /** End of the buffered range under the play head, or null if none. */
    const bufferedEnd = (): number | null => {
      const { buffered, currentTime } = videoElement;
      for (let index = 0; index < buffered.length; index += 1) {
        if (
          buffered.start(index) <= currentTime + 0.25 &&
          buffered.end(index) > currentTime
        ) {
          return buffered.end(index);
        }
      }
      return null;
    };

    /**
     * Replaces the video buffered ahead with `level`, keeping what covers the
     * fetch (and, for an automatic upgrade, `retainSeconds` more).
     *
     * Used for a manual pick, which is a request to see that rung now, and for
     * an automatic upgrade the link has ample room for (see
     * `AUTO_UPGRADE_HEADROOM`). A step down never comes here: what is already
     * buffered is better than what replaces it, and it is what protects the
     * viewer from the dip. The new rung takes over at a fragment boundary —
     * where every rung of an aligned package starts on the same IDR frame —
     * and only the video buffer is cut: the audio rendition is shared by every
     * rung and keeps playing from what it already has.
     */
    /*
     * A takeover the deadline forced can arrive after the play head reaches
     * it, and the viewer accepted a pause for that. WebKit pauses there. Chromium
     * does not: it rides out up to three seconds of video underflow while the
     * audio has data, so the sound plays on over a frozen frame and the late
     * frames are then dropped — measured, a 1080p pick on a 6 Mbps link froze
     * from 43.0 s to 45.8 s, skipped those seconds of picture, and appeared at
     * 7.6 s. Cutting the audio up front does not help: hls.js loads audio one
     * fragment ahead of the video fragment it is fetching, so it is refilled
     * past the hole within half a second.
     *
     * So, while such a takeover is outstanding, a play head that runs past the
     * end of the video (no buffered range under it, still playing) has the
     * audio ahead of it removed. Both tracks are then empty, Chromium waits —
     * and it resumes only once video has data too, which is the pause the
     * viewer agreed to. The shared audio rendition is fetched back unchanged.
     * WebKit never gets here: its play head stops at the end of the video.
     */
    let lateTakeover: {
      level: number;
      takeoverAt: number;
      armedAt: number;
      held: boolean;
    } | null = null;
    let lateTakeoverTimer: ReturnType<typeof setInterval> | null = null;
    const clearLateTakeoverHold = () => {
      lateTakeover = null;
      if (lateTakeoverTimer !== null) clearInterval(lateTakeoverTimer);
      lateTakeoverTimer = null;
    };
    const holdForLateTakeover = () => {
      const pending = lateTakeover;
      if (!pending) return;
      if (Date.now() - pending.armedAt > LATE_TAKEOVER_WATCH_MS) {
        clearLateTakeoverHold();
        return;
      }
      if (pending.held || videoElement.paused || videoElement.seeking) return;
      const now = videoElement.currentTime;
      if (now < pending.takeoverAt || bufferedEnd() !== null) return;
      pending.held = true;
      abrRecord("late-takeover-hold", {
        level: pending.level,
        currentTimeS: Number(now.toFixed(3)),
      });
      hls.trigger(Hls.Events.BUFFER_FLUSHING, {
        startOffset: now,
        endOffset: Number.POSITIVE_INFINITY,
        type: "audio",
      });
    };
    const armLateTakeoverHold = (level: number, takeoverAt: number) => {
      clearLateTakeoverHold();
      lateTakeover = { level, takeoverAt, armedAt: Date.now(), held: false };
      lateTakeoverTimer = setInterval(
        holdForLateTakeover,
        LATE_TAKEOVER_POLL_MS,
      );
    };

    const replaceBufferAhead = (replacement: Replacement) => {
      const { level, retainSeconds, onlyLower } = replacement;
      pendingReplacement = null;
      const end = bufferedEnd();
      if (end === null) return;
      // A muxed package would need audio cut too; only the shared-audio
      // layout every adaptive package uses is handled.
      const audioIsAlternate = hls.audioTracks.some((track) =>
        Boolean((track as { url?: string }).url),
      );
      if (!audioIsAlternate) return;

      const chosenNow =
        replacement.reason === "manual" || replacement.reason === "selected";
      /*
       * An old-rung fragment still downloading would be appended after the
       * cut and leave a stretch of the old rung inside the new one, and the
       * engine fetches nothing for the new rung until it has finished. An
       * automatic replacement waits for it (at most one fragment). A pick
       * cannot afford to — that wait alone can exceed its deadline on a slow
       * link — so loading is stopped and restarted from the play head, the
       * engine's own public way to drop what is in flight. Nothing buffered
       * is touched by that, audio included; loading resumes from each
       * buffer's end, now at the chosen rung.
       */
      if (mainFragmentLoading && mainFragmentLoading.level !== level) {
        if (!chosenNow) {
          pendingReplacement = replacement;
          return;
        }
        abrRecord("abort-in-flight", {
          level: mainFragmentLoading.level,
          sn: mainFragmentLoading.sn,
        });
        mainFragmentLoading = null;
        hls.stopLoad();
        hls.startLoad(videoElement.currentTime, true);
      }

      const rung = hls.levels[level];
      if (!rung) return;
      const details = (rung as { details?: { targetduration?: number } })
        .details;
      const fragmentSeconds = details?.targetduration ?? 2;
      /*
       * hls.js's own estimate, deliberately. It reads low on small fragments,
       * which only ever makes the margin cautious, and the deadline below
       * bounds what that caution can cost a pick. A transfer rate measured
       * from first byte to last was tried and read a 6 Mbps link as 3 Gbps:
       * small fragments arrive in one burst behind their first byte.
       */
      const bandwidth =
        hls.bandwidthEstimate > 0 ? hls.bandwidthEstimate : 1_000_000;
      const ttfbSeconds =
        ((hls as { ttfbEstimate?: number }).ttfbEstimate || DEFAULT_TTFB_MS) /
        1000;
      // An unloaded rung needs its playlist and init segment first.
      const requests = details ? 1 : 3;
      const peak = rung.bitrate || rung.averageBitrate || 0;
      const fetchSeconds =
        requests * ttfbSeconds + (peak * fragmentSeconds) / bandwidth;
      const rate = Math.max(Math.abs(videoElement.playbackRate) || 1, 1);
      const keep = chosenNow
        ? fetchSeconds * SELECTED_SAFETY_FACTOR + SELECTED_FLOOR_SECONDS
        : fetchSeconds * REPLACE_SAFETY_FACTOR + REPLACE_FLOOR_SECONDS;
      const margin = keep * rate;
      const horizon =
        videoElement.currentTime + Math.max(margin, retainSeconds * rate);

      /*
       * The first old-rung fragment that starts beyond the horizon is where
       * the new rung takes over. The cut itself is made halfway into it, not
       * at its start: fragment times are on the playlist's grid, while the
       * picture is not. An encoder using B-frames delays every presentation
       * timestamp by its reorder depth — 83 ms on the packages measured, so
       * the video buffer begins at 0.083 and the GOP of the slot at 16.016
       * shows its IDR at 16.099. Removing from 16.016 deleted the previous
       * GOP's last frames together with every B-frame referencing them, and
       * left a 125 ms hole that Chromium and WebKit both had to jump (WebKit
       * then stopped presenting frames for 45 s). Cut mid-fragment, the old
       * GOP's head stays in place until the new rung's fragment is appended
       * over it, and Media Source's overlap rules replace it from the new
       * IDR exactly: the previous GOP is untouched, nothing is left empty.
       * hls.js's own `nextLevel` cuts into the fragment for the same reason.
       */
      const now = videoElement.currentTime;
      const replaceable = [...bufferedMainFragments.values()]
        .filter(
          (fragment) =>
            fragment.level !== level &&
            // An upgrade only replaces media worse than what it brings.
            !(onlyLower && fragment.level > level) &&
            fragment.start < end,
        )
        .sort((left, right) => left.start - right.start);
      // Seamless: the first boundary the new rung can be fetched in time for.
      let takeover: { start: number; duration: number } | null =
        replaceable.find((fragment) => fragment.start >= horizon) ?? null;
      let mode: "seamless" | "deadline" = "seamless";
      if (chosenNow) {
        const deadline = now + SELECTED_DEADLINE_SECONDS * rate;
        const lead = now + SELECTED_MIN_LEAD_SECONDS * rate;
        if (!takeover || takeover.start > deadline) {
          // The deadline wins: the last boundary inside it, or failing that
          // the nearest one at all. A pause there is the accepted price.
          const inside = replaceable.filter(
            (fragment) => fragment.start >= lead && fragment.start <= deadline,
          );
          takeover =
            inside.at(-1) ??
            replaceable.find((fragment) => fragment.start >= lead) ??
            null;
          mode = "deadline";
        }
      }
      const cut =
        takeover === null
          ? null
          : takeover.start +
            Math.min(REPLACE_CUT_SECONDS, takeover.duration / 2);
      // Fragments of the chosen rung already buffered past the cut (fetched
      // since the pick) are kept: the cut stops where they begin.
      let cutEnd = Number.POSITIVE_INFINITY;
      if (cut !== null) {
        for (const fragment of bufferedMainFragments.values()) {
          if (fragment.level === level && fragment.start > cut) {
            cutEnd = Math.min(cutEnd, fragment.start);
          }
        }
      }
      if (cut === null) {
        // Nothing beyond the safety horizon to replace: the buffer is short
        // enough that the new rung arrives on its own almost as soon.
        abrRecord("replace-skipped", {
          reason: replacement.reason,
          level,
          marginS: Number(margin.toFixed(2)),
          bufferedAheadS: Number(bufferedAhead().toFixed(1)),
        });
        return;
      }

      abrRecord("replace", {
        reason: replacement.reason,
        mode,
        level,
        height: rung.height,
        takeoverAtS: Number(takeover!.start.toFixed(3)),
        cutAtS: Number(cut.toFixed(3)),
        keptAheadS: Number(
          (takeover!.start - videoElement.currentTime).toFixed(2),
        ),
        replacedS: Number((Math.min(end, cutEnd) - cut).toFixed(2)),
        marginS: Number(margin.toFixed(2)),
        bandwidthBps: Math.round(bandwidth),
      });
      for (const [key, fragment] of bufferedMainFragments) {
        if (fragment.start >= cut && fragment.start < cutEnd) {
          bufferedMainFragments.delete(key);
        }
      }
      hls.trigger(Hls.Events.BUFFER_FLUSHING, {
        startOffset: cut,
        endOffset: cutEnd,
        type: "video",
      });
      // See `holdForLateTakeover`: a takeover the deadline forced may be late.
      if (mode === "deadline") armLateTakeoverHold(level, takeover!.start);
      else clearLateTakeoverHold();
      // Under ManagedMediaSource the browser may have paused loading because
      // the buffer it saw was full; that buffer was just cut.
      if (!hls.bufferingEnabled) hls.resumeBuffering();
    };

    /** A manual pick: the engine's manual mode, then a safe replacement. */
    const lockLevel = (level: number) => {
      if (level === manualLevel) return;
      abrRecord("level", {
        reason: "locked",
        from: manualLevel ?? appliedLevel,
        to: level,
        height: hls.levels[level]?.height,
        estimateBps: Math.round(hls.bandwidthEstimate || 0),
        bufferedAheadS: Number(bufferedAhead().toFixed(1)),
      });
      manualLevel = level;
      levelDecidedAt = Date.now();
      // `loadLevel` changes what is fetched next and nothing else.
      hls.loadLevel = level;
      if (!anyMainFragmentBuffered) hls.startLevel = level;
      appliedLevel = level;
      replaceBufferAhead({
        level,
        retainSeconds: 0,
        onlyLower: false,
        reason: "manual",
      });
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

      // The opening rung's one chance at an immediate correction, consumed
      // whether or not it is needed so a later climb is paced as usual.
      const startupCorrection =
        startupCorrectionPending &&
        measuredFragments >= STARTUP_CONFIRMING_FRAGMENTS;
      if (startupCorrection) startupCorrectionPending = false;

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

      // See STARTUP_CONFIRMING_FRAGMENTS: the rung below was chosen from a
      // prior, and the link has now been measured to carry more. Only once a
      // fragment of that rung has landed, like every other climb.
      if (startupCorrection && !probing && appliedLevelMeasured) {
        upgradeCandidate = null;
        driveLevel(target, "start-correct-up");
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
      /*
       * See `appliedLevelMeasured`: the rung chosen last has to have been
       * fetched before the next one is earned. The hold keeps running, so the
       * climb fires on the first tick after that fragment lands.
       */
      if (!appliedLevelMeasured) return;
      if (now - upgradeCandidate.since >= UPSWITCH_HOLD_MS) {
        const climbTo = upgradeCandidate.level;
        const climbWasProbed = upgradeCandidate.probe;
        upgradeCandidate = null;
        if (climbWasProbed) probeHoldUntil = now + PROBE_GRACE_MS;
        driveLevel(climbTo, climbWasProbed ? "probe-up" : "up");
      }
    };

    const applyAdaptivePreference = (immediate = false) => {
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
         * Back to automatic. The rung is chosen here rather than by hls.js's
         * own ABR, so returning to Auto re-decides immediately instead of
         * handing the ladder to a controller that answers 144p regardless of
         * the link. Nothing already buffered is thrown away to get there:
         * `-1` on `loadLevel` is the engine's non-destructive way back to its
         * automatic mode, and the decision applies from the next fragment.
         */
        if (manualLevel !== null) {
          manualLevel = null;
          pendingReplacement = null;
          hls.loadLevel = -1;
        }
        upgradeCandidate = null;
        appliedLevel = null;
        evaluateAdaptiveTarget(true);
        /*
         * A mode the viewer just picked (Auto, Data Saver, Higher Quality) is
         * a request to see it, in either direction, like a manual rung: the
         * media buffered at other rungs is replaced from as near the play head
         * as the new rung can be fetched in time.
         */
        if (immediate && policyLevel !== null) {
          replaceBufferAhead({
            level: policyLevel,
            retainSeconds: 0,
            onlyLower: false,
            reason: "selected",
          });
        }
        return;
      }

      // Leaving automatic: forget the pending climb so a stale candidate
      // cannot fire a switch after the viewer has taken manual control.
      upgradeCandidate = null;

      /*
       * An explicit rung is a promise to the viewer, so it has to become the
       * picture within seconds, not after the whole forward buffer has played
       * out. `lockLevel` changes what is fetched next and then replaces only
       * the part of the buffer the new rung can be fetched in time to cover.
       * Writing `nextLevel` here used to do a cruder version of this: it also
       * discarded everything behind the play head, cut mid-fragment, and on
       * ManagedMediaSource left a hole the browser did not always ask to fill.
       */
      lockLevel(levelAtOrBelowClass(lockedHeight));
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
      // The play head has entered the new rung: how long the decision took to
      // become the picture is the switch's real cost to the viewer.
      abrRecord("switched", {
        level: data.level,
        height: level?.height,
        sinceDecisionMs: levelDecidedAt ? Date.now() - levelDecidedAt : null,
        currentTimeS: Number(videoElement.currentTime.toFixed(3)),
      });
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

    hls.on(Hls.Events.FRAG_LOADING, (_event, data) => {
      const fragment = asMainFragment(data);
      if (fragment) mainFragmentLoading = fragment;
    });

    hls.on(Hls.Events.FRAG_LOAD_EMERGENCY_ABORTED, (_event, data) => {
      const fragment = asMainFragment(data);
      if (fragment && mainFragmentLoading?.sn === fragment.sn) {
        mainFragmentLoading = null;
      }
      abrRecord("abandon", {
        level: fragment?.level,
        bufferedAheadS: Number(bufferedAhead().toFixed(1)),
        estimateBps: Math.round(hls.bandwidthEstimate || 0),
      });
    });

    hls.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.FRAG_BUFFERED, data });
      const fragment = asMainFragment(data);
      if (fragment) {
        anyMainFragmentBuffered = true;
        if (mainFragmentLoading?.sn === fragment.sn) mainFragmentLoading = null;
        bufferedMainFragments.set(String(fragment.sn), {
          level: fragment.level,
          start: fragment.start,
          end: fragment.start + fragment.duration,
          duration: fragment.duration,
        });
        if (fragment.level === appliedLevel) appliedLevelMeasured = true;
        const stats = (
          data as {
            frag?: {
              bitrateTest?: boolean;
              stats?: {
                loaded?: number;
                aborted?: boolean;
                loading?: { start?: number; first?: number; end?: number };
              };
            };
          }
        ).frag;
        if (!stats?.bitrateTest) {
          measuredFragments += 1;
          const loading = stats?.stats?.loading;
          if (loading) {
            deliveredThroughput.add({
              bytes: stats.stats?.loaded ?? 0,
              requestStartMs: loading.start ?? Number.NaN,
              firstByteMs: loading.first ?? Number.NaN,
              endMs: loading.end ?? Number.NaN,
              aborted: stats.stats?.aborted === true,
            });
            persistDeliveredThroughput();
          }
        }
        if (
          lateTakeover &&
          fragment.level === lateTakeover.level &&
          fragment.start <= lateTakeover.takeoverAt + 0.25 &&
          fragment.start + fragment.duration > lateTakeover.takeoverAt
        ) {
          clearLateTakeoverHold();
        }
      }
      // Re-checks the old-rung fetch it was waiting on, and waits again if
      // the engine has already started another one.
      if (pendingReplacement !== null) replaceBufferAhead(pendingReplacement);
      // Each buffered fragment is a fresh throughput sample, and the only
      // regular tick available while playback is steady. Forced while the
      // opening rung's correction is due, so it lands on the fragment that
      // earned it rather than up to a second later.
      evaluateAdaptiveTarget(
        startupCorrectionPending &&
          measuredFragments >= STARTUP_CONFIRMING_FRAGMENTS,
      );
    });

    hls.on(Hls.Events.BUFFER_FLUSHED, () => {
      // Fragments the engine evicted (back-buffer housekeeping, a seek's
      // flush) are no longer candidates for a replacement cut.
      const { buffered } = videoElement;
      for (const [key, fragment] of bufferedMainFragments) {
        const middle = (fragment.start + fragment.end) / 2;
        let held = false;
        for (let index = 0; index < buffered.length; index += 1) {
          if (
            buffered.start(index) <= middle &&
            buffered.end(index) >= middle
          ) {
            held = true;
            break;
          }
        }
        if (!held) bufferedMainFragments.delete(key);
      }
    });

    hls.on(Hls.Events.BUFFER_APPENDED, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.BUFFER_APPENDED, data });
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      options.onHlsEvent?.({ name: Hls.Events.ERROR, data });
      const failedFragment = asMainFragment(data);
      if (failedFragment && mainFragmentLoading?.sn === failedFragment.sn) {
        mainFragmentLoading = null;
      }

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
           * therefore held 1080p throughout, and with the engine in manual
           * mode its abandon rules never ran, so the stuck fragment was not
           * given up either: playback came back about a minute later.
           *
           * The engine now stays in automatic mode, where those rules run, and
           * a downward decision is handed to them (see `driveLevel`): the
           * fragment that is not arriving is abandoned for the cheaper rung's
           * much smaller one as soon as that is the faster way out. The ladder
           * is then climbed back in seconds if the stall was a blip.
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
        appliedLevelMeasured,
        manualLevel,
        pendingReplacement,
        engineAutoLevel: hls.autoLevelEnabled,
        playingLevel: hls.currentLevel,
        decodedWidth: videoElement.videoWidth,
        decodedHeight: videoElement.videoHeight,
        estimateBps: Math.round(hls.bandwidthEstimate || 0),
        opening,
        measuredFragments,
        deliveredBps: Math.round(deliveredThroughput.estimateBps() ?? 0),
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
        setQualityHeight: (
          height,
          maxHeight = null,
          mode = "auto",
          selection = {},
        ) => {
          lockedHeight = height;
          maximumHeight = maxHeight;
          adaptiveMode = mode;
          applyAdaptivePreference(selection.immediate === true);
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
        // The next title (often the next episode, moments later) opens from this.
        persistDeliveredThroughput(true);
        clearInterval(rungTicker);
        clearLateTakeoverHold();
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
