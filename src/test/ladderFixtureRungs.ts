/**
 * The priced ladder `ladderFixture.ts` declares, in a module the browser can
 * import (the builder itself needs Node).
 */

/** Average video bitrates of Seyirlik's H.264 ladder (`renditions/encoding.ts`). */
export const LADDER_FIXTURE_RUNGS = [
  { height: 144, width: 256, averageBps: 180_000 },
  { height: 240, width: 426, averageBps: 350_000 },
  { height: 360, width: 640, averageBps: 700_000 },
  { height: 480, width: 854, averageBps: 1_400_000 },
  { height: 720, width: 1280, averageBps: 3_000_000 },
  { height: 1080, width: 1920, averageBps: 5_500_000 },
  { height: 2160, width: 3840, averageBps: 20_000_000 },
] as const;
