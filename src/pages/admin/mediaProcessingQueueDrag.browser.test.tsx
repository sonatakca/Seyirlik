/**
 * The queue reorder gesture, in a real browser, on the real page.
 *
 * jsdom can prove that the model and the page agree; it cannot prove the thing
 * the operator complained about, because it has no layout and no pointer. Here
 * the cards have the heights the stylesheet actually gives them, the mouse is
 * a real mouse held down across several moves, and the assertions are the ones
 * you would make while watching over somebody's shoulder: the row you are
 * holding is the row that moves, nothing is left behind in its old slot, the
 * list rearranges before you let go, and what it showed you is what is saved.
 *
 * Chromium and WebKit both, because the gesture is pointer events and a
 * transform, and Safari is where this project's operators actually are.
 */

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { commands, page, userEvent } from "vitest/browser";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProcessingJob,
  ProcessingOverview,
} from "../../lib/processingApi";
import { MAGNET_GIVE } from "./queueDragModel";

// The page's real stylesheet: without it these cards have no borders, no gap
// and no heights, and a geometry test against a stack of bare list items
// would be measuring something the operator never sees.
import "../../index.css";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key, language: "en" }),
}));

/*
 * Only the three calls the Titles tab makes are stubbed. The rest of the
 * module is left alone: this is a real browser loading real modules, and a
 * mock that dropped an export would break whoever else imports it.
 */
vi.mock("../../lib/mediaApi", async () => ({
  ...(await vi.importActual<typeof import("../../lib/mediaApi")>(
    "../../lib/mediaApi",
  )),
  getUserViews: async () => [],
  getVideoItemsForLibrary: async () => [],
  getPrimaryImageUrl: () => "",
}));

vi.mock("../../lib/notifications/notificationStore", () => ({
  notify: vi.fn(),
}));

const reorderProcessingQueue = vi.fn(async () => ({ reordered: [] }));
let overview: ProcessingOverview;

vi.mock("../../lib/processingApi", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/processingApi")
  >("../../lib/processingApi");
  return {
    ...actual,
    getProcessingOverview: async () => overview,
    previewProcessing: async () => {
      throw new Error("no preview in this suite");
    },
    getProcessingJob: async () => null,
    reorderProcessingQueue: (...args: unknown[]) =>
      reorderProcessingQueue(...(args as [])),
  };
});

// ------------------------------------------------------------- fixtures

function job(overrides: Partial<ProcessingJob> & { id: string }) {
  return {
    itemId: `${overrides.id}-item`,
    mediaFileId: `${overrides.id}-file`,
    profile: "cmaf-hls-aligned-v2",
    state: "queued",
    stage: "waiting",
    stageProgress: 0,
    overallProgress: 0,
    bytesProcessed: 0,
    actualOutputBytes: 0,
    outputBytes: null,
    estimatedOutputBytes: null,
    estimatedStagingBytes: null,
    speed: null,
    fps: null,
    etaSeconds: null,
    hardwareAdapter: null,
    videoEncoder: null,
    decision: null,
    validation: null,
    warnings: [],
    sourceDamage: null,
    errorCode: null,
    errorMessage: null,
    publishedVersion: null,
    attempts: 0,
    cancellationRequested: false,
    pauseRequested: false,
    pausedReason: null,
    epochCount: null,
    epochIndex: null,
    completedEpochs: 0,
    protectedSeconds: 0,
    encodedSeconds: 0,
    sourceDurationSeconds: null,
    epochStartSeconds: null,
    epochEndSeconds: null,
    queuePriority: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as ProcessingJob;
}

/**
 * One encode underway and four waiting, one of which is being held by the
 * storage guard and so carries an extra panel. That card is taller than the
 * others on purpose: a queue of identical rows would let a model that assumes
 * a fixed row height pass this suite.
 */
const QUEUE: ProcessingJob[] = [
  job({ id: "encoding", state: "running", startedAt: "2026-09-01T01:00:00Z" }),
  job({ id: "alpha", queuePriority: 100 }),
  job({
    id: "bravo",
    queuePriority: 101,
    pauseRequested: true,
    pausedReason: "storage-unavailable",
  }),
  job({ id: "charlie", queuePriority: 102 }),
  job({ id: "delta", queuePriority: 103 }),
];

function baseOverview(jobs: ProcessingJob[]): ProcessingOverview {
  return {
    jobs,
    storage: null,
    incidents: [],
    capacity: null,
    jobTitles: jobs.map((entry) => ({
      jobId: entry.id,
      kind: "movie" as const,
      title: entry.id,
    })),
  } as unknown as ProcessingOverview;
}

const WAITING = ["alpha", "bravo", "charlie", "delta"];

// -------------------------------------------------------------- helpers

function titleOf(row: HTMLElement): string {
  return within(row).getAllByText(/^[a-z]+$/)[0]?.textContent ?? "";
}

function waitingRows(): HTMLElement[] {
  return screen.getAllByRole("listitem").filter((row) => row.dataset.queueSlot);
}

/** The waiting rows in the order the queue says they are in, right now. */
function slotOrder(): string[] {
  return [...waitingRows()]
    .sort((a, b) => Number(a.dataset.queueSlot) - Number(b.dataset.queueSlot))
    .map(titleOf);
}

/** The waiting rows in the order they are actually painted, top to bottom. */
function paintedOrder(): string[] {
  return waitingRows()
    .map((row) => ({
      title: titleOf(row),
      top: row.getBoundingClientRect().top,
    }))
    .sort((a, b) => a.top - b.top)
    .map((entry) => entry.title);
}

function rowFor(title: string): HTMLElement {
  return waitingRows().find((row) => titleOf(row) === title)!;
}

function handleFor(title: string): HTMLElement {
  // Either label: a row that is part of a selection says so on its handle,
  // because what the press would move is no longer only that row.
  return within(rowFor(title)).getByRole("button", {
    name: /queueOrder\.(handle|groupHandle)/,
  });
}

function centreOf(element: Element): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

function rectOf(title: string): DOMRect {
  return rowFor(title).getBoundingClientRect();
}

/** How far two rows are drawn on top of each other, in pixels. */
function overlapOf(a: string, b: string): number {
  const left = rectOf(a);
  const right = rectOf(b);
  return Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
}

/**
 * Waits until a row has stopped moving, however fast the browser is drawing.
 *
 * A fixed pause was what this used to be, and it made the suite a frame-rate
 * test by accident: the gesture is time-based and converges in a fifth of a
 * second at sixty frames a second, but a headless WebKit animating at five
 * frames a second had barely started by then. Reading the row until it holds
 * still asserts the same thing — the card arrives — without assuming how many
 * frames the browser took to get it there.
 */
async function atRest(title: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  let previous = Number.NaN;
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const top = rectOf(title).top;
    stable = Math.abs(top - previous) < 0.5 ? stable + 1 : 0;
    previous = top;
    if (stable >= 2) return;
  }
}

let Page: typeof import("./MediaProcessingPage").MediaProcessingPage;

async function openQueue() {
  await page.viewport(1400, 1000);
  render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>,
  );
  await screen.findByText("processing.title");
  await userEvent.click(
    await screen.findByRole("tab", { name: /tabs.processes/ }),
  );
  await waitFor(() => expect(slotOrder()).toEqual(WAITING));
  // The whole queue in view, so a drag never runs into an edge and starts the
  // page scrolling underneath itself.
  rowFor("alpha").scrollIntoView({ block: "start" });
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Presses the handle of a row and moves the mouse, without letting go. */
async function pickUp(title: string, toY: number) {
  const grip = centreOf(handleFor(title));
  await commands.pointer("move", grip.x, grip.y);
  await commands.pointer("down");
  // A small first step, so the activation threshold is a threshold rather
  // than something the first event jumps straight over.
  await commands.pointer("move", grip.x, grip.y + 6);
  await commands.pointer("move", grip.x, toY);
}

beforeEach(async () => {
  overview = baseOverview(QUEUE);
  reorderProcessingQueue.mockClear();
  Page = (await import("./MediaProcessingPage")).MediaProcessingPage;
  await openQueue();
});

afterEach(async () => {
  await commands.pointer("up");
  cleanup();
});

describe("dragging a queued encode with a real mouse", () => {
  it("has built a queue of cards that are not all the same height", () => {
    // The fixture's premise, asserted rather than assumed: the card held by
    // the storage guard carries an extra panel and is taller than the rest.
    const heights = waitingRows().map(
      (row) => row.getBoundingClientRect().height,
    );
    expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights) + 8);
    expect(rowFor("bravo").getBoundingClientRect().height).toBe(
      Math.max(...heights),
    );
  });

  it("rearranges the list under the cursor and saves what it showed", async () => {
    await pickUp("alpha", centreOf(rowFor("charlie")).y);

    // Still held — and the queue already reads the way the drop will leave it.
    // Awaited only for the browser's own delivery of the move: nothing here
    // waits on an animation, and the button is still down throughout.
    await waitFor(() =>
      expect(slotOrder()).toEqual(["bravo", "charlie", "alpha", "delta"]),
    );
    // The card settles into the slot rather than appearing in it, so this is
    // awaited: a card that arrived instantly would have had to teleport.
    await waitFor(() =>
      expect(paintedOrder()).toEqual(["bravo", "charlie", "alpha", "delta"]),
    );
    expect(reorderProcessingQueue).not.toHaveBeenCalled();

    // One card in one place: nothing was copied, so nothing is left behind.
    expect(
      waitingRows().filter((row) => titleOf(row) === "alpha"),
    ).toHaveLength(1);
    expect(rowFor("alpha").style.opacity).toBe("");

    await commands.pointer("up");
    await waitFor(() =>
      expect(reorderProcessingQueue).toHaveBeenCalledWith([
        "bravo",
        "charlie",
        "alpha",
        "delta",
      ]),
    );
    await waitFor(() =>
      expect(paintedOrder()).toEqual(["bravo", "charlie", "alpha", "delta"]),
    );
    expect(reorderProcessingQueue).toHaveBeenCalledTimes(1);
  });

  it("lands the card where it was let go of, not from somewhere else", async () => {
    /*
     * The complaint this test is named after: on release the card flew in
     * from the top of the list. The drop moves the row in the DOM and unwinds
     * every transform in the same breath, and the landing used to be played
     * from the gesture's *arithmetic* — where the model thought the card was —
     * so any disagreement between that and the layout became a card arriving
     * from a place it had never been drawn.
     *
     * The claim here is the strongest one available and it needs no clock: the
     * card is already sitting in its slot when the button is released, so from
     * that moment until it comes to rest it can never be drawn more than the
     * magnet's own slack away from where the hand left it.
     */
    await pickUp("alpha", centreOf(rowFor("charlie")).y);
    await atRest("alpha");
    const released = rectOf("alpha").top;

    await commands.pointer("up");

    let worst = 0;
    for (let sample = 0; sample < 12; sample += 1) {
      worst = Math.max(worst, Math.abs(rectOf("alpha").top - released));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await atRest("alpha");
    worst = Math.max(worst, Math.abs(rectOf("alpha").top - released));
    expect(worst).toBeLessThan(MAGNET_GIVE + 8);

    // ...and the list it landed in is the list it was showing.
    expect(paintedOrder()).toEqual(["bravo", "charlie", "alpha", "delta"]);
    // Nothing is left holding a transform of its own: a row still carrying one
    // is a row that will jump the next time React writes to it.
    for (const row of waitingRows()) expect(row.style.transform).toBe("");
  });

  it("walks slot by slot, and back, while the button stays down", async () => {
    const grip = centreOf(handleFor("alpha"));
    await commands.pointer("move", grip.x, grip.y);
    await commands.pointer("down");

    await commands.pointer("move", grip.x, grip.y + 8);
    expect(slotOrder()).toEqual(WAITING);

    await commands.pointer("move", grip.x, centreOf(rowFor("bravo")).y);
    await waitFor(() =>
      expect(slotOrder()).toEqual(["bravo", "alpha", "charlie", "delta"]),
    );

    await commands.pointer("move", grip.x, centreOf(rowFor("delta")).y);
    await waitFor(() =>
      expect(slotOrder()).toEqual(["bravo", "charlie", "delta", "alpha"]),
    );

    await commands.pointer("move", grip.x, grip.y + 8);
    await waitFor(() => expect(slotOrder()).toEqual(WAITING));

    await commands.pointer("up");
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });

  it("keeps the held card in the queue's own column", async () => {
    const before = centreOf(rowFor("alpha")).x;
    const grip = centreOf(handleFor("alpha"));
    await commands.pointer("move", grip.x, grip.y);
    await commands.pointer("down");
    await commands.pointer("move", grip.x + 400, grip.y + 60);

    // The pointer went 400px to the right; the card did not follow it there.
    // It only lifts, which is symmetrical about the column it belongs to.
    expect(centreOf(rowFor("alpha")).x).toBeCloseTo(before, 0);
    await commands.pointer("up");
  });

  it("scrolls the page when the card is held against the bottom edge", async () => {
    // The queue is longer than the window, and a card dragged to the bottom of
    // it has to be able to keep going.
    expect(document.documentElement.scrollHeight).toBeGreaterThan(
      window.innerHeight,
    );
    window.scrollTo(0, 0);
    const before = window.scrollY;

    const grip = centreOf(handleFor("alpha"));
    await commands.pointer("move", grip.x, grip.y);
    await commands.pointer("down");
    await commands.pointer("move", grip.x, grip.y + 20);
    await commands.pointer("move", grip.x, window.innerHeight - 12);

    // Held at the edge, the page keeps going until there is nowhere left: the
    // card is on its way to the end of a queue it cannot see all of.
    await waitFor(() => expect(window.scrollY).toBeGreaterThan(before), {
      timeout: 5000,
    });
    // ...and the card went with the page rather than being left behind by it.
    await waitFor(() => expect(slotOrder().at(-1)).toBe("alpha"), {
      timeout: 5000,
    });
    await commands.pointer("up");
  });

  it("puts everything back when the drag is abandoned", async () => {
    await pickUp("delta", centreOf(rowFor("alpha")).y);
    await waitFor(() =>
      expect(slotOrder()).toEqual(["delta", "alpha", "bravo", "charlie"]),
    );

    await userEvent.keyboard("{Escape}");
    await commands.pointer("up");

    expect(slotOrder()).toEqual(WAITING);
    await waitFor(() => expect(paintedOrder()).toEqual(WAITING));
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });

  it("sits the held card in the gap the list opened for it", async () => {
    /*
     * The regression this whole change exists for. The order being previewed
     * was always right; the card was drawn wherever the pointer had dragged
     * it, so the list opened a gap in one place and the card hung in another,
     * across the title of the row below. What the operator saw was a card
     * floating over a queue rather than a card in a queue.
     */
    const grip = centreOf(handleFor("alpha"));
    await commands.pointer("move", grip.x, grip.y);
    await commands.pointer("down");
    await commands.pointer("move", grip.x, grip.y + 8);
    await commands.pointer("move", grip.x, centreOf(rowFor("bravo")).y);
    await atRest("alpha");

    expect(slotOrder()).toEqual(["bravo", "alpha", "charlie", "delta"]);

    /*
     * The card is in the space that opened between the two rows either side of
     * it, rather than somewhere between that space and the pointer. The few
     * pixels of slack are the magnet's give: the card answers the hand holding
     * it without leaving the slot.
     */
    const held = rectOf("alpha");
    expect(held.top).toBeGreaterThan(rectOf("bravo").bottom - 20);
    expect(held.bottom).toBeLessThan(rectOf("charlie").top + 20);

    // ...and so it covers no part of the cards around it that can be read.
    for (const other of ["bravo", "charlie", "delta"]) {
      expect(overlapOf("alpha", other)).toBeLessThan(20);
    }

    await commands.pointer("up");
  });

  it("keeps the held card off its neighbours all the way down the queue", async () => {
    // The same claim, made continuously rather than at one convenient stop:
    // no position of the pointer leaves the card sitting across another card's
    // text. A card crossing between two slots passes through quickly, so the
    // worst moment is still a small fraction of a card.
    const grip = centreOf(handleFor("alpha"));
    await commands.pointer("move", grip.x, grip.y);
    await commands.pointer("down");
    await commands.pointer("move", grip.x, grip.y + 8);

    const start = grip.y;
    const span = centreOf(rowFor("delta")).y - start;
    let worst = 0;
    for (let step = 1; step <= 24; step += 1) {
      await commands.pointer("move", grip.x, start + (span * step) / 24);
      await atRest("alpha");
      const held = rectOf("alpha");
      for (const other of ["bravo", "charlie", "delta"]) {
        worst = Math.max(worst, overlapOf("alpha", other));
      }
      // The card never leaves the column, and never leaves the list either.
      expect(held.height).toBeGreaterThan(0);
    }
    /*
     * The number that made this change necessary. Drawn at the bare pointer,
     * the held card sat across more than half of its neighbour at every
     * boundary — two cards' worth of statistics on top of each other. Held to
     * its slot, the worst moment of the whole gesture is a sliver of the
     * lifted card's own edge.
     */
    expect(worst).toBeLessThan(20);

    await commands.pointer("up");
  });

  it("carries a whole selection when one of its rows is dragged", async () => {
    /*
     * The group gesture. A backlog is queued a season at a time and the rows
     * that need moving are rarely next to each other, so a drag that could
     * only ever carry one of them was a drag nobody used for the job it was
     * built for.
     *
     * Two rows with another between them, picked up by the lower of the two:
     * the block gathers under the hand rather than the list opening a gap in
     * two places, and what the drop saves is both of them, in the order the
     * queue had them.
     */
    await userEvent.click(
      within(rowFor("alpha")).getByRole("checkbox", {
        name: /queueOrder.select/,
      }),
    );
    await userEvent.click(
      within(rowFor("charlie")).getByRole("checkbox", {
        name: /queueOrder.select/,
      }),
    );

    await pickUp("charlie", centreOf(rowFor("delta")).y);
    await atRest("charlie");

    // Gathered: the two carried rows are drawn as one block, with nothing of
    // the list between them.
    const alpha = rectOf("alpha");
    const charlie = rectOf("charlie");
    expect(charlie.top - alpha.bottom).toBeGreaterThan(0);
    expect(charlie.top - alpha.bottom).toBeLessThan(24);

    await waitFor(() =>
      expect(slotOrder()).toEqual(["bravo", "delta", "alpha", "charlie"]),
    );

    await commands.pointer("up");
    await waitFor(() =>
      expect(reorderProcessingQueue).toHaveBeenCalledWith([
        "bravo",
        "delta",
        "alpha",
        "charlie",
      ]),
    );
    await waitFor(() =>
      expect(paintedOrder()).toEqual(["bravo", "delta", "alpha", "charlie"]),
    );
  });

  it("still carries one row when the one grabbed is not in the selection", async () => {
    // A selection standing must not turn every drag into a group drag: the
    // row under the hand is the row that moves unless it is part of the group.
    await userEvent.click(
      within(rowFor("alpha")).getByRole("checkbox", {
        name: /queueOrder.select/,
      }),
    );
    await userEvent.click(
      within(rowFor("bravo")).getByRole("checkbox", {
        name: /queueOrder.select/,
      }),
    );

    await pickUp("delta", centreOf(rowFor("charlie")).y);
    await waitFor(() =>
      expect(slotOrder()).toEqual(["alpha", "bravo", "delta", "charlie"]),
    );

    await commands.pointer("up");
    await waitFor(() =>
      expect(reorderProcessingQueue).toHaveBeenCalledWith([
        "alpha",
        "bravo",
        "delta",
        "charlie",
      ]),
    );
  });

  it("does not move the queue when a row is selected", async () => {
    /*
     * Ticking a box changed the height of the bar above the list — the
     * selection's own controls are taller than the button they replace — and
     * every card below shifted down a few pixels. Selecting a row is a
     * statement about that row, and it has no business moving the one the
     * operator is reading.
     */
    /*
     * With the bar itself in view. Scrolled past it, the browser's own scroll
     * anchoring quietly absorbs a change in the height of something above the
     * viewport — the one case where this cannot be seen, and the opposite of
     * the operator's, who is looking straight at it.
     */
    window.scrollTo(0, 0);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const before = waitingRows().map((row) => row.getBoundingClientRect().top);

    await userEvent.click(
      within(rowFor("alpha")).getByRole("checkbox", {
        name: /queueOrder.select/,
      }),
    );
    // The bar has actually changed: without this the assertion below could
    // pass on a page where nothing happened at all.
    await screen.findByRole("button", { name: /queueOrder.groupToTop/ });

    const after = waitingRows().map((row) => row.getBoundingClientRect().top);
    expect(after).toEqual(before);
  });

  it("treats a click on the handle as a click", async () => {
    await userEvent.click(handleFor("bravo"));

    expect(slotOrder()).toEqual(WAITING);
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
    // The press still puts the keyboard on the handle: the arrows move the
    // row for anybody who is not using a mouse at all.
    expect(document.activeElement).toBe(handleFor("bravo"));
  });

  it("leaves the buttons on the cards alone", async () => {
    await userEvent.click(
      within(rowFor("charlie")).getByRole("button", {
        name: "processing.inspect",
      }),
    );

    expect(slotOrder()).toEqual(WAITING);
    expect(reorderProcessingQueue).not.toHaveBeenCalled();
  });
});

describe("dragging in a queue longer than the page draws", () => {
  /** Letters only, because rows are found by an all-letter title. */
  const name = (n: number) =>
    `long${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`;
  const LONG = Array.from({ length: 55 }, (_, n) => name(n));

  it("saves the undrawn tail behind the rows it moved", async () => {
    cleanup();
    overview = baseOverview(
      LONG.map((id, n) => job({ id, queuePriority: 100 + n })),
    );
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    );
    await userEvent.click(
      await screen.findByRole("tab", { name: /tabs.processes/ }),
    );
    await waitFor(() => expect(waitingRows()).toHaveLength(50));
    rowFor(LONG[0]!).scrollIntoView({ block: "start" });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    await pickUp(LONG[0]!, centreOf(rowFor(LONG[2]!)).y);
    await waitFor(() =>
      expect(slotOrder().slice(0, 3)).toEqual([LONG[1], LONG[2], LONG[0]]),
    );
    await commands.pointer("up");

    await waitFor(() =>
      expect(reorderProcessingQueue).toHaveBeenCalledWith([
        LONG[1],
        LONG[2],
        LONG[0],
        ...LONG.slice(3),
      ]),
    );
  });
});
