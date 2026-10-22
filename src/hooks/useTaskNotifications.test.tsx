import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTaskNotifications } from "./useTaskNotifications";
import {
  dismissAllNotifications,
  getNotificationHistory,
  getNotifications,
  holdNotificationClocks,
  resetNotificationsForTests,
} from "../lib/notifications/notificationStore";
import type { TaskDto } from "../api/ownApi/dto";
const getTasks = vi.fn();
const t = (key: string) => key;
vi.mock("../lib/mediaApi", () => ({
  getTaskObservation: async (since?: string) => {
    const observedAt = new Date().toISOString();
    return { tasks: await getTasks(since), observedAt };
  },
}));
vi.mock("../i18n/LanguageContext", () => ({ useLanguage: () => ({ t }) }));
const task: TaskDto = {
  id: "a",
  type: "media.probe",
  status: "running",
  progress: 0.42,
  progressMessage: "Analysed 42 of 100 files",
  attempts: 1,
  maxAttempts: 3,
  result: null,
  error: null,
  queuedAt: "",
  startedAt: null,
  finishedAt: null,
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetNotificationsForTests();
  getTasks.mockReset();
});
it("restores current work, updates one card, and honors dismissal across polling", async () => {
  vi.useFakeTimers();
  getTasks.mockResolvedValue([task, { ...task, id: "old", status: "failed" }]);
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(getNotifications()).toHaveLength(1);
  const id = getNotifications()[0]?.id;
  getTasks.mockResolvedValue([{ ...task, progress: 0.5 }]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(getNotifications()[0]).toMatchObject({ id, progress: 50 });
  act(() => dismissAllNotifications());
  getTasks.mockResolvedValue([{ ...task, progress: 0.6 }]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(getNotifications()).toHaveLength(0);
});

const processing = (
  id: string,
  status: TaskDto["status"],
  queuedAt: string,
): TaskDto => ({
  ...task,
  id,
  type: "media.process",
  status,
  progress: 0,
  progressMessage: null,
  attempts: 0,
  queuedAt,
});

it("raises one card for the whole waiting line and keeps its count current", async () => {
  // The server encodes one title at a time, so a dozen queued episodes are one
  // waiting line — reporting each of them produced a column of identical cards
  // that named none of them.
  vi.useFakeTimers();
  getTasks.mockResolvedValue([
    processing("run", "running", "2026-09-05T09:00:00Z"),
    processing("q1", "queued", "2026-09-05T09:01:00Z"),
    processing("q2", "queued", "2026-09-05T09:02:00Z"),
    processing("q3", "queued", "2026-09-05T09:03:00Z"),
  ]);
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(getNotifications()).toHaveLength(1);
  expect(getNotifications()[0]?.task?.queuedCount).toBe(3);
  const id = getNotifications()[0]?.id;

  // The line shortening is news the same card carries, without becoming a
  // second one.
  getTasks.mockResolvedValue([
    processing("run", "running", "2026-09-05T09:00:00Z"),
    processing("q1", "queued", "2026-09-05T09:01:00Z"),
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(getNotifications()).toHaveLength(1);
  expect(getNotifications()[0]).toMatchObject({ id, task: { queuedCount: 1 } });
});

it("still reports a queued title that fails on its own", async () => {
  // Being counted by the lead's card is not the same as being silenced: an
  // outcome has a name, a duration and a reason that no count can carry.
  vi.useFakeTimers();
  getTasks.mockResolvedValue([
    processing("run", "running", "2026-09-05T09:00:00Z"),
    processing("q1", "queued", "2026-09-05T09:01:00Z"),
  ]);
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(getNotifications()).toHaveLength(1);

  getTasks.mockResolvedValue([
    processing("run", "running", "2026-09-05T09:00:00Z"),
    { ...processing("q1", "failed", "2026-09-05T09:01:00Z"), attempts: 3 },
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(getNotifications()).toHaveLength(2);
  expect(getNotifications()[0]?.task?.status).toBe("failed");
});

it("keeps one card when a whole line is held, and leads with what runs next", async () => {
  /*
   * "Pause all" on eighteen episodes. Holding a queued title ends its queue
   * attempt as `succeeded` carrying a cancelled result, so the queue alone
   * showed eighteen finished titles: eighteen cards, every one of them saying
   * "Cancelled", led by the last in the line rather than the next to run.
   */
  vi.useFakeTimers();
  const queued = (id: string, at: string) => processing(id, "queued", at);
  getTasks.mockResolvedValue([
    queued("e09", "2026-09-05T09:01:00Z"),
    queued("e10", "2026-09-05T09:02:00Z"),
    queued("e11", "2026-09-05T09:03:00Z"),
  ]);
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(getNotifications()).toHaveLength(1);

  const held = (id: string, at: string) => ({
    ...processing(id, "succeeded", at),
    result: { status: "cancelled" },
    presentation: { determinate: false, outcome: "paused" as const },
  });
  getTasks.mockResolvedValue([
    held("e09", "2026-09-05T09:01:00Z"),
    held("e10", "2026-09-05T09:02:00Z"),
    held("e11", "2026-09-05T09:03:00Z"),
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  const cards = getNotifications();
  expect(cards).toHaveLength(1);
  // The next title to run, not the last one in the line.
  expect(cards[0]?.task).toMatchObject({ status: "paused", queuedCount: 2 });
  expect(cards[0]?.task?.status).not.toBe("cancelled");
});

it("takes back a card once the lead starts answering for it", async () => {
  // A title that raised its own card and then joined the line behind the lead
  // must stop being a card; the lead already counts it.
  vi.useFakeTimers();
  getTasks.mockResolvedValue([
    processing("q1", "running", "2026-09-05T09:01:00Z"),
  ]);
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(getNotifications()).toHaveLength(1);

  getTasks.mockResolvedValue([
    processing("run", "running", "2026-09-05T09:00:00Z"),
    processing("q1", "queued", "2026-09-05T09:01:00Z"),
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(getNotifications()).toHaveLength(1);
  expect(getNotifications()[0]?.task?.queuedCount).toBe(1);

  // And it is a card again the moment it reaches the head of the line: the
  // dismissal must not be remembered as "the viewer closed this one".
  getTasks.mockResolvedValue([
    { ...processing("run", "succeeded", "2026-09-05T09:00:00Z") },
    processing("q1", "running", "2026-09-05T09:01:00Z"),
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(
    getNotifications().filter((card) => card.task?.status === "running"),
  ).toHaveLength(1);
});

it.each([10, 20])(
  "observes ultra-fast work at second %s across a failed poll without replaying history or duplicating cards",
  async (second) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T10:00:00.000Z"));
    const old = {
      ...task,
      id: "old",
      status: "succeeded",
      finishedAt: "2026-09-05T10:00:00.000Z",
    } as TaskDto;
    getTasks
      .mockResolvedValueOnce([old])
      .mockRejectedValueOnce(new Error("offline"));
    renderHook(() => useTaskNotifications(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getNotifications()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    const completed: TaskDto = {
      ...task,
      id: "fast",
      type: "library.rename",
      status: "succeeded",
      queuedAt: `2026-09-06T10:00:${second}.000Z`,
      finishedAt: `2026-09-06T10:00:${second}.005Z`,
      result: { mode: "off", disabled: true },
    };
    getTasks.mockResolvedValue([old, { ...old, id: "old-page" }, completed]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(getTasks).toHaveBeenLastCalledWith("2026-09-06T10:00:00.000Z");
    // What was raised, not what is still live: a notice now runs out its own
    // life in the store, whether or not anything shows it.
    expect(getNotificationHistory()).toHaveLength(1);
    const card = getNotificationHistory()[0];
    expect(card).toMatchObject({
      tone: "warning",
      task: { outcome: "organize-disabled", status: "succeeded" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(getNotificationHistory()).toHaveLength(1);
    expect(getNotificationHistory()[0]?.id).toBe(card?.id);
  },
);

it("invalidates immediately and follows an in-flight baseline with a fresh read", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T10:00:00.000Z"));
  let finish!: (tasks: TaskDto[]) => void;
  getTasks.mockReturnValueOnce(
    new Promise<TaskDto[]>((resolve) => {
      finish = resolve;
    }),
  );
  const completed: TaskDto = {
    ...task,
    type: "library.rename",
    status: "succeeded",
    queuedAt: "2026-09-06T10:00:00.001Z",
    finishedAt: "2026-09-06T10:00:00.005Z",
  };
  getTasks.mockResolvedValue([completed]);
  const { unmount } = renderHook(() => useTaskNotifications(true));
  const { signalTasksChanged } = await import("../lib/tasksChanged");
  await act(async () => {
    signalTasksChanged();
    signalTasksChanged();
  });
  expect(getTasks).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish([]);
  });
  expect(getTasks).toHaveBeenCalledTimes(2);
  expect(getNotifications()).toHaveLength(1);
  await act(async () => {
    signalTasksChanged();
  });
  expect(getTasks).toHaveBeenCalledTimes(3);
  expect(getNotifications()).toHaveLength(1);
  unmount();
  signalTasksChanged();
  expect(getTasks).toHaveBeenCalledTimes(3);
});

it("keeps the half-minute download handoff to one card, and only when it did something", async () => {
  // The server hands finished downloads to the importer every thirty seconds.
  // A card per run was a fresh "done" every thirty seconds, stacking up for a
  // job that had found nothing to hand over.
  vi.useFakeTimers();
  // Held, as an open notification centre holds them, so what was shown stays
  // to be counted across two minutes of runs.
  holdNotificationClocks(true);
  let run = 0;
  let started = 0;
  const handoff = (): TaskDto => ({
    ...task,
    id: `handoff-${run}`,
    type: "import.handoff",
    status: "succeeded",
    progress: 1,
    progressMessage: null,
    result: { started, refused: 0 },
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  getTasks.mockImplementation(async () => (run > 0 ? [handoff()] : []));
  renderHook(() => useTaskNotifications(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  for (run = 1; run <= 3; run += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
  }
  expect(getNotifications()).toHaveLength(0);

  started = 1;
  for (; run <= 5; run += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
  }
  expect(getNotifications()).toHaveLength(1);
});
