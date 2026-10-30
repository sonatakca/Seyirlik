import { describe, expect, it } from "vitest";
import { ACQUISITION_JOB_TYPES } from "../acquisition/acquisitionJobs";
import { IMPORT_JOB_TYPES } from "../imports/importJobs";
import { GARBAGE_JOB_TYPES } from "../maintenance/garbageCollector";
import { SUBTITLE_JOB_TYPES } from "../subtitles/subtitleJobs";
import { JOB_TYPES } from "./jobHandlers";
import { SUBTITLE_ANALYSIS_JOB_TYPE } from "../subtitles/subtitleAnalysis";
import {
  ANALYSIS_LANE_JOB_TYPES,
  DEFAULT_MEDIA_CONCURRENCY,
  HEAVY_JOB_TYPES,
  LONG_JOB_TYPES,
  ownsLibrary,
  ownsProcessing,
  parseMediaConcurrency,
  parseWorkerRole,
  workerLanes,
} from "./workerRole";
import type { WorkerLane } from "./worker";

/** Which lane of these would claim a job of this type, if any. */
function claimingLane(lanes: WorkerLane[], jobType: string): string | null {
  for (const lane of lanes) {
    if (lane.jobTypes && !lane.jobTypes.includes(jobType)) continue;
    if (lane.excludeJobTypes?.includes(jobType)) continue;
    return lane.name;
  }
  return null;
}

const EVERY_TYPE = [
  ...Object.values(JOB_TYPES),
  ...Object.values(ACQUISITION_JOB_TYPES),
  ...Object.values(IMPORT_JOB_TYPES),
  ...Object.values(SUBTITLE_JOB_TYPES),
  GARBAGE_JOB_TYPES.collect,
  SUBTITLE_ANALYSIS_JOB_TYPE,
  "nfo.export",
  "some.type-added-later",
];

describe("worker roles", () => {
  it("defaults to all and refuses an unknown role", () => {
    expect(parseWorkerRole(undefined)).toBe("all");
    expect(parseWorkerRole(" Light ")).toBe("light");
    expect(parseWorkerRole("heavy")).toBe("heavy");
    expect(() => parseWorkerRole("gpu")).toThrow(/SEYIRLIK_WORKER_ROLE/);
  });

  it("splits every job type between light and heavy exactly once", () => {
    const light = workerLanes("light", []);
    const heavy = workerLanes("heavy", []);
    for (const type of EVERY_TYPE) {
      const claimedByLight = claimingLane(light, type) !== null;
      const claimedByHeavy = claimingLane(heavy, type) !== null;
      expect({ type, both: claimedByLight && claimedByHeavy }).toEqual({
        type,
        both: false,
      });
      expect({ type, either: claimedByLight || claimedByHeavy }).toEqual({
        type,
        either: true,
      });
    }
  });

  it("keeps what the site needs on the light side", () => {
    const light = workerLanes("light", []);
    for (const type of [
      JOB_TYPES.libraryScan,
      JOB_TYPES.mediaProbe,
      JOB_TYPES.metadataRefresh,
      JOB_TYPES.metadataScan,
      SUBTITLE_JOB_TYPES.run,
      SUBTITLE_JOB_TYPES.sync,
      "some.type-added-later",
    ]) {
      expect({ type, lane: claimingLane(light, type) }).toEqual({
        type,
        lane: "library",
      });
    }
  });

  it("gives downloads, imports, encodes and clean-up to the heavy side", () => {
    const heavy = workerLanes("heavy", []);
    expect(claimingLane(heavy, JOB_TYPES.mediaProcess)).toBe("media");
    expect(claimingLane(heavy, JOB_TYPES.trickplayGenerate)).toBe("trickplay");
    expect(claimingLane(heavy, JOB_TYPES.segmentsDetect)).toBe("trickplay");
    for (const type of [
      ACQUISITION_JOB_TYPES.submit,
      IMPORT_JOB_TYPES.run,
      GARBAGE_JOB_TYPES.collect,
    ]) {
      expect(claimingLane(heavy, type)).toBe("downloads");
    }
    expect(HEAVY_JOB_TYPES).not.toContain(JOB_TYPES.libraryScan);
  });

  it("keeps the lanes a single machine always had", () => {
    // Without a recogniser declared, as every host was before transcription.
    const all = workerLanes("all", [
      SUBTITLE_JOB_TYPES.run,
      SUBTITLE_ANALYSIS_JOB_TYPE,
    ]);
    expect(all.map((lane) => lane.name)).toEqual([
      "media",
      "trickplay",
      "library",
    ]);
    expect(claimingLane(all, IMPORT_JOB_TYPES.run)).toBe("library");
    expect(claimingLane(all, SUBTITLE_JOB_TYPES.run)).toBeNull();
  });

  it("runs a few titles at once in the media lane, and only there", () => {
    for (const role of ["heavy", "all"] as const) {
      const lanes = workerLanes(role, []);
      expect(lanes.find((lane) => lane.name === "media")?.concurrency).toBe(
        DEFAULT_MEDIA_CONCURRENCY,
      );
      expect(lanes.find((lane) => lane.name === "trickplay")?.concurrency).toBe(
        1,
      );
      expect(
        workerLanes(role, [], { mediaConcurrency: 1 }).find(
          (lane) => lane.name === "media",
        )?.concurrency,
      ).toBe(1);
    }
    expect(parseMediaConcurrency(undefined)).toBe(DEFAULT_MEDIA_CONCURRENCY);
    expect(parseMediaConcurrency(" 2 ")).toBe(2);
    for (const bad of ["0", "1.5", "nine", "9"]) {
      expect(() => parseMediaConcurrency(bad)).toThrow(
        /SEYIRLIK_MEDIA_CONCURRENCY/,
      );
    }
  });

  /*
   * A bridge runs beside a worker that still holds an encode. It must never
   * take long work, nor the work that goes through the encoder's own scratch
   * and enqueuer, and it should take everything else its role takes.
   */
  it("gives a bridge the short half of its role and nothing that holds the encoder", () => {
    for (const role of ["heavy", "all"] as const) {
      const bridge = workerLanes(role, [], { bridge: true });
      const full = workerLanes(role, []);
      for (const type of EVERY_TYPE) {
        const owned =
          LONG_JOB_TYPES.includes(type) ||
          ANALYSIS_LANE_JOB_TYPES.includes(type) ||
          type === IMPORT_JOB_TYPES.process ||
          type === GARBAGE_JOB_TYPES.collect;
        expect(claimingLane(bridge, type) !== null, `${role} ${type}`).toBe(
          !owned && claimingLane(full, type) !== null,
        );
      }
    }
    expect(
      workerLanes("heavy", [], { bridge: true }).map((lane) => lane.name),
    ).toEqual(["downloads"]);
    expect(LONG_JOB_TYPES).toContain(JOB_TYPES.mediaProcess);
  });

  it("transcribes one at a time, only where a recogniser is declared", () => {
    for (const role of ["heavy", "all"] as const) {
      expect(
        claimingLane(workerLanes(role, []), SUBTITLE_ANALYSIS_JOB_TYPE),
      ).toBe("analysis");
      expect(
        claimingLane(
          workerLanes(role, [SUBTITLE_ANALYSIS_JOB_TYPE]),
          SUBTITLE_ANALYSIS_JOB_TYPE,
        ),
      ).toBeNull();
      expect(
        workerLanes(role, []).find((lane) => lane.name === "analysis")
          ?.concurrency,
      ).toBe(1);
    }
    // The always-on server never transcribes, recogniser or not.
    expect(
      claimingLane(workerLanes("light", []), SUBTITLE_ANALYSIS_JOB_TYPE),
    ).toBeNull();
  });

  it("leaves encode bookkeeping to the worker that runs the encoder", () => {
    expect(ownsProcessing(true, "light")).toBe(false);
    expect(ownsProcessing(true, "heavy")).toBe(true);
    expect(ownsProcessing(true, "all")).toBe(true);
    expect(ownsProcessing(false, "all")).toBe(false);
    expect(ownsLibrary(true, "heavy")).toBe(false);
    expect(ownsLibrary(true, "light")).toBe(true);
  });
});
