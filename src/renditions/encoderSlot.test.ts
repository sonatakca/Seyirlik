import { describe, expect, it } from "vitest";
import { createEncoderSlot, withEncoderSlot } from "./encoderSlot";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("encoder slot", () => {
  it("lets one holder in at a time, in the order they asked", async () => {
    const slot = createEncoderSlot();
    const order: string[] = [];
    const first = await slot.acquire();
    expect(slot.busy).toBe(true);
    const second = slot.acquire().then((release) => {
      order.push("second");
      return release;
    });
    const third = slot.acquire().then((release) => {
      order.push("third");
      return release;
    });
    await tick();
    expect(order).toEqual([]);
    first();
    (await second)();
    (await third)();
    expect(order).toEqual(["second", "third"]);
    expect(slot.busy).toBe(false);
  });

  it("drops a waiter whose signal aborts, and never gives it the slot", async () => {
    const slot = createEncoderSlot();
    const release = await slot.acquire();
    const cancelled = new AbortController();
    const waiting = slot.acquire(cancelled.signal);
    const next = slot.acquire();
    cancelled.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    release();
    const nextRelease = await next;
    expect(slot.busy).toBe(true);
    nextRelease();
    expect(slot.busy).toBe(false);
  });

  it("gives the slot back when the work throws, and a release twice is once", async () => {
    const slot = createEncoderSlot();
    await expect(
      withEncoderSlot(slot, undefined, async () => {
        throw new Error("encoder failed");
      }),
    ).rejects.toThrow("encoder failed");
    expect(slot.busy).toBe(false);
    const release = await slot.acquire();
    const waiter = slot.acquire();
    release();
    release();
    const second = await waiter;
    expect(slot.busy).toBe(true);
    second();
    expect(slot.busy).toBe(false);
  });
});
