/**
 * The one video encoder a worker drives at a time.
 *
 * A title is mostly not encoding. On the laptop an eleven-minute episode spent
 * about two minutes planning (frame times, then sample encodes scored with
 * VMAF), two encoding, and another minute assembling, verifying and
 * publishing — and with one job at a time the GPU sat idle for all but those
 * two minutes. The encoder was already saturated when it ran (NVENC at 94%),
 * so two encodes at once would only share it, and they would also run out of
 * the eight sessions a GeForce driver allows.
 *
 * So the processing lane runs several jobs, and the encoder is this slot:
 * whatever submits video frames to it — an epoch build, a rate probe's sample
 * encodes — holds it, and everything else (probes, VMAF on the CPU, audio,
 * assembly, verification, publication) runs beside it. Waiters are served in
 * the order they asked, which is the order their jobs were leased in.
 *
 * In-process on purpose: every job that can encode on a machine runs in that
 * machine's one worker process.
 */

export interface EncoderSlot {
  /**
   * Resolves with a release function once the slot is this caller's. Rejects
   * with the signal's reason if it aborts first, without ever taking the slot.
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
  /** Whether someone holds the slot now, so a caller can say it is waiting. */
  readonly busy: boolean;
}

export function createEncoderSlot(): EncoderSlot {
  let held = false;
  const waiters: Array<{
    grant: () => void;
    signal: AbortSignal | undefined;
  }> = [];

  const release = () => {
    // Hand it straight to the next live waiter, so nobody can slip in between.
    while (waiters.length > 0) {
      const next = waiters.shift()!;
      if (next.signal?.aborted) continue;
      next.grant();
      return;
    }
    held = false;
  };

  const releaser = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };

  return {
    get busy() {
      return held;
    },
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      if (!held) {
        held = true;
        return Promise.resolve(releaser());
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          signal,
          grant: () => {
            signal?.removeEventListener("abort", onAbort);
            resolve(releaser());
          },
        };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(abortReason(signal!));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(waiter);
      });
    },
  };
}

/** Runs `work` while holding the slot, and gives it back however `work` ends. */
export async function withEncoderSlot<T>(
  slot: EncoderSlot,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const release = await slot.acquire(signal);
  try {
    return await work();
  } finally {
    release();
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** The worker process's encoder. */
export const sharedEncoderSlot: EncoderSlot = createEncoderSlot();
