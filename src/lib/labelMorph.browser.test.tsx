import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AnimatedText } from "../components/AnimatedText";
import { AnimatedWidth } from "../components/AnimatedWidth";

afterEach(cleanup);

/**
 * A label that changes width inside a pill, with a neighbour after it: the
 * label, the pill's fill and the neighbour must all set off from where they
 * were drawn and arrive where layout puts them, moved by transforms alone.
 */

function Row({ value }: { value: string }) {
  return (
    <div style={{ font: "16px sans-serif" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          data-testid="pill"
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: 40,
            padding: "0 16px",
            borderRadius: 999,
            border: "1px solid rgba(0, 0, 0, 0.2)",
            background: "rgb(240, 240, 240)",
          }}
        >
          <AnimatedWidth value={value}>
            <AnimatedText value={value} />
          </AnimatedWidth>
        </button>
        <span data-testid="next" style={{ display: "inline-block" }}>
          Next
        </span>
      </div>
    </div>
  );
}

const left = (testId: string) =>
  screen.getByTestId(testId).getBoundingClientRect().left;

/** Where the pill's fill is drawn: its own box, or its clips mid-stretch. */
function drawnPill() {
  const pill = screen.getByTestId("pill");
  const edge = pill.querySelector(
    ":scope > [data-morph-paint] > [data-morph-edge]",
  );
  if (!edge) {
    const box = pill.getBoundingClientRect();
    return { left: box.left, width: box.width };
  }
  const start = edge.parentElement!.getBoundingClientRect().left;
  return { left: start, width: edge.getBoundingClientRect().right - start };
}

/** Lets the commit's microtask start the morph. */
const settleCommit = () => act(async () => {});

/** Finishes every animation, then waits out the frame that reports it. */
const finishAll = () =>
  act(async () => {
    for (const animation of document.getAnimations()) animation.finish();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });

it("carries the neighbour and the pill's fill from where they were drawn", async () => {
  const { rerender } = render(<Row value="Play" />);
  const before = { next: left("next"), pill: drawnPill() };

  rerender(<Row value="Continue watching" />);
  await settleCommit();

  // The first frame still shows the old geometry. Headless WebKit's frames
  // are few and far between, and one may land before this read, so "nearly",
  // not "exactly": the point is that nothing jumps to the new place.
  const first = { next: left("next"), pill: drawnPill() };
  // The pill gave its fill to the copies, which are moved, never resized.
  expect(getComputedStyle(screen.getByTestId("pill")).backgroundColor).toBe(
    "rgba(0, 0, 0, 0)",
  );
  for (const animation of document.getAnimations()) {
    const effect = animation.effect as KeyframeEffect;
    for (const frame of effect.getKeyframes()) {
      const moved = Object.keys(frame).filter(
        (key) =>
          !["offset", "easing", "composite", "computedOffset"].includes(key),
      );
      for (const key of moved) {
        expect(["translate", "scale", "transform", "opacity"]).toContain(key);
      }
    }
  }

  await finishAll();

  const pill = screen.getByTestId("pill");
  expect(pill.querySelector("[data-morph-paint]")).toBeNull();
  expect(getComputedStyle(pill).backgroundColor).toBe("rgb(240, 240, 240)");
  expect(drawnPill().width).toBeGreaterThan(before.pill.width + 40);
  expect(left("next")).toBeGreaterThan(before.next + 40);
  expect(screen.getByTestId("pill").textContent).toBe("Continue watching");

  const progress = (from: number, at: number, to: number) =>
    (at - from) / (to - from);
  expect(progress(before.next, first.next, left("next"))).toBeLessThan(0.2);
  expect(
    progress(before.pill.width, first.pill.width, drawnPill().width),
  ).toBeLessThan(0.2);
});

it("sets off again from where an interrupted change has got to", async () => {
  const { rerender } = render(<Row value="Play" />);
  rerender(<Row value="Continue watching" />);
  await settleCommit();

  // Part way there, held still so the clock cannot move under the check.
  for (const animation of document.getAnimations()) {
    animation.currentTime = 150;
    animation.pause();
  }
  const midway = { next: left("next"), pill: drawnPill() };

  rerender(<Row value="Resume" />);
  await settleCommit();

  expect(left("next")).toBeCloseTo(midway.next, 0);
  expect(drawnPill().left).toBeCloseTo(midway.pill.left, 0);
  expect(drawnPill().width).toBeCloseTo(midway.pill.width, 0);

  await finishAll();
  expect(
    screen.getByTestId("pill").querySelector("[data-morph-paint]"),
  ).toBeNull();
  expect(screen.getByTestId("pill").textContent).toBe("Resume");
});
