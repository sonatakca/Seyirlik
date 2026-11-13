import {
  isQualityPreferenceMode,
  type AvailableQualityFile,
  type QualityPreferenceMode,
} from "../../renditions/contracts";

export interface QualityPreference {
  mode: QualityPreferenceMode;
  preferredHeight?: number;
  preferredQualityId?: string;
  preferOriginal?: boolean;
}

export interface FileQualitySelectionContext {
  playerHeight: number;
  devicePixelRatio?: number;
  saveData?: boolean;
  effectiveType?: string;
  downlinkMbps?: number;
  recentStallCount?: number;
}

const STORAGE_PREFIX = "seyirlik:quality-preference:";

function defaultStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId || "anonymous")}`;
}

function parsePreference(value: unknown): QualityPreference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = value as {
    mode?: unknown;
    preferredHeight?: unknown;
    preferredQualityId?: unknown;
    preferOriginal?: unknown;
  };
  if (!isQualityPreferenceMode(candidate.mode)) return undefined;
  // Automatic modes are durable intent, not a snapshot of the resolution that
  // intent happened to resolve to on one title. Discarding manual-only fields
  // here also cleans up preferences written by older clients.
  if (candidate.mode !== "advanced") {
    return { mode: candidate.mode };
  }
  const preferredHeight = candidate.preferredHeight;
  if (
    preferredHeight !== undefined &&
    (!Number.isInteger(preferredHeight) ||
      (preferredHeight as number) <= 0 ||
      (preferredHeight as number) > 4320)
  ) {
    return undefined;
  }
  if (
    candidate.preferredQualityId !== undefined &&
    (typeof candidate.preferredQualityId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.preferredQualityId))
  ) {
    return undefined;
  }
  return {
    mode: candidate.mode,
    ...(typeof preferredHeight === "number" ? { preferredHeight } : {}),
    ...(typeof candidate.preferredQualityId === "string"
      ? { preferredQualityId: candidate.preferredQualityId }
      : {}),
    ...(candidate.preferOriginal === true ? { preferOriginal: true } : {}),
  };
}

export function loadQualityPreference(
  userId: string,
  storage = defaultStorage(),
): QualityPreference {
  if (!storage) return { mode: "auto" };
  try {
    const raw = storage.getItem(storageKey(userId));
    if (!raw) return { mode: "auto" };
    return parsePreference(JSON.parse(raw)) ?? { mode: "auto" };
  } catch {
    return { mode: "auto" };
  }
}

export function saveQualityPreference(
  preference: QualityPreference,
  userId: string,
  storage = defaultStorage(),
): void {
  const validated = parsePreference(preference);
  if (!storage || !validated) return;
  try {
    storage.setItem(storageKey(userId), JSON.stringify(validated));
  } catch {
    // Playback remains functional when storage is unavailable or full.
  }
}

export function resolveManualHeight(
  intendedHeight: number,
  availableHeights: readonly number[],
): number | undefined {
  const heights = Array.from(
    new Set(
      availableHeights.filter(
        (height) => Number.isInteger(height) && height > 0,
      ),
    ),
  ).sort((left, right) => right - left);
  if (heights.length === 0) return undefined;
  return (
    heights.find((height) => height <= intendedHeight) ??
    heights[heights.length - 1]
  );
}

function sortedQualities(
  qualities: readonly AvailableQualityFile[],
): AvailableQualityFile[] {
  return [...qualities].sort(
    (left, right) =>
      left.height - right.height ||
      left.width - right.width ||
      Number(left.kind === "original") - Number(right.kind === "original"),
  );
}

export function isQualityAudioCompatible(
  quality: AvailableQualityFile,
  selectedAudioStreamIndex: number | undefined,
): boolean {
  return (
    quality.kind === "original" ||
    selectedAudioStreamIndex === undefined ||
    quality.sourceAudioStreamIndex === selectedAudioStreamIndex
  );
}

/** A rung, by the things any mode needs to reason about. */
interface RungLike {
  height: number;
  bitrate?: number;
}

/** The authoritative order used to bias every automatic quality decision. */
export const AUTO_QUALITY_LEVELS = [
  144, 240, 360, 480, 720, 1080, 1440, 2160,
] as const;

const LOW_DATA_MIN_HEIGHT = 144;
const LOW_DATA_MAX_HEIGHT = 1080;
const HIGHER_QUALITY_MIN_HEIGHT = 720;
const HIGHER_QUALITY_MAX_HEIGHT = 2160;

export type AutomaticQualityMode = Exclude<QualityPreferenceMode, "advanced">;

export interface AdaptiveQualityRequest {
  /** A manual Advanced selection is an exact rendition lock. */
  qualityHeight?: number;
  /** Biased automatic modes remain ABR, bounded by their derived rung. */
  maxHeight?: number;
}

/**
 * Translate a displayed mode rung into the server request native HLS needs.
 *
 * Safari exposes no level controller, so the master playlist is its only
 * quality-control surface. Auto must receive the complete ladder so native ABR
 * can use every rendition the device and link can sustain. Low Data and Higher
 * Quality receive a bias ceiling, while Advanced receives one exact rendition.
 */
export function adaptiveQualityRequestForMode(
  mode: QualityPreferenceMode,
  height: number | undefined,
): AdaptiveQualityRequest {
  if (mode === "auto" || height === undefined) return {};
  return mode === "advanced"
    ? { qualityHeight: height }
    : { maxHeight: height };
}

function clampHeight(height: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(height, minimum), maximum);
}

/**
 * Resolve the desired automatic-mode height before consulting a manifest.
 *
 * Low Data and Higher Quality move on the canonical ladder, then apply their
 * product bounds. This ordering is significant: 360p steps to 480p before the
 * Higher Quality floor raises it to 720p, while 2160p steps down to 1440p
 * before the Low Data ceiling lowers it to 1080p.
 */
export function resolvePlaybackQualityTarget(
  autoHeight: number,
  mode: AutomaticQualityMode,
): number {
  if (mode === "auto") return autoHeight;

  const normalizedAutoHeight =
    resolveManualHeight(autoHeight, AUTO_QUALITY_LEVELS) ??
    AUTO_QUALITY_LEVELS[0];
  const autoIndex = AUTO_QUALITY_LEVELS.indexOf(
    normalizedAutoHeight as (typeof AUTO_QUALITY_LEVELS)[number],
  );

  if (mode === "low-data") {
    const previous = AUTO_QUALITY_LEVELS[Math.max(0, autoIndex - 1)];
    return clampHeight(previous, LOW_DATA_MIN_HEIGHT, LOW_DATA_MAX_HEIGHT);
  }

  const next =
    AUTO_QUALITY_LEVELS[
      Math.min(AUTO_QUALITY_LEVELS.length - 1, autoIndex + 1)
    ];
  return clampHeight(
    next,
    HIGHER_QUALITY_MIN_HEIGHT,
    HIGHER_QUALITY_MAX_HEIGHT,
  );
}

/**
 * How much of the measured link a rung may claim.
 *
 * A stream that exactly fills the pipe has nothing left for the variance in
 * its own bitrate, so it stalls on the first busy scene. Two thirds leaves room
 * for a peak without giving away a whole rung.
 */
const BANDWIDTH_SAFETY_FRACTION = 2 / 3;

/** Each consecutive stall costs this much of the bandwidth budget. */
const STALL_PENALTY = 0.6;

/**
 * The opening bid when nothing has measured the link yet.
 *
 * Safari and Firefox expose no `navigator.connection`, and the engine has no
 * throughput estimate until it has pulled fragments, so without a ceiling the
 * anchor would open at the top rung on the strength of screen size alone.
 */
const UNMEASURED_ANCHOR_CEILING = 1080;

export interface ModeSelectionContext {
  /** Measured link throughput in bits/second, if anything has measured it. */
  bandwidthBps?: number;
  displayHeight?: number;
  devicePixelRatio?: number;
  saveData?: boolean;
  effectiveType?: string;
  recentStallCount?: number;
}

function ascendingRungs<T extends RungLike>(qualities: readonly T[]): T[] {
  return [...qualities].sort((left, right) => left.height - right.height);
}

/**
 * The rung the measured connection and the display jointly justify.
 *
 * This is the single anchor every mode is expressed against, so all three
 * agree about what the link can currently do instead of each deciding
 * separately from its own hardcoded budget.
 */
export function selectAnchorRung<T extends RungLike>(
  qualities: readonly T[],
  context: ModeSelectionContext = {},
): T | undefined {
  const ascending = ascendingRungs(qualities);
  if (ascending.length === 0) return undefined;

  // A stated preference, not a measurement, so it is honoured absolutely.
  if (
    context.saveData === true ||
    ["slow-2g", "2g"].includes(context.effectiveType ?? "")
  ) {
    return ascending[0];
  }

  /*
   * The smallest rung that still covers the display, not the largest that fits
   * inside it: a 600px-tall player is better served by a 720p rung scaled down
   * than by a 480p one scaled up.
   */
  const displayTarget =
    context.displayHeight && context.displayHeight > 0
      ? displayTargetHeight(context.displayHeight, context.devicePixelRatio)
      : Number.POSITIVE_INFINITY;
  const covering =
    ascending.find((quality) => quality.height >= displayTarget) ??
    ascending.at(-1)!;
  let eligible = ascending.slice(0, ascending.indexOf(covering) + 1);

  /*
   * Caps that exist for safety rather than for the screen, applied as true
   * ceilings.
   *
   * These must not be folded into the display target above: that target is
   * rounded *up* to the rung that covers it, so a ladder with no rung at the
   * cap would step straight over it — a ladder of 480/720/2160 answered 2160p
   * for an unmeasured link, which is precisely what the ceiling exists to
   * prevent.
   */
  const ceilings: number[] = [];
  if (context.effectiveType === "3g") ceilings.push(720);
  if (context.bandwidthBps === undefined) {
    ceilings.push(UNMEASURED_ANCHOR_CEILING);
  }
  if (ceilings.length > 0) {
    const cap = Math.min(...ceilings);
    const capped = eligible.filter((quality) => quality.height <= cap);
    // Every rung is above the cap, so the cheapest is the closest to honouring it.
    eligible = capped.length > 0 ? capped : [eligible[0]!];
  }

  if (context.bandwidthBps === undefined) return eligible.at(-1);

  const budgetBps =
    context.bandwidthBps *
    BANDWIDTH_SAFETY_FRACTION *
    STALL_PENALTY ** (context.recentStallCount ?? 0);

  // A rung with no measured bitrate is judged on height alone rather than
  // excluded, since an unknown cost is not evidence of an unaffordable one.
  const affordable = eligible.filter(
    (quality) => !quality.bitrate || quality.bitrate <= budgetBps,
  );
  return affordable.at(-1) ?? eligible[0];
}

/**
 * The three modes, as a bounded canonical step down, the anchor, and a bounded
 * canonical step up.
 *
 * Every mode used to carry its own hardcoded budget, so they disagreed about
 * the same connection: Low Data spent a flat 750 kbps whatever the link could
 * do, and Higher Resolution answered from screen size alone while ignoring
 * bandwidth entirely. Anchoring all three to one measured decision makes the
 * menu mean something a viewer can predict — the rung the connection actually
 * justifies, with a safer and a sharper canonical neighbour on either side.
 *
 * The step is ordinal on purpose. Resolving the desired target before looking
 * at the manifest keeps the meaning stable even when a particular source omits
 * a rung; only then does the normal downward fallback select a playable file.
 */
export function selectModeRungs<T extends RungLike>(
  qualities: readonly T[],
  context: ModeSelectionContext = {},
): { anchor: T | undefined; lowData: T | undefined; higher: T | undefined } {
  const ascending = ascendingRungs(qualities);
  const anchor = selectAnchorRung(ascending, context);
  if (!anchor) {
    return { anchor: undefined, lowData: undefined, higher: undefined };
  }
  return selectModeRungsFromAutoHeight(ascending, anchor.height);
}

/** Derive the two biased modes from an Auto rung the engine actually chose. */
export function selectModeRungsFromAutoHeight<T extends RungLike>(
  qualities: readonly T[],
  autoHeight: number,
): { anchor: T | undefined; lowData: T | undefined; higher: T | undefined } {
  const ascending = ascendingRungs(qualities);
  if (ascending.length === 0) {
    return { anchor: undefined, lowData: undefined, higher: undefined };
  }
  const resolveAvailableRung = (targetHeight: number): T =>
    [...ascending]
      .reverse()
      .find((quality) => quality.height <= targetHeight) ?? ascending[0];
  const anchor = resolveAvailableRung(autoHeight);
  return {
    anchor,
    // Desired targets come from the canonical ladder. The manifest layer then
    // uses its established safe fallback: nearest available rung at or below
    // the target, or the source's lowest rung when every rendition is taller.
    lowData: resolveAvailableRung(
      resolvePlaybackQualityTarget(anchor.height, "low-data"),
    ),
    higher: resolveAvailableRung(
      resolvePlaybackQualityTarget(anchor.height, "higher-resolution"),
    ),
  };
}

/**
 * The canonical rung class a decoded frame belongs to.
 *
 * A rung is named by its class (720p) while the frame it produces is whatever
 * the source's shape gives — a 2.39:1 master's "720p" rung is 1280x536, and
 * its "2160p" rung is 3840x1608. Matching on frame height alone therefore
 * files every letterboxed rung one or two classes too low, which is how a
 * ladder of cinema heights turns "one step above Auto" into "the rung Auto
 * already chose".
 *
 * Width recovers the class for letterboxed content and height recovers it for
 * pillarboxed content, so the larger of the two is the one that reflects the
 * class the encoder meant. The result is snapped to the canonical ladder so
 * every downstream comparison happens in the same vocabulary.
 */
export function canonicalRungClass(width: number, height: number): number {
  const fromWidth = width > 0 ? (width * 9) / 16 : 0;
  const candidate = Math.max(fromWidth, height > 0 ? height : 0);
  if (!(candidate > 0)) return height;
  return AUTO_QUALITY_LEVELS.reduce((best, level) =>
    Math.abs(level - candidate) < Math.abs(best - candidate) ? level : best,
  );
}

/**
 * The one rung an automatic mode wants right now.
 *
 * Every automatic mode resolves through here so Auto, Low Data and Higher
 * Quality cannot disagree about the same connection: they are the anchor and
 * its two bounded canonical neighbours, nothing more. Transport belongs to the
 * caller — this answers only "which rung", so the native and hls.js paths can
 * share one policy instead of each growing its own.
 *
 * Higher Quality waives Auto's safety margin, not the measurement: its step up
 * is taken only when the measured link carries that rung's average bitrate,
 * and otherwise it settles on the best rung between Auto's and the step that
 * does fit — never below Auto's. A step the link cannot carry is not "more
 * data for a sharper picture"; measured on production (12 Mbps, House of the
 * Dragon), Higher Quality's 1440p (10.2 Mbps average) drained the buffer and
 * the engine's emergency rescues showed 144p for fifty seconds.
 */
export function selectAdaptiveTargetRung<T extends RungLike>(
  qualities: readonly T[],
  mode: AutomaticQualityMode,
  context: ModeSelectionContext = {},
): T | undefined {
  const { anchor, lowData, higher } = selectModeRungs(qualities, context);
  if (mode === "low-data") return lowData ?? anchor;
  if (mode === "higher-resolution") {
    const wanted = higher ?? anchor;
    const link = context.bandwidthBps;
    if (!wanted || !anchor || link === undefined) return wanted;
    const fits = (rung: T) => !rung.bitrate || rung.bitrate <= link;
    if (fits(wanted)) return wanted;
    return (
      ascendingRungs(qualities)
        .filter(
          (rung) =>
            rung.height > anchor.height &&
            rung.height < wanted.height &&
            fits(rung),
        )
        .at(-1) ?? anchor
    );
  }
  return anchor;
}

export function selectLowDataRung<T extends RungLike>(
  qualities: readonly T[],
  context: ModeSelectionContext = {},
): T | undefined {
  return selectModeRungs(qualities, context).lowData;
}

export function selectHigherResolutionRung<T extends RungLike>(
  qualities: readonly T[],
  context: ModeSelectionContext = {},
): T | undefined {
  return selectModeRungs(qualities, context).higher;
}

export function selectLowDataQuality(
  qualities: readonly AvailableQualityFile[],
): AvailableQualityFile | undefined {
  return selectLowDataRung(qualities);
}

export function selectHigherResolutionQuality(
  qualities: readonly AvailableQualityFile[],
  displayHeight?: number,
  devicePixelRatio?: number,
): AvailableQualityFile | undefined {
  return selectHigherResolutionRung(qualities, {
    ...(displayHeight === undefined ? {} : { displayHeight }),
    ...(devicePixelRatio === undefined ? {} : { devicePixelRatio }),
  });
}

function fileModeSelectionContext(
  context: FileQualitySelectionContext,
): ModeSelectionContext {
  return {
    displayHeight: context.playerHeight,
    ...(context.devicePixelRatio === undefined
      ? {}
      : { devicePixelRatio: context.devicePixelRatio }),
    ...(context.saveData === undefined ? {} : { saveData: context.saveData }),
    ...(context.effectiveType === undefined
      ? {}
      : { effectiveType: context.effectiveType }),
    ...(context.downlinkMbps === undefined
      ? {}
      : { bandwidthBps: context.downlinkMbps * 1_000_000 }),
    ...(context.recentStallCount === undefined
      ? {}
      : { recentStallCount: context.recentStallCount }),
  };
}

/** Resolve all complete-file modes from the same current Auto recommendation. */
export function selectFileModeQualities(
  qualities: readonly AvailableQualityFile[],
  context: FileQualitySelectionContext,
): ReturnType<typeof selectModeRungs<AvailableQualityFile>> {
  return selectModeRungs(
    sortedQualities(qualities),
    fileModeSelectionContext(context),
  );
}

export function selectManualQuality(
  qualities: readonly AvailableQualityFile[],
  preference: QualityPreference,
): AvailableQualityFile | undefined {
  if (preference.preferredQualityId) {
    const exact = qualities.find(
      (quality) => quality.id === preference.preferredQualityId,
    );
    if (exact) return exact;
  }
  if (preference.preferOriginal) {
    const original = qualities.find((quality) => quality.kind === "original");
    if (original) return original;
  }
  // A different title rarely carries the exact same generated file, so the saved
  // height is resolved down to the nearest available quality instead of being
  // discarded. `resolveManualHeight` never resolves upwards.
  if (preference.preferredHeight) {
    const resolvedHeight = resolveManualHeight(
      preference.preferredHeight,
      qualities.map((quality) => quality.height),
    );
    return qualities.find((quality) => quality.height === resolvedHeight);
  }
  return undefined;
}

/** Resolution the display can actually make use of, with a sane pixel-ratio cap. */
export function displayTargetHeight(
  playerHeight: number,
  devicePixelRatio: number | undefined,
): number {
  const pixelRatio = Math.min(Math.max(devicePixelRatio ?? 1, 1), 2);
  return Math.max(1, playerHeight) * pixelRatio;
}

/** The rung Auto should be on, from the shared anchor. */
export function selectAutoQuality(
  qualities: readonly AvailableQualityFile[],
  context: FileQualitySelectionContext,
): AvailableQualityFile | undefined {
  /*
   * The complete-file path still describes its connection with
   * `navigator.connection`, so its Mbps hint is converted to the bits/second
   * the shared anchor speaks. Both paths then answer from one rule, which is
   * the point: Auto must not mean two different things depending on whether a
   * title happens to be packaged adaptively.
   */
  return selectFileModeQualities(qualities, context).anchor;
}

export function shouldSwitchFileQuality({
  currentHeight,
  candidateHeight,
  now,
  lastSwitchAt,
  recentStallCount = 0,
  cooldownMs = 30_000,
}: {
  currentHeight: number;
  candidateHeight: number;
  now: number;
  lastSwitchAt: number;
  recentStallCount?: number;
  cooldownMs?: number;
}): boolean {
  if (currentHeight === candidateHeight) return false;
  const isStallDowngrade =
    recentStallCount >= 2 && candidateHeight < currentHeight;
  if (!isStallDowngrade && now - lastSwitchAt < cooldownMs) return false;
  const ratio =
    Math.max(currentHeight, candidateHeight) /
    Math.max(1, Math.min(currentHeight, candidateHeight));
  return ratio >= 1.3;
}
