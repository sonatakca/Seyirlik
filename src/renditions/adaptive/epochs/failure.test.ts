import { describe, expect, it } from "vitest";
import { readSourceIoEvidence } from "./sourceIo";
import {
  classifyFailure,
  looksLikeOutOfSpace,
  looksLikeStorageLoss,
  SourceReadError,
  StorageInterruptedError,
} from "./failure";

describe("classifyFailure", () => {
  it("calls it storage when the volume itself is not answering", () => {
    const failure = classifyFailure({
      message: "ENOENT: no such file or directory, open '/Volumes/Expansion/x'",
      storageAvailable: false,
      missingRoots: ["/Volumes/Expansion"],
    });
    expect(failure.kind).toBe("storage-device-lost");
    expect(failure.summary).toContain("/Volumes/Expansion");
  });

  it("recognises one I/O error as hard storage evidence before the watchdog notices", () => {
    /*
     * The watchdog polls; FFmpeg fails instantly. Between the two there is a
     * window in which the drive is gone and the check has not run yet, and a
     * job that failed in that window used to be marked permanently failed.
     */
    const failure = classifyFailure({
      message: "FFmpeg failed with exit code 1: Input/output error",
      storageAvailable: true,
    });
    expect(failure.kind).toBe("storage-io");
  });

  it("separates a full disk from a missing one", () => {
    expect(
      classifyFailure({
        message: "av_interleaved_write_frame(): No space left on device",
        storageAvailable: true,
      }).kind,
    ).toBe("out-of-space");
  });

  it("treats a missing path as a missing source while the storage is healthy", () => {
    expect(
      classifyFailure({
        message: "ENOENT: no such file or directory",
        storageAvailable: true,
      }).kind,
    ).toBe("source-missing");
  });

  it("falls back to an encoder fault when nothing else fits", () => {
    const failure = classifyFailure({
      message: "Cannot prepare encoder: -12902",
      storageAvailable: true,
    });
    expect(failure.kind).toBe("encoder");
    expect(failure.detail).toContain("-12902");
  });

  it("keeps the underlying text so the cause survives into the job record", () => {
    const failure = classifyFailure({
      message: `${"x".repeat(9000)}Input/output error`,
      storageAvailable: true,
    });
    expect(failure.detail.length).toBeLessThanOrEqual(4000);
    expect(failure.detail).toContain("Input/output error");
  });
});

describe("the errno outranks the prose", () => {
  /*
   * Seyirlik's own storage refusals are written in English and carry a code.
   * Reading only the sentence classified a full destination volume as a broken
   * encoder, which ended the job permanently instead of deferring it until
   * somebody made room.
   */
  it("defers a full disk whose message never says so", () => {
    const failure = classifyFailure({
      message:
        "The final media volume does not have enough free space for transactional publication.",
      errorCode: "ENOSPC",
      storageAvailable: true,
    });
    expect(failure.kind).toBe("out-of-space");
  });

  it("does not call a full disk a disappeared one", () => {
    // A full volume is still a mounted volume; "no room" must not become
    // "the drive went away", which would park the job for a watchdog that has
    // nothing to wait for.
    const failure = classifyFailure({
      message: "No space left on the destination.",
      errorCode: "ENOSPC",
      storageAvailable: false,
    });
    expect(failure.kind).toBe("out-of-space");
  });

  it("reads a hard I/O errno even when the message is plain", () => {
    const failure = classifyFailure({
      message: "The destination could not be written.",
      errorCode: "EIO",
      storageAvailable: true,
    });
    expect(failure.kind).toBe("storage-io");
  });

  it("still falls back to the message when there is no errno", () => {
    const failure = classifyFailure({
      message: "The encoder stopped unexpectedly.",
      storageAvailable: true,
    });
    expect(failure.kind).toBe("encoder");
  });
});

describe("error patterns", () => {
  it.each([
    "Input/output error",
    "EIO",
    "Stale file handle",
    "Device not configured",
  ])("recognises %s as storage loss", (message) => {
    expect(looksLikeStorageLoss(message)).toBe(true);
  });

  it("does not mistake an ordinary encoder failure for storage loss", () => {
    expect(looksLikeStorageLoss("Invalid argument")).toBe(false);
    expect(looksLikeOutOfSpace("Invalid argument")).toBe(false);
  });
});

describe("StorageInterruptedError", () => {
  it("carries the classification so no layer has to re-derive it from a string", () => {
    const failure = classifyFailure({
      message: "Input/output error",
      storageAvailable: false,
    });
    const error = new StorageInterruptedError(failure);
    expect(error.failure.kind).toBe("storage-device-lost");
    expect(error.name).toBe("StorageInterruptedError");
  });
});

/**
 * Telling a drive that was pulled out from media that will not read.
 *
 * Both arrive as `EIO` and both used to be answered by parking the job and
 * waiting for a watchdog transition. That is right for the first and a silent
 * trap for the second, so the escalation is what decides between them: an I/O
 * error is storage loss until the storage has been re-checked, repeatedly, and
 * found present each time.
 */
describe("classifying hard I/O without corroboration", () => {
  it("classifies the first I/O error as hard storage evidence", () => {
    expect(
      classifyFailure({
        message: "Input/output error",
        storageAvailable: true,
        ioRechecksExhausted: false,
      }).kind,
    ).toBe("storage-io");
  });

  it("classifies an offline caller's exhausted source retries as source I/O", () => {
    const failure = classifyFailure({
      message: "FFmpeg failed with exit code 1: Input/output error",
      storageAvailable: true,
      ioRechecksExhausted: true,
    });
    expect(failure.kind).toBe("source-io");
    expect(failure.summary).toMatch(/damaged media|failing disk/i);
    expect(failure.detail).toContain("Input/output error");
  });

  it("lets a missing volume win over an exhausted read budget", () => {
    /*
     * The drive going in the middle of the escalation is still a drive going.
     * Reporting damaged media for a disk that has been unplugged would send an
     * operator looking for a fault that is not there.
     */
    expect(
      classifyFailure({
        message: "Input/output error",
        storageAvailable: false,
        ioRechecksExhausted: true,
        missingRoots: ["/Volumes/Expansion"],
      }).kind,
    ).toBe("storage-device-lost");
  });

  it("does not escalate an ordinary encoder fault into a source fault", () => {
    expect(
      classifyFailure({
        message: "Cannot prepare encoder: -12902",
        storageAvailable: true,
        ioRechecksExhausted: true,
      }).kind,
    ).toBe("encoder");
  });

  it("does not escalate a full disk", () => {
    expect(
      classifyFailure({
        message: "No space left on device",
        storageAvailable: true,
        ioRechecksExhausted: true,
      }).kind,
    ).toBe("out-of-space");
  });
});

describe("SourceReadError", () => {
  it("names the epoch and how many reads were spent on it", () => {
    const failure = classifyFailure({
      message: "Input/output error",
      storageAvailable: true,
      ioRechecksExhausted: true,
    });
    const error = new SourceReadError(failure, 2, 4);
    expect(error.name).toBe("SourceReadError");
    expect(error.epochIndex).toBe(2);
    expect(error.attempts).toBe(4);
    // It is deliberately not a StorageInterruptedError: the two are handled
    // in opposite ways and must never be caught by the same branch.
    expect(error).not.toBeInstanceOf(StorageInterruptedError);
  });
});

/**
 * The one misclassification that must never happen.
 *
 * Salvage replaces film with black. Doing that because the *destination* volume
 * returned `EIO` would destroy readable material to work around a failing
 * output disk, so output-side evidence overrides the retry count entirely.
 */
describe("which side of the transcode failed", () => {
  it("calls a write failure storage, however many times it repeats", () => {
    const failure = classifyFailure({
      message: "FFmpeg failed with exit code 1: Input/output error",
      storageAvailable: true,
      ioRechecksExhausted: true,
      evidence: readSourceIoEvidence(
        "[out#0/hls @ 0x1] Error writing trailer: Input/output error",
      ),
    });
    expect(failure.kind).toBe("storage-io");
  });

  it("calls a read failure source damage once the budget is spent", () => {
    const failure = classifyFailure({
      message: "FFmpeg failed with exit code 1: Input/output error",
      storageAvailable: true,
      ioRechecksExhausted: true,
      evidence: readSourceIoEvidence(
        [
          "[in#0/matroska,webm @ 0x1] Read error at pos. 10074169063",
          "[in#0/matroska,webm @ 0x1] Error during demuxing: Input/output error",
        ].join("\n"),
      ),
    });
    expect(failure.kind).toBe("source-io");
    expect(failure.evidence?.byteOffset).toBe(10_074_169_063);
  });

  it("calls the first explicit FFmpeg input error a source fault", () => {
    const failure = classifyFailure({
      message: "FFmpeg failed with exit code 1: Input/output error",
      storageAvailable: true,
      ioRechecksExhausted: false,
      evidence: readSourceIoEvidence(
        "[in#0] Error during demuxing: Input/output error",
      ),
    });
    expect(failure.kind).toBe("source-io");
  });

  it("uses the exhausted source verdict when no side evidence exists", () => {
    expect(
      classifyFailure({
        message: "FFmpeg failed with exit code 1: Input/output error",
        storageAvailable: true,
        ioRechecksExhausted: true,
      }).kind,
    ).toBe("source-io");
  });

  it("calls a network stall a network stall, not source I/O", () => {
    const failure = classifyFailure({
      message: "FFmpeg produced no media for 26s and was stopped at 1658.907s.",
      storageAvailable: true,
      ioRechecksExhausted: true,
      sourceVerdict: "network-stall",
    });
    expect(failure.kind).toBe("network-read-stall");
  });

  it("lets a vanished network volume win over a network stall", () => {
    expect(
      classifyFailure({
        message:
          "FFmpeg produced no media for 26s and was stopped at 1658.907s.",
        storageAvailable: false,
        ioRechecksExhausted: true,
        sourceVerdict: "network-stall",
      }).kind,
    ).toBe("storage-device-lost");
  });
});
