import type {
  MaintenanceProgress,
  MaintenanceUnit,
} from "../maintenance/maintenanceTasks";

/** Deliberately bounded presentation vocabulary shared by the API and UI. */
export const TASK_METRICS = {
  "acquisition.submit": [],
  "acquisition.reconcile": [
    "examined",
    "changed",
    "retried",
    "awaitingAlternative",
  ],
  "import.run": [],
  "import.reconcile": ["examined", "committed", "retried", "needsAttention"],
  "import.handoff": ["started", "refused"],
  "import.process": ["queued", "gaveUp"],
  "storage.collect": ["itemsRemoved", "megabytesFreed"],
  "subtitle.run": [],
  "subtitle.reconcile": ["examined"],
  "subtitle.auth-resume": [],
  "subtitle.sync": [],
  "library.scan": [
    "itemsCreated",
    "itemsUpdated",
    "itemsMarkedMissing",
    "itemsDeleted",
    "filesCreated",
    "filesChanged",
    "filesMarkedMissing",
    "filesDeleted",
    "probesQueued",
  ],
  "library.organize": ["planned", "moved", "movesSkipped", "movesFailed"],
  "library.rename": ["planned", "renamed", "renamesSkipped", "renamesFailed"],
  "library.maintenance": [],
  "trickplay.scan": ["trickplayQueued", "trickplayPending"],
  "media.probe": ["probed", "failed"],
  "metadata.scan": ["matched", "ambiguous", "notFound"],
  "metadata.refresh": [],
  "trickplay.generate": ["spriteCount"],
  "segments.scan": ["segmentsQueued", "filmsChecked"],
  "segments.detect": ["introsFound", "creditsFound", "chapterSegments"],
  "catalogue.enrich": ["titlesChecked", "rated", "inCollections"],
  "media.process": [],
  "nfo.export.item": [
    "created",
    "updated",
    "unchanged",
    "skippedConflict",
    "skippedNotApplicable",
    "failed",
  ],
  "nfo.export.library": [
    "itemsConsidered",
    "created",
    "updated",
    "unchanged",
    "skippedConflict",
    "skippedNotApplicable",
    "failed",
  ],
} as const;
/** The task types the API and UI both know by name. */
export type TaskType = keyof typeof TASK_METRICS;
export type TaskMetric =
  (typeof TASK_METRICS)[keyof typeof TASK_METRICS][number];
export type TaskStage =
  | "reading"
  | "organizing"
  | "naming"
  | "maintenance"
  | "catalogue"
  | "analysing"
  | "identifying"
  | "nfo"
  | "starting"
  | "selecting"
  | "trickplay"
  | "planning"
  /*
   * The three phases the maintenance executors report that the card had no
   * word for. They are spelled exactly as `MaintenancePhase` spells them, so
   * the phase a job writes into its queue row is the stage a card shows
   * without a translation table in between — one that could only ever drift.
   */
  | "moving"
  | "enqueueing"
  | "waiting"
  | "video"
  | "audio"
  | "subtitles"
  | "packaging"
  | "validating"
  | "publishing";
export interface TaskPresentation {
  subject?: {
    type: "library" | "media";
    /** What the work is about: a film, a series, a library. */
    label?: string;
    /**
     * Which part of it, in the shorthand a queue is read in: `S01E03`.
     *
     * Generated here rather than taken from a catalogue, so it is the one
     * piece of a title's identity that can always be shown — including on a
     * title whose own name the allowlist turned down.
     */
    code?: string;
    /**
     * The episode's own name, when the label is the show's.
     *
     * "Pilot" is not an identity when six shows have one, so this is never the
     * whole of what a card says about which title it means.
     */
    detail?: string;
    /** The label could not be shown: rejected by the allowlist, or absent. */
    unnamed?: boolean;
    deleted?: boolean;
  };
  stage?: TaskStage;
  /** False for heuristic stage checkpoints and producers without measured progress. */
  determinate: boolean;
  encoding?: { completedSeconds: number; totalSeconds: number };
  /**
   * How far through the phase named by `stage`, in [0,1].
   *
   * Every phase measures itself exactly — bytes assembled, profiles verified,
   * renditions published — and only the boundaries between them rest on an
   * estimate of relative cost. So this is the phase's own figure and never a
   * whole-job one: a card that showed a number for the picture and nothing at
   * all for the four phases after it went blank for the last quarter of every
   * encode.
   */
  phaseFraction?: number;
  /**
   * Seconds of work left, as the producer measured it.
   *
   * Only ever copied from a rate that is still happening — never divided out
   * here from an average, which is what makes a remaining time drift.
   */
  remainingSeconds?: number;
  /** Further titles waiting behind this one, when a card speaks for a queue. */
  queuedCount?: number;
  errorCode?: "deleted" | "provider" | "unavailable" | "hdr-unsupported";
  /**
   * The current phase's own fraction, in the things it counts.
   *
   * The unit is the executor's, not the card's: a walk counts directories, a
   * trickplay pass counts the frames it has sampled, and a card that could
   * only say "files" or "titles" had to drop every measure that was neither.
   */
  counts?: { completed: number; total: number; unit: MaintenanceUnit };
  metrics?: { metric: TaskMetric; value: number }[];
  outcome?:
    | "waiting-for-storage"
    /**
     * Held where it stands, by a person.
     *
     * A resting state rather than a result, and it lives here for the same
     * reason `waiting-for-storage` does: the queue row behind a suspended
     * encoder still says `running`, and a card that believes the queue reports
     * a paused job as working away with an unmeasurable rate.
     */
    | "paused"
    | "cancelled"
    | "matched"
    | "ambiguous"
    | "not-found"
    | "skipped"
    | "failed"
    | "not-generated"
    | "removals-suppressed"
    /** Writing to the media volume is switched off by configuration. */
    | "organize-disabled"
    /** The moves were computed and reported; nothing was moved. */
    | "plan-only"
    /** Stood down because an encode owns the paths it would have touched. */
    | "deferred-processing"
    /** Bounded out before it finished; the remaining work is still queued. */
    | "incomplete"
    | "damaged-output";
}
export function safeTaskLabel(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32) ||
    /[\\/\n\r]|[a-z]+:\/\/|[0-9a-f]{8}-[0-9a-f-]{27}|--\w/i.test(value)
  )
    return undefined;
  return value.trim();
}
/** `S01E03`, and nothing that merely resembles it. */
export function safeEpisodeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^S\d{2}(E\d{2})?$/.test(value)
    ? value
    : undefined;
}
export function resultMetrics(
  type: string,
  result: Record<string, unknown> | null,
) {
  const fields = TASK_METRICS[type as keyof typeof TASK_METRICS] ?? [];
  return fields.flatMap((metric) => {
    const value = result?.[metric];
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? [{ metric, value }]
      : [];
  });
}
/**
 * The executor's own structured report, in the card's vocabulary.
 *
 * The maintenance jobs already write a phase and a measure into their queue
 * row for the Library Maintenance page, and the cards read none of it — they
 * matched the human sentence beside it against a handful of regular
 * expressions, so a job whose sentence was not one of the four they knew said
 * "Progress not measurable yet" while the page beside it drew a bar.
 *
 * Only the `exact` shape becomes a fraction, and only when it is one: the
 * whole point of the shared vocabulary is that a counter without a denominator
 * stays a counter. Everything else here returns the phase alone, which is
 * still more than the sentence matcher could say.
 */
export function presentMaintenanceProgress(
  progress: MaintenanceProgress | null | undefined,
): Partial<TaskPresentation> | null {
  if (!progress) return null;
  // The phases are spelled as stages on purpose; this assignment is what makes
  // the compiler prove it, so a phase added later cannot reach a card unnamed.
  const stage: TaskStage = progress.phase;
  const { measure } = progress;
  if (
    measure.kind !== "exact" ||
    measure.total <= 0 ||
    measure.completed > measure.total
  ) {
    return { stage };
  }
  return {
    stage,
    counts: {
      completed: measure.completed,
      total: measure.total,
      unit: measure.unit,
    },
    phaseFraction: measure.completed / measure.total,
    determinate: true,
  };
}

/** Recognize only exact producer templates; never forward arbitrary server text. */
export function presentTask(
  type: string,
  message: string | null,
  result: Record<string, unknown> | null,
): TaskPresentation {
  const stages: Record<string, TaskStage> = {
    "Reading the library folders": "reading",
    "Organising the library folders": "organizing",
    "Naming the library files": "naming",
    "Running library maintenance": "maintenance",
    "Updating the catalogue": "catalogue",
    "Analysing media files": "analysing",
    "Identifying titles": "identifying",
    "Writing NFO metadata": "nfo",
    "Starting media processing": "starting",
    "Generating trickplay": "trickplay",
    "Scanning for missing trickplay": "selecting",
    "Looking for intros and credits": "selecting",
    "Detecting intros and credits": "analysing",
    "Fetching ratings and collections": "identifying",
  };
  const detail: TaskPresentation = {
    determinate: false,
    stage: stages[message ?? ""],
    metrics: resultMetrics(type, result),
  };
  const probe = /^Analysed (\d+) of (\d+) files$/.exec(message ?? "");
  const nfo = /^Exported metadata for (\d+) of (\d+) titles$/.exec(
    message ?? "",
  );
  const counts = probe ?? nfo;
  if (
    counts &&
    Number.isSafeInteger(Number(counts[2])) &&
    Number(counts[1]) <= Number(counts[2])
  ) {
    detail.stage = probe ? "analysing" : "nfo";
    detail.counts = {
      completed: Number(counts[1]),
      total: Number(counts[2]),
      unit: probe ? "files" : "titles",
    };
    // A library scan combines unrelated stages with arbitrary weights. Its
    // stage counts are real, but its overall fraction is not measurable work.
    detail.determinate =
      type === "media.probe" || type === "nfo.export.library";
  }
  const identified = /^Identified (\d+) titles(?:, (\d+) need review)?$/.exec(
    message ?? "",
  );
  if (identified && !result) {
    detail.stage = "identifying";
    detail.metrics = resultMetrics("metadata.scan", {
      matched: Number(identified[1]),
      ...(identified[2] ? { ambiguous: Number(identified[2]) } : {}),
    });
  }
  if (result?.cancelled === true || result?.status === "cancelled")
    detail.outcome = "cancelled";
  else if (type === "media.process" && result?.status === "waiting-for-storage")
    detail.outcome = "waiting-for-storage";
  else if (
    type === "metadata.refresh" &&
    ["matched", "ambiguous", "not-found", "skipped", "failed"].includes(
      String(result?.status),
    )
  )
    detail.outcome = result?.status as TaskPresentation["outcome"];
  else if (type === "trickplay.generate" && result?.generated === false)
    detail.outcome = "not-generated";
  else if (type === "library.scan" && result?.removalsSuppressed === true)
    detail.outcome = "removals-suppressed";
  /*
   * The four things a destructive maintenance job can honestly have done.
   * "Applied" is the absence of all of them and needs no word of its own; the
   * other three must never be read as "your files were renamed".
   */ else if (result?.disabled === true) detail.outcome = "organize-disabled";
  else if (result?.deferred === "processing-active")
    detail.outcome = "deferred-processing";
  else if (result?.planOnly === true) detail.outcome = "plan-only";
  else if (result?.incomplete === true) detail.outcome = "incomplete";
  if (type === "library.scan" && result) {
    for (const [key, subtype] of [
      ["probe", "media.probe"],
      ["metadata", "metadata.scan"],
      ["nfoExport", "nfo.export.library"],
    ]) {
      const nested = result[key!];
      if (nested && typeof nested === "object" && !Array.isArray(nested))
        detail.metrics?.push(
          ...resultMetrics(subtype!, nested as Record<string, unknown>),
        );
    }
  }
  return detail;
}
