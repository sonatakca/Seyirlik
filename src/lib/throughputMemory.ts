/**
 * What this browser has actually measured Seyirlik's media server delivering,
 * kept between sessions so a playback can open at the rung the link carries
 * instead of at whatever a fixed guess happens to buy.
 *
 * Why remembered delivery and not the browser's link hints: the bottleneck on
 * this path is almost never the viewer's own connection. Media comes from a
 * home server's uplink, through a tunnel, often from a network-mounted drive,
 * so a viewer on gigabit fibre can still only be served what that chain
 * delivers. `navigator.connection.downlink` describes the viewer's side alone,
 * is rounded and capped at 10 Mbps by the spec, and Safari and Firefox do not
 * expose it at all. Throughput measured on real fragments from this very
 * origin is the only number that describes the thing the ladder is priced
 * against, so it is the primary prior; the link hint is used only in the one
 * direction it is trustworthy — a slow client link is an upper bound on what
 * can be delivered to it.
 *
 * The prior only ever decides the opening rung. hls.js's estimator is seeded
 * with it and discards it on the first measured fragment, so from then on
 * the ordinary policy in `videoSource.ts` is judging the link by what it
 * measures, exactly as before.
 */

/** The opening estimate when nothing is known — the value Seyirlik always used. */
export const UNKNOWN_LINK_ESTIMATE_BPS = 5_000_000;

const STORAGE_KEY = "seyirlik:delivery-throughput:v1";

/** Origins kept. A viewer reaches one or two media origins; this is a bound, not a cache policy. */
const MAX_REMEMBERED_ORIGINS = 4;

/**
 * How much a remembered measurement is trusted, by age.
 *
 * Fresh is the next episode or a title opened straight after another one —
 * the same link minutes later, trusted as measured. Within a day the network
 * is probably the same one but its load is not, so a quarter is held back.
 * Beyond that the measurement still says roughly what class of link this is,
 * worth half; after two weeks it says nothing worth acting on.
 *
 * Discounting rather than discarding matters because a wrong opening rung is
 * not symmetric: one too low costs a second of softer picture before the first
 * measurement climbs it, one too high costs a slow first frame. The policy
 * downgrades immediately on a measurement, so the cost of an optimistic prior
 * is bounded to the first fragment, and the discount keeps that fragment
 * small.
 */
const PRIOR_CONFIDENCE_TIERS: ReadonlyArray<{
  maxAgeMs: number;
  confidence: number;
}> = [
  { maxAgeMs: 30 * 60_000, confidence: 1 },
  { maxAgeMs: 24 * 60 * 60_000, confidence: 0.75 },
  { maxAgeMs: 14 * 24 * 60 * 60_000, confidence: 0.5 },
];

/**
 * A response faster to its first byte than this came from the browser's own
 * cache, not the network.
 *
 * Package segments are served `immutable` for a year, so a rewatch or a seek
 * back is answered from disk in a few milliseconds. Counting those as
 * throughput would remember a link measured in gigabits and open the next
 * title at the top rung on a link that cannot carry it. Every real request to
 * this server crosses at least a tunnel and a TLS edge, which is tens of
 * milliseconds.
 */
const MIN_NETWORK_TTFB_MS = 8;

/** Nothing reaching this server delivers faster than this; a sample above it was a cache read. */
const MAX_PLAUSIBLE_BPS = 1_000_000_000;

/** Below this the request's latency is the whole measurement and the size says nothing. */
const MIN_SAMPLE_BYTES = 32 * 1024;

/** Fragments one session's estimate is computed over: the recent link, not the session's history. */
const SESSION_WINDOW_SAMPLES = 16;

/** A session has to have measured this many fragments before it is allowed to teach the next one. */
const MIN_SESSION_SAMPLES = 4;

/** One media fragment's transfer, in the loader's own `performance.now()` clock. */
export interface FragmentTransfer {
  bytes: number;
  requestStartMs: number;
  firstByteMs: number;
  endMs: number;
  aborted?: boolean;
}

/**
 * The delivered rate of one fragment, in bits/second, or undefined when the
 * transfer is not evidence about the network.
 *
 * The rate deliberately includes the time to first byte. Fragments are
 * requested one after another, so every one of them pays the round trip; a
 * link with a quarter-second of latency sustains far less than its transfer
 * speed alone suggests, and that is exactly the difference between nominal
 * speed and what playback can actually rely on.
 */
export function deliveredThroughputSample(
  transfer: FragmentTransfer,
): number | undefined {
  if (transfer.aborted) return undefined;
  if (!(transfer.bytes >= MIN_SAMPLE_BYTES)) return undefined;
  const ttfb = transfer.firstByteMs - transfer.requestStartMs;
  const total = transfer.endMs - transfer.requestStartMs;
  if (!Number.isFinite(ttfb) || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  if (ttfb < MIN_NETWORK_TTFB_MS) return undefined;
  const bps = (transfer.bytes * 8) / (total / 1000);
  return bps > MAX_PLAUSIBLE_BPS ? undefined : bps;
}

/**
 * The session's own estimate of delivered throughput.
 *
 * Total bytes over total time across the recent window, which weights each
 * fragment by how much it says: a large fragment is a real measurement of the
 * link, a small one is mostly round trip. It is a byte-weighted harmonic mean,
 * and so conservative: one slow fragment pulls it down further than one fast
 * fragment lifts it.
 */
export function createThroughputAccumulator() {
  const window: Array<{ bytes: number; ms: number }> = [];
  return {
    add(transfer: FragmentTransfer): boolean {
      const bps = deliveredThroughputSample(transfer);
      if (bps === undefined) return false;
      window.push({
        bytes: transfer.bytes,
        ms: transfer.endMs - transfer.requestStartMs,
      });
      if (window.length > SESSION_WINDOW_SAMPLES) window.shift();
      return true;
    },
    get sampleCount(): number {
      return window.length;
    },
    /** Undefined until enough fragments have been measured to say anything. */
    estimateBps(): number | undefined {
      if (window.length < MIN_SESSION_SAMPLES) return undefined;
      const bytes = window.reduce((sum, sample) => sum + sample.bytes, 0);
      const ms = window.reduce((sum, sample) => sum + sample.ms, 0);
      return ms > 0 ? (bytes * 8) / (ms / 1000) : undefined;
    },
  };
}

interface RememberedThroughput {
  bps: number;
  at: number;
  /** The kind of network it was measured on, where the browser says. */
  network?: string;
}

interface NetworkInformationLike {
  type?: string;
  effectiveType?: string;
  downlink?: number;
}

function connection(): NetworkInformationLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: NetworkInformationLike })
    .connection;
}

/**
 * The kind of network this browser says it is on, when it says.
 *
 * Only Chromium answers, and on desktop usually only with an effective type.
 * It is enough to notice the change that matters most — a phone that left
 * Wi-Fi for cellular — so a measurement from one is not used on the other.
 * Where it is absent the age discount and the policy's immediate downgrade
 * are what protect a viewer whose network changed.
 */
export function currentNetworkSignature(
  info: NetworkInformationLike | undefined = connection(),
): string | undefined {
  if (!info) return undefined;
  const parts = [info.type, info.effectiveType].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join("/") : undefined;
}

export interface ThroughputEnvironment {
  now?: number;
  storage?: Storage;
  network?: NetworkInformationLike;
}

function defaultStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readAll(
  storage: Storage | undefined,
): Record<string, RememberedThroughput> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const entries: Record<string, RememberedThroughput> = {};
    for (const [origin, value] of Object.entries(parsed)) {
      const candidate = value as Partial<RememberedThroughput> | null;
      if (
        candidate &&
        typeof candidate.bps === "number" &&
        Number.isFinite(candidate.bps) &&
        candidate.bps > 0 &&
        candidate.bps <= MAX_PLAUSIBLE_BPS &&
        typeof candidate.at === "number" &&
        Number.isFinite(candidate.at)
      ) {
        entries[origin] = {
          bps: candidate.bps,
          at: candidate.at,
          ...(typeof candidate.network === "string"
            ? { network: candidate.network }
            : {}),
        };
      }
    }
    return entries;
  } catch {
    return {};
  }
}

/** Keep what this origin was just measured to deliver, for the next playback. */
export function rememberDeliveredThroughput(
  origin: string,
  bps: number,
  environment: ThroughputEnvironment = {},
): void {
  if (!(bps > 0) || !Number.isFinite(bps)) return;
  const storage = environment.storage ?? defaultStorage();
  if (!storage) return;
  const entries = readAll(storage);
  const network = currentNetworkSignature(environment.network ?? connection());
  entries[origin] = {
    bps: Math.min(bps, MAX_PLAUSIBLE_BPS),
    at: environment.now ?? Date.now(),
    ...(network ? { network } : {}),
  };
  const kept = Object.entries(entries)
    .sort(([, left], [, right]) => right.at - left.at)
    .slice(0, MAX_REMEMBERED_ORIGINS);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or refused: the next playback simply opens without a prior.
  }
}

export type OpeningEstimateSource = "history" | "link-hint" | "default";

export interface OpeningEstimate {
  bps: number;
  source: OpeningEstimateSource;
  /** Only for `history`: how old the measurement is and how much of it is trusted. */
  ageMs?: number;
  confidence?: number;
}

/**
 * The estimate a new playback from `origin` should open with.
 *
 * In order: a remembered measurement from this origin on this kind of
 * network, discounted by age; else the browser's link hint when it says the
 * link is slower than the default (the only direction it can be relied on —
 * see the module comment); else the default Seyirlik always opened with.
 */
export function openingBandwidthEstimate(
  origin: string | undefined,
  environment: ThroughputEnvironment = {},
): OpeningEstimate {
  const now = environment.now ?? Date.now();
  const network = environment.network ?? connection();

  if (origin) {
    const remembered = readAll(environment.storage ?? defaultStorage())[origin];
    const signature = currentNetworkSignature(network);
    const sameNetwork =
      !remembered?.network || !signature || remembered.network === signature;
    if (remembered && sameNetwork) {
      // A clock that moved backwards makes the entry look fresh; treat it as old.
      const ageMs = now - remembered.at;
      const tier =
        ageMs >= 0
          ? PRIOR_CONFIDENCE_TIERS.find((entry) => ageMs <= entry.maxAgeMs)
          : PRIOR_CONFIDENCE_TIERS.at(-1);
      if (tier) {
        return {
          bps: remembered.bps * tier.confidence,
          source: "history",
          ageMs,
          confidence: tier.confidence,
        };
      }
    }
  }

  const downlink = network?.downlink;
  if (
    typeof downlink === "number" &&
    Number.isFinite(downlink) &&
    downlink > 0 &&
    downlink * 1_000_000 < UNKNOWN_LINK_ESTIMATE_BPS
  ) {
    return { bps: downlink * 1_000_000, source: "link-hint" };
  }

  return { bps: UNKNOWN_LINK_ESTIMATE_BPS, source: "default" };
}

/** The origin a playback URL is delivered from, which is what a measurement describes. */
export function deliveryOrigin(playbackUrl: string): string | undefined {
  try {
    const base =
      typeof window === "undefined" ? undefined : window.location.href;
    return new URL(playbackUrl, base).origin;
  } catch {
    return undefined;
  }
}
