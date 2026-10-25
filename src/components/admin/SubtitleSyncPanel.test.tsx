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
});
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
      "library.syncApplied: Obsession (2023).tur.srt · library.syncEarlier 14.56 s · library.syncConfidence 77%",
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
