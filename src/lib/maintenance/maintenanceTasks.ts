/**
 * What a Library Maintenance task is, and what may honestly be said about it.
 *
 * Shared by the server that produces these records and the page that reads
 * them, so the two cannot drift into disagreeing about what a number means.
 *
 * The rule the whole file exists to enforce is that a figure is only shown
 * when the executor actually knows it. A scan that has walked four thousand
 * directories without knowing how many there are reports four thousand
 * directories, not a percentage; a probe pass that can count the pending rows
 * reports the fraction it genuinely has. Nothing here averages one phase into
 * another, and there is deliberately no function that turns a phase index into
 * an overall percentage — the phases of a library scan have no defensible
 * relative weight, and inventing one is how a bar reaches ninety per cent and
 * stays there for twenty minutes.
 */

/** What a measure counts. Presentation picks the word; this picks the thing. */
export const MAINTENANCE_UNITS = [
  "files",
  "titles",
  "items",
  "roots",
  "libraries",
  "moves",
  "renames",
  "directories",
  /**
   * Pictures sampled out of one title's video.
   *
   * The unit trickplay generation counts in: FFmpeg walks the file once and
   * emits one frame per sampling interval, so the frame it has just handed the
   * tiler is the only honest statement of how far into the source the decoder
   * has reached. Deliberately not "thumbnails" — that word already names cover
   * art in this product — and deliberately not "sheets", which move a hundred
   * frames at a time and would leave a bar at nought for most of an episode.
   */
  "frames",
] as const;
export type MaintenanceUnit = (typeof MAINTENANCE_UNITS)[number];

/**
 * How much of the current phase is done, in the only four shapes the
 * executors can actually produce.
 *
 * `exact` carries both halves of the fraction because a denominator is the
 * part that has to be earned. `provisionalTotal` marks the case where the
 * denominator is real but still moving — the probe pass counts the rows that
 * are pending right now, and a scan running beside it can add more — so the
 * page can say "of 742 so far" instead of implying a settled target.
 *
 * `counter` is the honest answer when there is a numerator and no denominator
 * at all. `indeterminate` is the honest answer when there is neither: a plan
 * being computed, a transaction being committed, a stage waiting on other
 * queued work.
 */
export type MaintenanceMeasure =
  | {
      kind: "exact";
      completed: number;
      total: number;
      unit: MaintenanceUnit;
      provisionalTotal?: boolean;
    }
  | { kind: "counter"; counted: number; unit: MaintenanceUnit }
  | { kind: "indeterminate" };

/**
 * The phases the maintenance executors really run.
 *
 * One flat vocabulary rather than a union per operation: a phase is a thing
 * the worker is doing, several operations do the same things, and a translated
 * label needs one key per phase rather than one per operation-and-phase pair.
 * Which phases an operation can be in is a property of that operation and is
 * asserted in its own handler, not encoded here.
 */
export const MAINTENANCE_PHASES = [
  /** Walking the library's folders. */
  "reading",
  /** Reconciling what was found against the catalogue. */
  "catalogue",
  /** Probing media files for their technical facts. */
  "analysing",
  /** Matching titles against the metadata provider. */
  "identifying",
  /** Writing NFO sidecars. */
  "nfo",
  /** Working out which files would move, and where. */
  "planning",
  /** Carrying out a folder-layout plan. */
  "moving",
  /** Carrying out a rename plan. */
  "naming",
  /** Choosing the titles that still need trickplay. */
  "selecting",
  /** Creating the child jobs that do the per-title work. */
  "enqueueing",
  /**
   * Generating one title's trickplay sheets.
   *
   * Named for the feature rather than for the pictures it happens to produce.
   * "Thumbnails" is a word this product already uses for cover art and for
   * provider images, and a queue row that said "Generating thumbnails" next to
   * a film was describing a different operation from the one it was running.
   */
  "trickplay",
  /** Standing by while work this stage depends on finishes. */
  "waiting",
] as const;
export type MaintenancePhase = (typeof MAINTENANCE_PHASES)[number];

/**
 * Every counter a maintenance executor can produce, by the name it produces
 * it under.
 *
 * An allowlist for the same reason `TASK_METRICS` is one: these numbers are
 * rendered with translated words beside them, and a page that displayed
 * whatever keys happened to be in a JSON blob would be reading the database's
 * mind rather than the executor's.
 */
export const MAINTENANCE_COUNTERS = [
  // Discovery
  "filesDiscovered",
  "filesSkipped",
  // Catalogue reconciliation
  "itemsCreated",
  "itemsUpdated",
  "itemsMarkedMissing",
  "itemsDeleted",
  "filesCreated",
  "filesChanged",
  "filesMarkedMissing",
  "filesDeleted",
  "probesQueued",
  // Probe
  "probed",
  "probeFailed",
  // Provider matching
  "matched",
  "ambiguous",
  "notFound",
  // NFO
  "nfoCreated",
  "nfoUpdated",
  "nfoUnchanged",
  "nfoSkippedConflict",
  "nfoSkippedNotApplicable",
  "nfoFailed",
  // Folder layout
  "planned",
  "moved",
  "movesSkipped",
  "movesFailed",
  // Renaming
  "renamed",
  "renamesSkipped",
  "renamesFailed",
  // Thumbnails
  "trickplayQueued",
  "trickplayPending",
  "spriteCount",
  // Intros and credits
  "segmentsQueued",
] as const;
export type MaintenanceCounter = (typeof MAINTENANCE_COUNTERS)[number];

export type MaintenanceCounters = Partial<Record<MaintenanceCounter, number>>;

/**
 * What the worker is working on at this instant.
 *
 * A name, never a path. The maintenance jobs run against somebody's media
 * volume and the existing task surface has always refused to carry filesystem
 * detail; a label that the allowlist turns down becomes `unnamed` rather than
 * being smuggled through.
 */
export interface MaintenanceSubject {
  label?: string;
  /** `S01E03`, when the thing being worked on is an episode. */
  code?: string;
  /** There is a current item, and it cannot be named safely. */
  unnamed?: true;
}

/**
 * One durable statement of what a maintenance job is doing.
 *
 * `revision` is what makes this safe to deliver out of order. It increases
 * once per report within an attempt, the database refuses a write whose
 * revision is not greater than the one already stored, and the page discards a
 * snapshot older than the one it is holding. Without it a reconnect that
 * replayed two updates in the wrong order would walk a counter backwards, and
 * a counter that goes backwards is worse than no counter at all.
 */
export interface MaintenanceProgress {
  revision: number;
  phase: MaintenancePhase;
  /**
   * Which phase of how many, when the operation runs a fixed sequence.
   *
   * Present so the page can say "3 of 5 phases"; deliberately never turned
   * into a percentage, because the phases are not the same size and nothing
   * here knows their relative cost.
   */
  phaseIndex?: number;
  phaseCount?: number;
  measure: MaintenanceMeasure;
  counters?: MaintenanceCounters;
  current?: MaintenanceSubject;
  /** When the executor produced this, ISO-8601. */
  at: string;
}

/** What a report gives the worker; the worker adds the revision and the time. */
export type MaintenanceProgressInput = Omit<
  MaintenanceProgress,
  "revision" | "at"
>;

/**
 * A single item the job could not do, kept beside the ones it could.
 *
 * The reason is a code rather than a sentence so the page can translate it and
 * so no server text ever reaches a screen verbatim.
 */
export const MAINTENANCE_FAILURE_REASONS = [
  "source-missing",
  "permission-denied",
  "destination-exists",
  "provider-failed",
  "unsupported",
  "filesystem-error",
  "database-error",
  "unknown",
] as const;
export type MaintenanceFailureReason =
  (typeof MAINTENANCE_FAILURE_REASONS)[number];

export interface MaintenanceItemFailure {
  phase: MaintenancePhase;
  reason: MaintenanceFailureReason;
  subject?: MaintenanceSubject;
}

/**
 * The lifecycle a maintenance task is in, derived from what the queue row
 * actually says.
 *
 * Four of these are the `jobs.status` values. The other two are readings of a
 * queued row that the status alone cannot distinguish and an operator very
 * much can: a row waiting out a retry backoff after a failed attempt, and a
 * row deliberately scheduled to look again later. Both are genuinely queued;
 * telling them apart from "next in line" is the difference between a queue
 * that explains itself and one that appears stuck.
 */
export type MaintenanceLifecycle =
  | "queued"
  | "scheduled"
  | "retry-waiting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export const MAINTENANCE_TERMINAL_LIFECYCLES: ReadonlySet<MaintenanceLifecycle> =
  new Set(["succeeded", "failed", "cancelled"]);

export function isConcludedLifecycle(lifecycle: MaintenanceLifecycle): boolean {
  return MAINTENANCE_TERMINAL_LIFECYCLES.has(lifecycle);
}

/**
 * The status a queue row can hold. Repeated here rather than imported so the
 * browser bundle does not pull in the server's queue module.
 */
export type MaintenanceStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** One maintenance task, exactly as the server is willing to describe it. */
export interface MaintenanceTaskDto {
  id: string;
  /** The queue job type, e.g. `library.scan`. */
  operation: string;
  status: MaintenanceStatus;
  /**
   * The run this task belongs to, when it is one segment of a multi-pass
   * operation such as "All in one". Segments of one run share it.
   */
  runId?: string;
  /** What the work is against. Absent when the operation is library-wide. */
  scope?: {
    kind: "library" | "media" | "all-libraries";
    label?: string;
    code?: string;
    unnamed?: true;
    deleted?: true;
    /** How many libraries an all-libraries operation covers. */
    libraries?: number;
  };
  /** Position in the waiting line, 1-based. Absent unless genuinely waiting. */
  queuePosition?: number;
  /** True when the server would accept a reorder for this row. */
  reorderable: boolean;
  attempts: number;
  maxAttempts: number;
  progress: MaintenanceProgress | null;
  /** Counters the finished job reported, and the failures it recorded. */
  result: {
    counters: MaintenanceCounters;
    failures: MaintenanceItemFailure[];
    /** More failures happened than the record keeps. */
    failuresTruncated?: true;
    /** A qualifier on an otherwise successful outcome. */
    outcome?: MaintenanceOutcome;
  } | null;
  /** A translatable code, never server prose. */
  errorCode: MaintenanceErrorCode | null;
  queuedAt: string;
  /** When the row becomes claimable. Later than now while waiting a backoff. */
  runAfter: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** When the last progress report landed. */
  progressAt: string | null;
}

/**
 * A qualifier on a job that finished, for the things "succeeded" does not say.
 *
 * None of these is a status. A job that renamed nothing because renaming is
 * switched off did succeed — it did exactly what the configuration allows —
 * and calling it a failure would send somebody looking for a fault that is not
 * there. Equally, a job that renamed nine hundred files and could not rename
 * three must not read the same as one that renamed nine hundred and three, so
 * `completed-with-failures` exists and is derived from the counters rather
 * than being a state a worker can set by hand.
 */
export const MAINTENANCE_OUTCOMES = [
  "completed-with-failures",
  "cancelled",
  "plan-only",
  "organize-disabled",
  "deferred-processing",
  "incomplete",
  "removals-suppressed",
  "nothing-to-do",
] as const;
export type MaintenanceOutcome = (typeof MAINTENANCE_OUTCOMES)[number];

export const MAINTENANCE_ERROR_CODES = [
  "library-deleted",
  "item-deleted",
  "provider-missing",
  "unavailable",
  "hdr-unsupported",
  "payload-invalid",
  "lease-expired",
  "source-gone",
  "file-missing",
  "access-denied",
  "volume-full",
  "unreadable",
  "unknown",
] as const;
export type MaintenanceErrorCode = (typeof MAINTENANCE_ERROR_CODES)[number];

/**
 * The lifecycle of a task, read from the row rather than guessed from it.
 *
 * `now` is a parameter so the reading is a pure function of its inputs: a
 * backoff is a comparison against the clock, and a component that re-renders
 * on a poll must get the same answer for the same data.
 */
export function lifecycleOf(
  task: Pick<MaintenanceTaskDto, "status" | "attempts" | "runAfter">,
  now: number,
): MaintenanceLifecycle {
  if (task.status !== "queued") return task.status;
  const runAfter = Date.parse(task.runAfter);
  const later = Number.isFinite(runAfter) && runAfter > now;
  /*
   * A retry is a queued row that has already been attempted, and the queue
   * gives it a backoff. Reading the attempt count first means a row still
   * inside its backoff after a failure is called a retry rather than merely
   * "scheduled", which is the more useful of the two truths.
   */
  if (task.attempts > 0) return later ? "retry-waiting" : "queued";
  return later ? "scheduled" : "queued";
}

export function isConcluded(task: Pick<MaintenanceTaskDto, "status">): boolean {
  return (
    task.status === "succeeded" ||
    task.status === "failed" ||
    task.status === "cancelled"
  );
}

/**
 * How far along the job is, in whichever of the four shapes is honest.
 *
 * There is no fifth branch that blends them. When the current phase measures
 * itself exactly the answer is that fraction and the percentage derived from
 * it; when it does not, the answer is the phase position, or a bare count, or
 * that nothing is known — and the page renders those differently on purpose.
 */
export type MaintenanceOverall =
  | {
      kind: "exact";
      completed: number;
      total: number;
      unit: MaintenanceUnit;
      provisionalTotal: boolean;
      /** Derived from `completed` and `total`, never from anything else. */
      percent: number;
    }
  | { kind: "phase"; phaseIndex: number; phaseCount: number }
  | { kind: "counter"; counted: number; unit: MaintenanceUnit }
  | { kind: "unknown" };

/**
 * The percentage a measured phase is allowed to show, on every surface.
 *
 * One function because there are two surfaces. The Library Maintenance page
 * rounded and the notification card floored, so the same reading of the same
 * row was published as 56% beside 55% — two numbers, both derived from
 * 199/356, disagreeing on screen at the same instant. Which of the two rules
 * was right mattered far less than that only one of them is applied.
 *
 * Rounded, because a bar that reads 55% at 55.9% is a bar that lags what it
 * describes. Held at 99 until the count actually reaches its total, because
 * "100%" on work still running is the one figure somebody would act on — the
 * reason the card floored in the first place, kept without the disagreement.
 */
export function measurePercent(completed: number, total: number): number {
  if (!(total > 0)) return 0;
  if (completed >= total) return 100;
  return Math.min(99, Math.max(0, Math.round((completed / total) * 100)));
}

export function describeOverall(
  progress: MaintenanceProgress | null,
): MaintenanceOverall {
  if (!progress) return { kind: "unknown" };
  const { measure } = progress;
  if (measure.kind === "exact" && measure.total > 0) {
    return {
      kind: "exact",
      completed: measure.completed,
      total: measure.total,
      unit: measure.unit,
      provisionalTotal: measure.provisionalTotal === true,
      percent: measurePercent(measure.completed, measure.total),
    };
  }
  if (
    typeof progress.phaseIndex === "number" &&
    typeof progress.phaseCount === "number" &&
    progress.phaseCount > 0
  ) {
    return {
      kind: "phase",
      phaseIndex: progress.phaseIndex,
      phaseCount: progress.phaseCount,
    };
  }
  if (measure.kind === "counter") {
    return { kind: "counter", counted: measure.counted, unit: measure.unit };
  }
  return { kind: "unknown" };
}

/**
 * The newer of two snapshots of the same attempt.
 *
 * Ordering by revision rather than by arrival is what makes a reconnect safe:
 * a page that has seen revision 40 and is then handed revision 31 by a slow
 * response keeps 40. Equal revisions keep the one already held, so a duplicate
 * delivery changes nothing.
 */
export function newerProgress(
  held: MaintenanceProgress | null,
  arriving: MaintenanceProgress | null,
): MaintenanceProgress | null {
  if (!arriving) return held;
  if (!held) return arriving;
  return arriving.revision > held.revision ? arriving : held;
}

const UNIT_SET: ReadonlySet<string> = new Set(MAINTENANCE_UNITS);
const PHASE_SET: ReadonlySet<string> = new Set(MAINTENANCE_PHASES);
const COUNTER_SET: ReadonlySet<string> = new Set(MAINTENANCE_COUNTERS);
const REASON_SET: ReadonlySet<string> = new Set(MAINTENANCE_FAILURE_REASONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parseUnit(value: unknown): MaintenanceUnit | null {
  return typeof value === "string" && UNIT_SET.has(value)
    ? (value as MaintenanceUnit)
    : null;
}

function parseMeasure(value: unknown): MaintenanceMeasure | null {
  if (!isRecord(value)) return null;
  if (value.kind === "indeterminate") return { kind: "indeterminate" };
  const unit = parseUnit(value.unit);
  if (!unit) return null;
  if (value.kind === "counter") {
    const counted = wholeNumber(value.counted);
    return counted === null ? null : { kind: "counter", counted, unit };
  }
  if (value.kind === "exact") {
    const completed = wholeNumber(value.completed);
    const total = wholeNumber(value.total);
    /*
     * A numerator past its denominator is not a fraction, it is a defect
     * upstream, and showing "812 of 742" would be worse than showing the count
     * alone. Degraded to a counter rather than dropped: the numerator is still
     * a real number of things that really happened.
     */
    if (completed === null || total === null) return null;
    if (completed > total) return { kind: "counter", counted: completed, unit };
    return {
      kind: "exact",
      completed,
      total,
      unit,
      ...(value.provisionalTotal === true ? { provisionalTotal: true } : {}),
    };
  }
  return null;
}

export function parseSubject(value: unknown): MaintenanceSubject | undefined {
  if (!isRecord(value)) return undefined;
  const subject: MaintenanceSubject = {};
  if (typeof value.label === "string" && value.label.length > 0) {
    subject.label = value.label;
  }
  if (typeof value.code === "string" && /^S\d{2}(E\d{2})?$/.test(value.code)) {
    subject.code = value.code;
  }
  if (value.unnamed === true) subject.unnamed = true;
  return Object.keys(subject).length > 0 ? subject : undefined;
}

function parseCounters(value: unknown): MaintenanceCounters | undefined {
  if (!isRecord(value)) return undefined;
  const counters: MaintenanceCounters = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!COUNTER_SET.has(key)) continue;
    const count = wholeNumber(raw);
    if (count === null) continue;
    counters[key as MaintenanceCounter] = count;
  }
  return Object.keys(counters).length > 0 ? counters : undefined;
}

/**
 * A stored snapshot, read back with every field checked.
 *
 * The column is JSONB written by a previous version of this process, so it is
 * exactly the place where a shape that no longer exists can still be found.
 * Anything unrecognisable becomes `null` — no progress — rather than a
 * half-populated record that renders as a number nobody wrote.
 */
export function parseMaintenanceProgress(
  value: unknown,
): MaintenanceProgress | null {
  if (!isRecord(value)) return null;
  const revision = wholeNumber(value.revision);
  const phase = typeof value.phase === "string" ? value.phase : "";
  const measure = parseMeasure(value.measure);
  if (revision === null || !PHASE_SET.has(phase) || !measure) return null;
  const at = typeof value.at === "string" ? value.at : "";
  if (!Number.isFinite(Date.parse(at))) return null;

  const phaseIndex = wholeNumber(value.phaseIndex);
  const phaseCount = wholeNumber(value.phaseCount);
  const counters = parseCounters(value.counters);
  const current = parseSubject(value.current);
  return {
    revision,
    phase: phase as MaintenancePhase,
    measure,
    at,
    /*
     * Both or neither. "Phase 3" with no count is not a position, and a page
     * given one would have to invent the other half to render it.
     */
    ...(phaseIndex !== null && phaseCount !== null && phaseCount > 0
      ? { phaseIndex, phaseCount }
      : {}),
    ...(counters ? { counters } : {}),
    ...(current ? { current } : {}),
  };
}

export function parseItemFailures(value: unknown): MaintenanceItemFailure[] {
  if (!Array.isArray(value)) return [];
  const failures: MaintenanceItemFailure[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const phase = typeof entry.phase === "string" ? entry.phase : "";
    const reason = typeof entry.reason === "string" ? entry.reason : "";
    if (!PHASE_SET.has(phase) || !REASON_SET.has(reason)) continue;
    const subject = parseSubject(entry.subject);
    failures.push({
      phase: phase as MaintenancePhase,
      reason: reason as MaintenanceFailureReason,
      ...(subject ? { subject } : {}),
    });
  }
  return failures;
}

/**
 * The counters that mean "this did not work", by the names the executors use.
 *
 * Used to decide whether a job that succeeded should still say so plainly. A
 * job with three failed moves out of nine hundred is a success with three
 * failures, and the qualifier is derived from these rather than being a flag
 * somebody has to remember to set.
 */
export const MAINTENANCE_FAILURE_COUNTERS: readonly MaintenanceCounter[] = [
  "probeFailed",
  "movesFailed",
  "renamesFailed",
  "nfoFailed",
];

export function countedFailures(counters: MaintenanceCounters): number {
  return MAINTENANCE_FAILURE_COUNTERS.reduce(
    (total, counter) => total + (counters[counter] ?? 0),
    0,
  );
}
