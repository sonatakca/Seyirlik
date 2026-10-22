import { describe, expect, it } from "vitest";

import {
  FINE_SEEK_REACH_PX,
  FINE_SEEK_SECONDS_PER_PX,
  stepFineSeek,
  type FineSeekState,
} from "./fineSeek";

// A two-hour film on a 1200 px bar: six seconds under every pixel.
const duration = 7_200;
const secondsPerPx = 6;

function move(
  state: FineSeekState | null,
  position: number,
  at: number,
): FineSeekState {
  return stepFineSeek(state, { position, at, secondsPerPx, duration });
}

describe("stepFineSeek", () => {
  it("starts under the pointer", () => {
    expect(move(null, 100, 0).seconds).toBe(600);
  });

  it("steps one second per pixel while the pointer is nudged", () => {
    let state = move(null, 100, 0);
    const seen = [state.seconds];
    for (let step = 1; step <= 5; step += 1) {
      state = move(state, 100 + step, step * 200);
      seen.push(state.seconds);
    }

    expect(seen).toEqual([600, 601, 602, 603, 604, 605]);
  });

  it("follows the pointer exactly on a sweep", () => {
    let state = move(null, 100, 0);
    state = move(state, 101, 300);
    state = move(state, 140, 316);
    state = move(state, 180, 332);

    expect(state.seconds).toBe(180 * secondsPerPx);
  });

  it("never strays further from the pointer than its reach", () => {
    let state = move(null, 100, 0);
    for (let step = 1; step <= 60; step += 1) {
      state = move(state, 100 + step, step * 200);
    }

    const underPointer = 160 * secondsPerPx;
    expect(underPointer - state.seconds).toBe(
      FINE_SEEK_REACH_PX * secondsPerPx,
    );
  });

  it("lets a nudge back pick out each second again", () => {
    let state = move(null, 100, 0);
    state = move(state, 99, 200);
    state = move(state, 98, 400);

    expect(state.seconds).toBe(600 - 2 * FINE_SEEK_SECONDS_PER_PX);
  });

  it("keeps the plain mapping where a pixel is already under a second", () => {
    const short = stepFineSeek(null, {
      position: 100,
      at: 0,
      secondsPerPx: 0.5,
      duration: 600,
    });
    const next = stepFineSeek(short, {
      position: 101,
      at: 400,
      secondsPerPx: 0.5,
      duration: 600,
    });

    expect(next.seconds).toBe(50.5);
  });

  it("stays inside the film", () => {
    let state = move(null, 0, 0);
    state = move(state, -3, 200);

    expect(state.seconds).toBe(0);
  });
});
