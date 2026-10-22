import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { HeroSection } from "../HeroSection";
import { NotificationHost } from "./NotificationHost";
import {
  notify,
  resetNotificationsForTests,
} from "../../lib/notifications/notificationStore";
import "../../index.css";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  resetNotificationsForTests();
  window.scrollTo(0, 0);
});

/**
 * The carousel control and the notification pile, in the same corner, moving.
 *
 * They are laid out by two components that cannot see each other — the control
 * renders into a portal on `document.body`, the pile is mounted by the app
 * shell — and they agree on the corner only through the reservation in
 * `lib/layout/bottomChrome`. That agreement holds trivially while both are
 * still. What it has to survive is the second in which one of them is arriving
 * or leaving and the other is travelling the lane it freed or took, which is
 * the only moment either can be laid out through the other.
 *
 * So this is sampled every frame across both transitions rather than asserted
 * at the two ends. A pair of boxes that miss each other before and after a
 * movement tells you nothing about the movement.
 */
interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const boxOf = (element: Element): Box => {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
  };
};

/**
 * How far apart two boxes are, in pixels — negative when they overlap.
 *
 * Boxes that miss each other horizontally cannot collide however their
 * vertical spans line up, so the horizontal clearance counts as separation in
 * its own right and the wider of the two gaps is the answer.
 */
function clearance(a: Box, b: Box): number {
  const vertical = Math.max(a.top - b.bottom, b.top - a.bottom);
  const horizontal = Math.max(a.left - b.right, b.left - a.right);
  return Math.max(vertical, horizontal);
}

/** Every frame's worth of geometry for the length of a movement. */
async function sampleFrames(
  read: () => { control: Box; pile: Box } | null,
  forMs: number,
) {
  const frames: { at: number; control: Box; pile: Box; gap: number }[] = [];
  const started = performance.now();
  await new Promise<void>((resolve) => {
    /*
     * Read at the end of each frame, once every frame callback has run. The
     * pile is moved by a compositor animation, which a read during the frame
     * already sees at this frame's time; the control is written by
     * framer-motion's own frame callback, which can run after this one, so a
     * read inside the frame could see the control a frame behind the pile and
     * report a gap that was never painted.
     */
    const tick = () => setTimeout(atFrameEnd, 0);
    const atFrameEnd = () => {
      const reading = read();
      if (reading)
        frames.push({
          at: performance.now() - started,
          ...reading,
          gap: clearance(reading.control, reading.pile),
        });
      if (performance.now() - started >= forMs) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return frames;
}

function renderCorner() {
  return render(
    <MemoryRouter>
      {/* The control hides itself a third of a viewport past the banner, so the
          page has to be genuinely scrollable for the transition to exist. */}
      <div style={{ height: "400vh" }}>
        <HeroSection
          variant="carousel"
          totalItems={3}
          currentIndex={0}
          enablePreview={false}
        />
      </div>
      <NotificationHost />
    </MemoryRouter>,
  );
}

/*
 * The clearance the control reserves above itself, from `HeroSection`. The
 * pair is never closer than this — not at rest, and not on any frame of either
 * transition — so the assertion is the design's own number rather than the
 * weaker "they did not actually collide".
 */
const CLEARANCE_PX = 12;

it.each([
  [1440, 900],
  [1280, 800],
  [390, 844],
])(
  "keeps the corner's two occupants apart at %s by %s",
  async (width, height) => {
    await page.viewport(width, height);
    renderCorner();
    act(() => {
      notify({
        title: "Encoding House of the Dragon",
        description: "Second of His Name",
        tone: "error",
        life: "persistent",
      });
    });

    const control = () =>
      document.querySelector<HTMLElement>(
        "[data-hero-carousel-indicators] > div",
      );
    const pile = () =>
      document.querySelector<HTMLElement>("[data-notification-list]");
    const read = () => {
      const bar = control();
      const cards = pile();
      return bar && cards ? { control: boxOf(bar), pile: boxOf(cards) } : null;
    };

    await waitFor(() => {
      expect(control()).not.toBeNull();
      expect(pile()).not.toBeNull();
    });
    // Both at rest, both on screen, and the pile already standing on the strip
    // the control reserved.
    /*
     * Settled, not merely present: the control enters from below the viewport,
     * so a reading taken while it is still climbing is a frame of the entrance
     * and clears the pile only because it has not arrived yet.
     */
    const settle = async () => {
      let previous = read()!;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        const current = read()!;
        if (
          Math.abs(current.control.top - previous.control.top) < 0.01 &&
          Math.abs(current.pile.top - previous.pile.top) < 0.01
        )
          return current;
        previous = current;
      }
    };
    const atRest = await settle();
    expect(atRest.control.bottom).toBeLessThanOrEqual(height);
    expect(atRest.pile.bottom).toBeLessThanOrEqual(atRest.control.top);

    /*
     * Down past the limit: the control leaves, the pile takes the lane back.
     * Sampled well past the second the movement runs for, so the frames cover
     * the settle at the far end as well as the travel.
     */
    window.scrollTo({ top: height * 2, behavior: "instant" as ScrollBehavior });
    const leaving = await sampleFrames(read, 1_800);

    // Back up: the control returns, the pile gets out of its way.
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    const arriving = await sampleFrames(read, 1_800);

    const worst = (frames: typeof leaving) =>
      frames.reduce(
        (lowest, frame) => (frame.gap < lowest.gap ? frame : lowest),
        frames[0],
      );

    // Reported rather than only asserted: a run that passes by a hair is worth
    // seeing in the output, and a run that fails names the frame it failed on.
    const report = (label: string, frames: typeof leaving) => {
      const low = worst(frames);
      return `${label}: ${frames.length} frames, closest ${low.gap.toFixed(1)}px at ${low.at.toFixed(0)}ms (control ${low.control.top.toFixed(0)}–${low.control.bottom.toFixed(0)}, pile ${low.pile.top.toFixed(0)}–${low.pile.bottom.toFixed(0)})`;
    };
    const summary = `${report("leaving", leaving)} | ${report("arriving", arriving)}`;

    expect(leaving.length, summary).toBeGreaterThan(20);
    expect(arriving.length, summary).toBeGreaterThan(20);
    // Sub-pixel slack only: the two are never nearer than the strip the control
    // reserves, on any frame of either direction.
    expect(worst(leaving).gap, summary).toBeGreaterThan(CLEARANCE_PX - 1);
    expect(worst(arriving).gap, summary).toBeGreaterThan(CLEARANCE_PX - 1);
    // Surfaced on success too, so the margin is visible rather than implied.
    console.log(`[bottom-chrome overlap] ${summary}`);
  },
);
