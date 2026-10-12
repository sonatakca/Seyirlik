import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readVolumeSpace } from "./volumeSpace";

describe("readVolumeSpace", () => {
  it("reports one volume once, under the first role that names it", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "volume-space-"));
    const media = path.join(base, "media");
    const scratch = path.join(base, "scratch");
    await mkdir(media);
    await mkdir(scratch);

    const volumes = await readVolumeSpace([
      { role: "media", root: media },
      { role: "scratch", root: scratch },
    ]);

    expect(volumes).toHaveLength(1);
    expect(volumes[0]!.role).toBe("media");
    expect(volumes[0]!.totalBytes).toBeGreaterThan(0);
    expect(volumes[0]!.freeBytes).toBeGreaterThanOrEqual(0);
    expect(volumes[0]!.freeBytes!).toBeLessThanOrEqual(volumes[0]!.totalBytes!);
  });

  it("answers null, not zero, for a root it could not ask", async () => {
    const volumes = await readVolumeSpace([
      { role: "media", root: path.join(tmpdir(), "does-not-exist-volume") },
    ]);
    expect(volumes).toEqual([
      { role: "media", freeBytes: null, totalBytes: null },
    ]);
  });

  it("leaves a skipped volume untouched and unknown", async () => {
    const volumes = await readVolumeSpace([
      { role: "media", root: tmpdir(), skip: true },
      { role: "scratch", root: tmpdir() },
    ]);
    expect(volumes[0]).toEqual({
      role: "media",
      freeBytes: null,
      totalBytes: null,
    });
    expect(volumes[1]!.freeBytes).not.toBeNull();
  });
});
