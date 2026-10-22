import { stat, statfs } from "node:fs/promises";

/**
 * How much room is left on the volumes the server writes to.
 *
 * Two roles, because they fill for different reasons and run out at different
 * times: the media volume holds sources and published packages and fills over
 * weeks; the scratch volume holds a job's checkpoints and fills inside one
 * encode. When both roots sit on one volume it is reported once, under the
 * first role, rather than as two numbers that would fall together.
 *
 * `statfs` asks the file system for its counters and reads no data, but the
 * media volume is still skipped while the watchdog says it is gone — a drive
 * in the middle of an incident is not asked anything it does not have to be.
 */
export type VolumeRole = "media" | "scratch";

export interface VolumeSpace {
  role: VolumeRole;
  /** Null when the volume could not be asked, which is not the same as full. */
  freeBytes: number | null;
  totalBytes: number | null;
}

export async function readVolumeSpace(
  roots: ReadonlyArray<{ role: VolumeRole; root: string; skip?: boolean }>,
): Promise<VolumeSpace[]> {
  const seenDevices = new Set<number>();
  const volumes: VolumeSpace[] = [];

  for (const { role, root, skip } of roots) {
    if (skip) {
      volumes.push({ role, freeBytes: null, totalBytes: null });
      continue;
    }
    try {
      const { dev } = await stat(root);
      if (seenDevices.has(dev)) continue;
      seenDevices.add(dev);
      const counters = await statfs(root, { bigint: true });
      const totalBytes = Number(counters.bsize * counters.blocks);
      const freeBytes = Number(counters.bsize * counters.bavail);
      volumes.push({ role, freeBytes, totalBytes });
    } catch {
      volumes.push({ role, freeBytes: null, totalBytes: null });
    }
  }

  return volumes;
}
