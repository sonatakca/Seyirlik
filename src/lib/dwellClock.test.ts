import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DwellClock } from "./dwellClock";

describe("DwellClock", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onDone once the dwell has run", () => {
    const clock = new DwellClock(1000);
    const onDone = vi.fn();
    clock.start(onDone);

    vi.advanceTimersByTime(999);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(clock.isRunning).toBe(false);
  });

  it("keeps the place reached when stopped, and resumes from it", () => {
    const clock = new DwellClock(1000);
    const bar = document.createElement("div");
    clock.attach(bar);
    const onDone = vi.fn();
    const stop = clock.start(onDone);

    vi.advanceTimersByTime(400);
    stop();
    expect(clock.fraction).toBeCloseTo(0.4);
    expect(bar.style.transform).toBe("scaleX(0.4)");

    vi.advanceTimersByTime(5000);
    expect(onDone).not.toHaveBeenCalled();

    clock.start(onDone);
    vi.advanceTimersByTime(599);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("restarts a running clock from zero on reset, and a stale stop does nothing", () => {
    const clock = new DwellClock(1000);
    const onDone = vi.fn();
    const stop = clock.start(onDone);

    vi.advanceTimersByTime(800);
    clock.reset();
    stop();
    expect(clock.isRunning).toBe(true);
    expect(clock.fraction).toBe(0);

    vi.advanceTimersByTime(999);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("fires a mark when the running clock reaches it, never while held", () => {
    const clock = new DwellClock(1000);
    const fire = vi.fn();
    clock.onReach(0.5, fire);

    vi.advanceTimersByTime(2000);
    expect(fire).not.toHaveBeenCalled();

    const stop = clock.start(() => {});
    vi.advanceTimersByTime(300);
    stop();
    vi.advanceTimersByTime(1000);
    expect(fire).not.toHaveBeenCalled();

    clock.start(() => {});
    vi.advanceTimersByTime(199);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("paints the bar at the start of a run without an animation API", () => {
    const clock = new DwellClock(1000);
    const bar = document.createElement("div");
    clock.attach(bar);
    expect(bar.style.transform).toBe("scaleX(0)");
  });
});
