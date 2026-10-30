import { ACQUISITION_JOB_TYPES } from "../acquisition/acquisitionJobs";
import { IMPORT_JOB_TYPES } from "../imports/importJobs";
import { GARBAGE_JOB_TYPES } from "../maintenance/garbageCollector";
import { MEDIA_LANE_JOB_TYPES, TRICKPLAY_LANE_JOB_TYPES } from "./jobHandlers";
import type { WorkerLane } from "./worker";
import { SUBTITLE_ANALYSIS_JOB_TYPE } from "../subtitles/subtitleAnalysis";

/**
 * Which half of the queue a worker process takes.
 *
 * One machine used to do everything. Once the media volume became a Google
 * Drive mount the always-on server could no longer download or encode, and a
 * second machine that is switched on by hand took that work over. Both claim
 * from the same PostgreSQL queue, so the split is a claim filter and nothing
 * else: a job waits in the queue until a worker that takes its type is running.
 *
 * - `all`: everything, as before. The default.
 * - `light`: what the site needs while the heavy machine is off — library
 *   scans, probes, TMDB metadata and artwork, subtitles, NFO. It never claims
 *   a heavy job, and it leaves processing bookkeeping (interrupted-encode
 *   recovery, storage-loss pauses) to the worker that runs the encoder.
 * - `heavy`: downloads, imports, encodes, trickplay sheets, intro detection
 *   and the scratch/download clean-up that belongs to the machine doing them.
 */
export type WorkerRole = "all" | "light" | "heavy";

/**
 * Work that holds a GPU, a download client or a local scratch disk.
 *
 * Every type outside this list is light, including any type added later, so a
 * new job runs on the always-on server unless somebody decides otherwise.
 * Library scans stay light on purpose: the server's mount only shows a file
 * once it has finished uploading, so its scan is the one that can say a title
 * is really on Drive.
 */
export const HEAVY_JOB_TYPES: readonly string[] = [
  ...MEDIA_LANE_JOB_TYPES,
  ...TRICKPLAY_LANE_JOB_TYPES,
  ...Object.values(ACQUISITION_JOB_TYPES),
  ...Object.values(IMPORT_JOB_TYPES),
  GARBAGE_JOB_TYPES.collect,
  SUBTITLE_ANALYSIS_JOB_TYPE,
];

/**
 * Speech recognition for subtitle timing: minutes of a GPU per episode.
 *
 * Its own lane at one job at a time, so two transcriptions never hold two
 * models in the laptop's eight gigabytes of video memory, and a backlog of
 * them never waits behind (or holds up) the downloads lane.
 */
export const ANALYSIS_LANE_JOB_TYPES: readonly string[] = [
  SUBTITLE_ANALYSIS_JOB_TYPE,
];

/** Work that can hold a worker for hours: an encode, a trickplay sheet. */
export const LONG_JOB_TYPES: readonly string[] = [
  ...MEDIA_LANE_JOB_TYPES,
  ...TRICKPLAY_LANE_JOB_TYPES,
];

/**
 * Work only the process that owns the encoder can do, because it goes through
 * that process's enqueuer and scratch: queueing imported files for processing,
 * and collecting the scratch the encoder leaves behind.
 */
const ENCODER_OWNED_JOB_TYPES: readonly string[] = [
  IMPORT_JOB_TYPES.process,
  GARBAGE_JOB_TYPES.collect,
];

/**
 * A bridge worker's lanes (`releaseBridge.ts`): the role's lanes without the
 * long work and without what only the encoder's owner may run. A bridge starts
 * while the old release still holds an encode, so it must never claim one, and
 * it owns no encoder to queue through.
 */
function bridgeLanes(lanes: readonly WorkerLane[]): WorkerLane[] {
  // Transcription holds the GPU the old release's encode is using.
  const left = new Set([
    ...LONG_JOB_TYPES,
    ...ENCODER_OWNED_JOB_TYPES,
    ...ANALYSIS_LANE_JOB_TYPES,
  ]);
  return lanes.flatMap((lane): WorkerLane[] => {
    if (lane.jobTypes) {
      const jobTypes = lane.jobTypes.filter((type) => !left.has(type));
      return jobTypes.length > 0 ? [{ ...lane, jobTypes }] : [];
    }
    return [
      {
        ...lane,
        excludeJobTypes: [...(lane.excludeJobTypes ?? []), ...left],
      },
    ];
  });
}

/**
 * How many processing jobs the media lane holds at once.
 *
 * Not how many encode: the encoder is one slot (`encoderSlot.ts`) that a job
 * takes only for its video epochs and its rate probe's sample encodes. The
 * rest — probing, VMAF scoring, audio, assembly, verification, publication —
 * is CPU and disk, and with three jobs the next title plans and the last one
 * verifies while this one encodes. More would mostly add jobs waiting for the
 * slot while holding their place in the queue.
 */
export const DEFAULT_MEDIA_CONCURRENCY = 3;

/** `SEYIRLIK_MEDIA_CONCURRENCY`; 1 restores one title at a time. */
export function parseMediaConcurrency(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return DEFAULT_MEDIA_CONCURRENCY;
  const count = Number(text);
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    throw new Error(
      "SEYIRLIK_MEDIA_CONCURRENCY must be a whole number from 1 to 8.",
    );
  }
  return count;
}

export function parseWorkerRole(value: string | undefined): WorkerRole {
  const role = value?.trim().toLowerCase() || "all";
  if (role === "all" || role === "light" || role === "heavy") return role;
  throw new Error("SEYIRLIK_WORKER_ROLE must be all, light or heavy.");
}

/** Whether this process owns the encoder and so the jobs that use it. */
export function ownsProcessing(runWorker: boolean, role: WorkerRole): boolean {
  return runWorker && role !== "light";
}

/** Whether this process runs the library side of the queue. */
export function ownsLibrary(runWorker: boolean, role: WorkerRole): boolean {
  return runWorker && role !== "heavy";
}

export function workerLanes(
  role: WorkerRole,
  disabledJobTypes: readonly string[],
  {
    bridge = false,
    mediaConcurrency = DEFAULT_MEDIA_CONCURRENCY,
  }: { bridge?: boolean; mediaConcurrency?: number } = {},
): WorkerLane[] {
  const lanes = roleLanes(role, disabledJobTypes, mediaConcurrency);
  return bridge ? bridgeLanes(lanes) : lanes;
}

function roleLanes(
  role: WorkerRole,
  disabledJobTypes: readonly string[],
  mediaConcurrency: number,
): WorkerLane[] {
  const mediaLane: WorkerLane = {
    name: "media",
    jobTypes: [...MEDIA_LANE_JOB_TYPES],
    concurrency: mediaConcurrency,
  };
  const trickplayLane: WorkerLane = {
    name: "trickplay",
    jobTypes: [...TRICKPLAY_LANE_JOB_TYPES],
    concurrency: 1,
  };
  const analysisTypes = ANALYSIS_LANE_JOB_TYPES.filter(
    (type) => !disabledJobTypes.includes(type),
  );
  const analysisLane: WorkerLane[] =
    analysisTypes.length > 0
      ? [{ name: "analysis", jobTypes: analysisTypes, concurrency: 1 }]
      : [];
  if (role === "heavy") {
    const laned = new Set([
      ...MEDIA_LANE_JOB_TYPES,
      ...TRICKPLAY_LANE_JOB_TYPES,
      ...ANALYSIS_LANE_JOB_TYPES,
      ...disabledJobTypes,
    ]);
    return [
      mediaLane,
      trickplayLane,
      ...analysisLane,
      {
        name: "downloads",
        jobTypes: HEAVY_JOB_TYPES.filter((type) => !laned.has(type)),
        concurrency: 3,
      },
    ];
  }
  if (role === "light") {
    return [
      {
        name: "library",
        excludeJobTypes: [...HEAVY_JOB_TYPES, ...disabledJobTypes],
        concurrency: 3,
      },
    ];
  }
  return [
    mediaLane,
    trickplayLane,
    ...analysisLane,
    {
      name: "library",
      excludeJobTypes: [
        ...MEDIA_LANE_JOB_TYPES,
        ...TRICKPLAY_LANE_JOB_TYPES,
        ...ANALYSIS_LANE_JOB_TYPES,
        ...disabledJobTypes,
      ],
      concurrency: 3,
    },
  ];
}
