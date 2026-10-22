import { describe, expect, it, vi } from "vitest";
import {
  adaptersForPlatform,
  adaptersNotOnPlatform,
  isDriveableEncoder,
} from "./adapters";
import { detectHardware } from "./detect";

const ok = vi.fn(async () => ({ ok: true }));
const fail = vi.fn(async () => ({ ok: false, detail: "Unknown encoder" }));

describe("adapter ordering", () => {
  /** Hardware first, software last: software is a destination, not a default. */
  it("puts the platform's own accelerator first and software last", () => {
    const order = adaptersForPlatform("darwin").map((adapter) => adapter.id);

    expect(order[0]).toBe("videotoolbox");
    expect(order[order.length - 1]).toBe("software");
  });

  it("offers Windows and Linux their own accelerators", () => {
    expect(adaptersForPlatform("win32").map((a) => a.id)).toContain("amf");
    expect(adaptersForPlatform("linux").map((a) => a.id)).toContain("vaapi");
    expect(adaptersForPlatform("win32").map((a) => a.id)).not.toContain(
      "vaapi",
    );
  });

  it("still names the adapters that belong to other platforms", () => {
    // They are reported as unavailable with a reason rather than hidden, so an
    // operator can see their GPU was considered.
    expect(adaptersNotOnPlatform("darwin").map((a) => a.id)).toEqual(
      expect.arrayContaining(["amf", "vaapi"]),
    );
  });

  it("knows which encoders this build can actually configure", () => {
    expect(isDriveableEncoder("h264_videotoolbox")).toBe(true);
    expect(isDriveableEncoder("libx264")).toBe(true);
    expect(isDriveableEncoder("hevc_nvenc")).toBe(true);
    expect(isDriveableEncoder("h264_amf")).toBe(false);
  });
});

describe("detectHardware", () => {
  it("selects the accelerator when it encodes successfully", async () => {
    const report = await detectHardware({
      platform: "darwin",
      probe: ok as never,
    });

    expect(report.selected.h264).toBe("h264_videotoolbox");
    expect(report.selectedAdapter.h264).toBe("videotoolbox");
  });

  /** An encoder can be compiled in on a machine with no accelerator to run it. */
  it("falls back to software when nothing hardware-backed will start", async () => {
    const probe = vi.fn(async (_path: string, encoder: string) =>
      encoder.startsWith("libx")
        ? { ok: true }
        : { ok: false, detail: "no device" },
    );

    const report = await detectHardware({
      platform: "darwin",
      probe: probe as never,
    });

    expect(report.selected.h264).toBe("libx264");
    expect(report.selected.hevc).toBe("libx265");
    expect(report.selectedAdapter.h264).toBe("software");
  });

  it("explains why an adapter for another platform is unavailable", async () => {
    const report = await detectHardware({
      platform: "darwin",
      probe: ok as never,
    });
    const amf = report.adapters.find((adapter) => adapter.id === "amf");

    expect(amf?.available).toBe(false);
    expect(amf?.reason).toBe("wrong-platform");
    expect(amf?.detail).toContain("darwin");
  });

  it("explains an encoder this build recognises but does not drive", async () => {
    const report = await detectHardware({
      platform: "linux",
      probe: ok as never,
    });
    const vaapi = report.adapters.find((adapter) => adapter.id === "vaapi");

    expect(vaapi?.available).toBe(false);
    expect(vaapi?.lanes[0]?.reason).toBe("not-implemented");
  });

  it("prefers NVENC on a machine with an NVIDIA GPU", async () => {
    const report = await detectHardware({
      platform: "win32",
      probe: ok as never,
    });

    expect(report.selected.hevcTenBit).toBe("hevc_nvenc");
    expect(report.selected.h264).toBe("h264_nvenc");
  });

  it("keeps Quick Sync where NVENC cannot open a session", async () => {
    const probe = vi.fn(async (_ffmpeg: string, encoder: string) =>
      encoder.endsWith("_nvenc")
        ? { ok: false, detail: "No NVENC capable devices found" }
        : { ok: true },
    );
    const report = await detectHardware({
      platform: "win32",
      probe: probe as never,
    });

    expect(report.selected.hevcTenBit).toBe("hevc_qsv");
    expect(report.selectedAdapter.h264).toBe("qsv");
  });

  it("reports FFmpeg's own reason when a probe fails", async () => {
    const report = await detectHardware({
      platform: "darwin",
      probe: fail as never,
    });
    const videotoolbox = report.adapters.find(
      (adapter) => adapter.id === "videotoolbox",
    );

    expect(videotoolbox?.available).toBe(false);
    expect(videotoolbox?.lanes[0]?.detail).toContain("Unknown encoder");
  });

  /**
   * An encoder that opens at a thumbnail size can still refuse a real frame,
   * which is exactly how a 480p rung once failed on hardware that encoded
   * 1080p without complaint.
   */
  it("probes at the frame size processing will actually use", async () => {
    const probe = vi.fn(async () => ({ ok: true }));

    await detectHardware({
      platform: "darwin",
      probe: probe as never,
      probeWidth: 1920,
      probeHeight: 1080,
    });

    const options = (probe.mock.calls as unknown as unknown[][])[0]![2];
    expect(options).toMatchObject({ width: 1920, height: 1080 });
  });

  it("probes ten-bit separately from eight-bit", async () => {
    const probe = vi.fn(async () => ({ ok: true }));

    await detectHardware({ platform: "darwin", probe: probe as never });

    const tenBitCalls = (probe.mock.calls as unknown as unknown[][]).filter(
      (call) => (call[2] as { tenBit?: boolean } | undefined)?.tenBit === true,
    );
    expect(tenBitCalls.length).toBeGreaterThan(0);
  });
});
