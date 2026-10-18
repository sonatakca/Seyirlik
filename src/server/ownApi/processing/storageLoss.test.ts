import { describe, expect, it } from "vitest";
import { deviceLossEvidence } from "./storageLoss";

const job = (id: string, state: string) => ({ id, state });

describe("deviceLossEvidence", () => {
  it("is the running job when the encoding worker loses its volume", () => {
    expect(
      deviceLossEvidence(true, [job("a", "paused"), job("b", "running")]),
    ).toEqual(job("b", "running"));
  });

  it("is nothing when no job has a source open", () => {
    expect(
      deviceLossEvidence(true, [
        job("a", "paused"),
        job("b", "queued"),
        job("c", "pending"),
      ]),
    ).toBeNull();
  });

  it("is nothing in a process that does not run the encoder", () => {
    expect(deviceLossEvidence(false, [job("a", "running")])).toBeNull();
  });
});
