import { describe, expect, it } from "vitest";
import { processingDeviceLabel } from "./processingDevice";

describe("processingDeviceLabel", () => {
  it("names the machine and its encoder once a worker has planned the job", () => {
    expect(
      processingDeviceLabel({
        processedBy: "MSI laptop",
        hardwareAdapter: "nvenc",
        state: "running",
      }),
    ).toBe("MSI laptop · NVIDIA NVENC");
  });

  it("says nothing for a queued job, whose adapter is only the queue-time guess", () => {
    expect(
      processingDeviceLabel({
        processedBy: null,
        hardwareAdapter: "qsv",
        state: "queued",
      }),
    ).toBeNull();
  });

  it("falls back to the encoder for a job planned before machines were recorded", () => {
    expect(
      processingDeviceLabel({
        processedBy: null,
        hardwareAdapter: "nvenc",
        state: "running",
      }),
    ).toBe("NVIDIA NVENC");
  });
});
