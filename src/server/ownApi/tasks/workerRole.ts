import { ACQUISITION_JOB_TYPES } from "../acquisition/acquisitionJobs";
import { IMPORT_JOB_TYPES } from "../imports/importJobs";
import { GARBAGE_JOB_TYPES } from "../maintenance/garbageCollector";
import { MEDIA_LANE_JOB_TYPES, TRICKPLAY_LANE_JOB_TYPES } from "./jobHandlers";
import type { WorkerLane } from "./worker";

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
];

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
): WorkerLane[] {
  const mediaLane: WorkerLane = {
    name: "media",
    jobTypes: [...MEDIA_LANE_JOB_TYPES],
    concurrency: 1,
  };
  const trickplayLane: WorkerLane = {
    name: "trickplay",
    jobTypes: [...TRICKPLAY_LANE_JOB_TYPES],
    concurrency: 1,
  };
  if (role === "heavy") {
    const laned = new Set([
      ...MEDIA_LANE_JOB_TYPES,
      ...TRICKPLAY_LANE_JOB_TYPES,
    ]);
    return [
      mediaLane,
      trickplayLane,
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
    {
      name: "library",
      excludeJobTypes: [
        ...MEDIA_LANE_JOB_TYPES,
        ...TRICKPLAY_LANE_JOB_TYPES,
        ...disabledJobTypes,
      ],
      concurrency: 3,
    },
  ];
}
