import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SubtitleSyncTracks } from "../../lib/libraryAdminApi";
import { SubtitleSyncPanel } from "./SubtitleSyncPanel";

const api = vi.hoisted(() => ({
  getSubtitleSyncTracks: vi.fn(),
  syncTitleSubtitle: vi.fn(),
  getSubtitleSyncTask: vi.fn(),
  applyReviewedSubtitleSync: vi.fn(),
  getSubtitleRevisions: vi.fn(),
  restoreSubtitleRevision: vi.fn(),
  compareSubtitleRevisions: vi.fn(),
}));
vi.mock("../../lib/libraryAdminApi", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/libraryAdminApi")>()),
  ...api,
}));
vi.mock("../../lib/tasksChanged", () => ({ signalTasksChanged: vi.fn() }));
vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

const ID = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";

const tracks: SubtitleSyncTracks = {
  mediaFileId: "f",
  subtitles: [
    {
      streamIndex: 2,
      language: "eng",
      title: null,
      forced: false,
      external: false,
      fileName: null,
      retimable: false,
    },
    {
      streamIndex: 5,
      language: "tur",
      title: null,
      forced: false,
      external: true,
      fileName: "Obsession (2023).tur.srt",
      retimable: true,
    },
    {
      streamIndex: 6,
      language: "eng",
      title: null,
      forced: false,
      external: true,
      fileName: "Obsession (2023).eng.srt",
      retimable: true,
    },
  ],
  audio: [
    {
      streamIndex: 1,
      language: "eng",
      title: null,
      codec: "eac3",
      channels: 6,
      isDefault: true,
    },
  ],
};

const optionValues = (select: HTMLElement) =>
  [...(select as HTMLSelectElement).options].map((option) => option.value);

async function open() {
  render(<SubtitleSyncPanel itemId={ID} onSynced={onSynced} />);
  fireEvent.click(screen.getByRole("button", { name: "library.syncSubtitle" }));
  return {
    target: await screen.findByLabelText("library.syncTarget"),
    reference: () => screen.getByLabelText("library.syncReference"),
  };
}

const onSynced = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  api.getSubtitleSyncTracks.mockResolvedValue(tracks);
  api.syncTitleSubtitle.mockResolvedValue({ taskId: TASK });
  api.applyReviewedSubtitleSync.mockResolvedValue({ taskId: APPLY_TASK });
  api.restoreSubtitleRevision.mockResolvedValue({ taskId: APPLY_TASK });
  api.getSubtitleRevisions.mockResolvedValue({
    fileName: "Obsession (2023).tur.srt",
    revisions: [
      {
        id: "rev-2",
        revision: 2,
        origin: "sync",
        state: "committed",
        sha256: "b",
        sizeBytes: 10,
        parentId: "rev-1",
        failure: null,
        createdAt: "2026-10-25T22:00:00Z",
        settledAt: "2026-10-25T22:00:00Z",
      },
      {
        id: "rev-1",
        revision: 1,
        origin: "original",
        state: "committed",
        sha256: "a",
        sizeBytes: 10,
        parentId: null,
        failure: null,
        createdAt: "2026-10-25T21:00:00Z",
        settledAt: "2026-10-25T21:00:00Z",
      },
    ],
  });
});

const APPLY_TASK = "33333333-3333-4333-8333-333333333333";

/** A proposal with one late region and a scene this version does not have. */
const PARTIAL = {
  outcome: "analysed",
  fileName: "Obsession (2023).tur.srt",
  referenceKind: "audio",
  referenceLabel: "the eng audio",
  cueCount: 4,
  subtitleSha256: "c".repeat(64),
  revisionId: null,
  needsReview: true,
  reviewReasons: [],
  offsetSeconds: -8,
  rate: 1,
  confidence: 0.8,
  droppedCues: 0,
  clampedCues: 0,
  excludedCues: 0,
  alignment: {
    verdict: "partial",
    autoApplicable: false,
    coverage: 0.75,
    counts: {
      aligned: 1,
      corrected: 2,
      inferred: 0,
      unresolved: 0,
      unmatched: 1,
    },
    placedAtEdits: 0,
    rate: 1,
    reference: "speech",
    anchorCount: 1,
    segments: [
      {
        status: "aligned",
        firstCue: 0,
        lastCue: 0,
        sourceStartSeconds: 10,
        sourceEndSeconds: 12,
        rate: 1,
        offsetSeconds: 0,
        cueCount: 1,
        matchedCues: 1,
        confidence: 0.9,
      },
      {
        status: "corrected",
        firstCue: 2,
        lastCue: 3,
        sourceStartSeconds: 100,
        sourceEndSeconds: 112,
        rate: 1,
        offsetSeconds: -8,
        cueCount: 2,
        matchedCues: 2,
        confidence: 0.8,
      },
    ],
    breakpoints: [
      {
        afterSourceSeconds: 12,
        beforeSourceSeconds: 100,
        kind: "removed",
        seconds: 8,
      },
    ],
    cues: [
      {
        index: 0,
        disposition: "aligned",
        sourceStartSeconds: 10,
        sourceEndSeconds: 12,
        startSeconds: 10,
        endSeconds: 12,
        text: "Bir",
      },
      {
        index: 1,
        disposition: "unmatched",
        sourceStartSeconds: 50,
        sourceEndSeconds: 52,
        startSeconds: 50,
        endSeconds: 52,
        text: "Kesilen sahne",
      },
      {
        index: 2,
        disposition: "corrected",
        sourceStartSeconds: 100,
        sourceEndSeconds: 102,
        startSeconds: 92,
        endSeconds: 94,
        text: "Sen benim kardeşimsin.",
      },
      {
        index: 3,
        disposition: "corrected",
        sourceStartSeconds: 110,
        sourceEndSeconds: 112,
        startSeconds: 102,
        endSeconds: 104,
        text: "Dört",
      },
    ],
    anchors: [
      {
        cueIndex: 2,
        mediaSeconds: 92.1,
        weight: 1.5,
        cueText: "Sen benim kardeşimsin.",
        spokenText: "You're my sister.",
        similarity: 0.9,
        margin: 0.2,
        support: 2,
      },
    ],
  },
};
afterEach(() => {
  vi.useRealTimers();
});

it("offers only files beside the video as targets, Turkish first", async () => {
  const { target } = await open();
  expect(optionValues(target)).toEqual(["5", "6"]);
  expect((target as HTMLSelectElement).value).toBe("5");
});

it("never offers the target as its own reference", async () => {
  const { target, reference } = await open();
  expect(optionValues(reference())).toEqual(["2", "6"]);
  // The English subtitle that came with the release is the default reference.
  expect((reference() as HTMLSelectElement).value).toBe("2");
  fireEvent.change(target, { target: { value: "6" } });
  expect(optionValues(reference())).toEqual(["2", "5"]);
});

it("switches the reference list to the audio tracks", async () => {
  const { reference } = await open();
  fireEvent.click(screen.getByLabelText("library.syncAgainstAudio"));
  expect(optionValues(reference())).toEqual(["1"]);
  expect(screen.getByText("library.syncAudioSlow")).toBeTruthy();
});

it("runs one sync at a time and reports what it did", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.getSubtitleSyncTask
    .mockResolvedValueOnce({
      taskId: TASK,
      status: "running",
      message: "Listening to the audio",
      result: null,
    })
    .mockResolvedValueOnce({
      taskId: TASK,
      status: "succeeded",
      message: null,
      result: {
        outcome: "applied",
        fileName: "Obsession (2023).tur.srt",
        referenceKind: "subtitle",
        referenceLabel: "the eng subtitle",
        offsetSeconds: -14.561,
        rate: 0.999996,
        confidence: 0.765,
        matchedCues: 960,
        consideredCues: 1388,
        cueCount: 1388,
        droppedCues: 0,
        clampedCues: 0,
      },
    });
  await open();
  const start = screen.getAllByRole("button", { name: /library.syncSubtitle/ });
  const run = start[start.length - 1] as HTMLButtonElement;
  fireEvent.click(run);
  await waitFor(() =>
    expect(api.syncTitleSubtitle).toHaveBeenCalledWith(ID, {
      targetStreamIndex: 5,
      reference: { kind: "subtitle", streamIndex: 2 },
    }),
  );
  await waitFor(() => expect(run.disabled).toBe(true));

  await act(() => vi.advanceTimersByTimeAsync(2_100));
  expect(await screen.findByText("Listening to the audio")).toBeTruthy();
  expect(run.disabled).toBe(true);

  await act(() => vi.advanceTimersByTimeAsync(2_100));
  expect(
    await screen.findByText(
      // A strength above chance is not a probability, so none is shown.
      "library.syncApplied: Obsession (2023).tur.srt · library.syncEarlier 14.56 s",
    ),
  ).toBeTruthy();
  expect(onSynced).toHaveBeenCalledTimes(1);
  expect(run.disabled).toBe(false);
  expect(api.syncTitleSubtitle).toHaveBeenCalledTimes(1);
});

it("applies a shift typed by hand, with a comma, and claims no confidence", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.getSubtitleSyncTask.mockResolvedValue({
    taskId: TASK,
    status: "succeeded",
    message: null,
    result: {
      outcome: "applied",
      fileName: "Obsession (2023).tur.srt",
      referenceKind: "subtitle",
      referenceLabel: "a correction given by hand",
      offsetSeconds: -5,
      rate: 1,
      confidence: 1,
      matchedCues: 0,
      consideredCues: 1388,
      cueCount: 1388,
      droppedCues: 0,
      clampedCues: 0,
    },
  });
  await open();
  fireEvent.change(screen.getByLabelText("library.syncManual"), {
    target: { value: "-5,0" },
  });
  const start = screen.getAllByRole("button", { name: /library.syncSubtitle/ });
  const run = start[start.length - 1] as HTMLButtonElement;
  fireEvent.click(run);
  await waitFor(() =>
    expect(api.syncTitleSubtitle).toHaveBeenCalledWith(ID, {
      targetStreamIndex: 5,
      reference: { kind: "subtitle", streamIndex: 2 },
      offsetSeconds: -5,
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(2_100));
  expect(
    await screen.findByText(
      "library.syncApplied: Obsession (2023).tur.srt · library.syncEarlier 5.00 s",
    ),
  ).toBeTruthy();
  expect(onSynced).toHaveBeenCalledTimes(1);
});

it("shows a proposal that needs a look, and applies exactly that preview when asked", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.getSubtitleSyncTask.mockResolvedValue({
    taskId: TASK,
    status: "succeeded",
    message: null,
    result: PARTIAL,
  });
  await open();
  const start = screen.getAllByRole("button", { name: /library.syncSubtitle/ });
  const run = start[start.length - 1] as HTMLButtonElement;
  fireEvent.click(run);
  await waitFor(() => expect(run.disabled).toBe(true));
  await act(() => vi.advanceTimersByTimeAsync(2_100));

  expect(await screen.findByText("library.syncVerdictPartial")).toBeTruthy();
  expect(screen.getByText("library.syncNeedsReview")).toBeTruthy();
  // Nothing was written, so nothing reloads.
  expect(onSynced).not.toHaveBeenCalled();
  // The late part, with the line matched by what is said.
  fireEvent.click(screen.getByRole("button", { name: "1:40–1:52" }));
  expect(screen.getByText("You're my sister.")).toBeTruthy();

  fireEvent.click(screen.getByLabelText("library.syncUnmatchedExclude"));
  fireEvent.click(
    screen.getByRole("button", { name: "library.syncApplyProposal" }),
  );
  await waitFor(() =>
    expect(api.applyReviewedSubtitleSync).toHaveBeenCalledWith(ID, {
      previewTaskId: TASK,
      unmatched: "exclude",
    }),
  );
});

it("previews without writing", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: /library.syncPreview/ }));
  await waitFor(() =>
    expect(api.syncTitleSubtitle).toHaveBeenCalledWith(ID, {
      targetStreamIndex: 5,
      reference: { kind: "subtitle", streamIndex: 2 },
      dryRun: true,
    }),
  );
});

it("lists the file's versions and restores an earlier one", async () => {
  await open();
  fireEvent.click(screen.getByText("library.revisions"));
  expect(await screen.findByText("library.revisionOriginal")).toBeTruthy();
  expect(api.getSubtitleRevisions).toHaveBeenCalledWith(ID, 5);
  // The current version cannot be restored over itself; the original can.
  const restore = screen.getAllByRole("button", {
    name: /library.revisionRestoreAction/,
  });
  expect(restore).toHaveLength(1);
  fireEvent.click(restore[0] as HTMLButtonElement);
  await waitFor(() =>
    expect(api.restoreSubtitleRevision).toHaveBeenCalledWith(ID, "rev-1", 5),
  );
});

it("will not start with a shift that is not a number", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("library.syncManual"), {
    target: { value: "five" },
  });
  const start = screen.getAllByRole("button", { name: /library.syncSubtitle/ });
  expect((start[start.length - 1] as HTMLButtonElement).disabled).toBe(true);
});

it("shows a refusal in the server's words and reloads nothing", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.getSubtitleSyncTask.mockResolvedValue({
    taskId: TASK,
    status: "succeeded",
    message: null,
    result: {
      outcome: "refused",
      failure: "unconvincing",
      reason:
        "This subtitle and that reference do not look like the same film; nothing was changed.",
    },
  });
  await open();
  const start = screen.getAllByRole("button", { name: /library.syncSubtitle/ });
  const run = start[start.length - 1] as HTMLButtonElement;
  fireEvent.click(run);
  await waitFor(() => expect(run.disabled).toBe(true));
  await act(() => vi.advanceTimersByTimeAsync(2_100));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "do not look like the same film",
  );
  expect(onSynced).not.toHaveBeenCalled();
});

it("says so when a film has no subtitle file to correct", async () => {
  api.getSubtitleSyncTracks.mockResolvedValue({
    ...tracks,
    subtitles: [tracks.subtitles[0]],
  });
  render(<SubtitleSyncPanel itemId={ID} onSynced={onSynced} />);
  fireEvent.click(screen.getByRole("button", { name: "library.syncSubtitle" }));
  expect(await screen.findByText("library.syncNoTarget")).toBeTruthy();
  expect(screen.queryByLabelText("library.syncTarget")).toBeNull();
});
