import { act, cleanup, render } from "@testing-library/react";
import { frame } from "framer-motion";
import { useRef } from "react";
import { afterEach, expect, it } from "vitest";
import { Curve } from "./curve";
import { useBake } from "./bake";

afterEach(cleanup);

/**
 * A baked journey's first frame.
 *
 * The bakery leaves an element's own style at where its journey ends and starts
 * the journey at framer-motion's frame stamp, which is performance.now() and so
 * usually a few ms past the document timeline's time for that frame. An
 * animation that has not begun draws the element's own style unless it fills
 * backwards — and so a title flashed at full size before it rose, and jumped
 * ahead for a frame whenever an image load re-baked it mid-flight.
 */

const DISTANCE = 400;

function Baked({ x, offset }: { x: Curve; offset: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useBake(
    [x],
    (at) => [
      [ref.current, { transform: `translateX(${x.get(at) + offset}px)` }],
    ],
    [offset],
  );
  return (
    <div ref={ref} data-testid="baked" style={{ width: 10, height: 10 }} />
  );
}

const drawnX = (element: Element) =>
  new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;

/** After every frame.update callback of the coming frame, the bakery's flush among them. */
const afterFlush = () =>
  new Promise<void>((resolve) => frame.render(() => resolve()));

it("draws a journey's first frame where the journey starts, not where it ends", async () => {
  const x = new Curve(0);
  const view = render(<Baked x={x} offset={0} />);
  const element = view.getByTestId("baked");

  // WebKit's timeline is quantised to the millisecond, so a frame's stamp is
  // ahead of it only some of the time; enough journeys meet that case.
  for (let journey = 0; journey < 12; journey += 1) {
    const from = x.get();
    const to = from === 0 ? DISTANCE : 0;
    x.tween(to, { duration: 1, ease: "linear" });
    await afterFlush();
    expect(Math.abs(drawnX(element) - from)).toBeLessThan(DISTANCE * 0.05);
    x.set(to);
    await afterFlush();
  }
});

it("carries a journey on from where it is when a re-bake lands mid-flight", async () => {
  const x = new Curve(0);
  const view = render(<Baked x={x} offset={0} />);
  const element = view.getByTestId("baked");

  x.tween(DISTANCE, { duration: 2, ease: "linear" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const before = x.get();
  // A prop the look depends on changes between frames, as an artwork's size
  // does when it loads: the journey is baked again at once, before paint.
  act(() => view.rerender(<Baked x={x} offset={1} />));

  const drawn = drawnX(element) - 1;
  expect(drawn).toBeGreaterThanOrEqual(before - 1);
  expect(drawn).toBeLessThan(DISTANCE * 0.5);
});

function Pair({ x, offset }: { x: Curve; offset: number }) {
  const still = useRef<HTMLDivElement>(null);
  const moved = useRef<HTMLDivElement>(null);
  useBake(
    [x],
    (at) => [
      [still.current, { transform: `translateX(${x.get(at)}px)` }],
      [moved.current, { transform: `translateX(${x.get(at) + offset}px)` }],
    ],
    [offset],
  );
  return (
    <>
      <div ref={still} data-testid="still" />
      <div ref={moved} data-testid="moved" />
    </>
  );
}

it("leaves an element playing when a mid-flight re-bake does not change its journey", async () => {
  const x = new Curve(0);
  const view = render(<Pair x={x} offset={0} />);
  const still = view.getByTestId("still");
  const moved = view.getByTestId("moved");

  x.tween(DISTANCE, { duration: 2, ease: "linear" });
  await afterFlush();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const [playing] = still.getAnimations();
  const [before] = moved.getAnimations();

  // Restarting the unchanged element would hold it at the main thread's "now"
  // for a frame while the compositor had already drawn it further on.
  act(() => view.rerender(<Pair x={x} offset={1} />));

  expect(still.getAnimations()).toHaveLength(1);
  expect(still.getAnimations()[0]).toBe(playing);
  expect(moved.getAnimations()).toHaveLength(1);
  expect(moved.getAnimations()[0]).not.toBe(before);
});
