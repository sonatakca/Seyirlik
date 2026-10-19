import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryTitle } from "../../lib/libraryAdminApi";
import {
  getNotifications,
  resetNotificationsForTests,
} from "../../lib/notifications/notificationStore";
import { onTitleRemoved, startTitleRemoval } from "./titleRemovalProgress";

const api = vi.hoisted(() => ({
  removeLibraryTitle: vi.fn(),
  getTitleRemoval: vi.fn(),
}));
vi.mock("../../lib/libraryAdminApi", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/libraryAdminApi")>()),
  ...api,
}));

const t = (key: string) => key;
const film = {
  id: "film",
  title: "Apes",
  sizeBytes: 12.7 * 1024 ** 3,
} as LibraryTitle;
const report = (
  state: "removing" | "deleting" | "done" | "failed",
  extra: { leftovers?: string[]; failure?: "busy" } = {},
) => ({
  itemId: "film",
  title: "Apes",
  folder: "Movies/Apes (2011)",
  state,
  filesRemoved: state === "done" ? 3 : 0,
  downloadsCancelled: 0,
  leftovers: extra.leftovers ?? [],
  ...(extra.failure ? { failure: extra.failure } : {}),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetNotificationsForTests();
});
afterEach(() => vi.useRealTimers());

it("follows a removal from the answer to what was deleted", async () => {
  api.removeLibraryTitle.mockResolvedValue(report("removing"));
  api.getTitleRemoval
    .mockResolvedValueOnce(report("removing"))
    .mockResolvedValueOnce(report("deleting"))
    .mockResolvedValueOnce(report("done"));
  const removed = vi.fn();
  const stop = onTitleRemoved(removed);
  await startTitleRemoval(film, "Apes", t).result;
  expect(getNotifications()[0]).toMatchObject({
    tone: "progress",
    description: "library.removalCommitting",
  });
  await vi.advanceTimersByTimeAsync(2_000);
  // Still listed until the catalogue has let go.
  expect(removed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(removed).toHaveBeenCalledWith("film");
  expect(getNotifications()[0]).toMatchObject({
    tone: "progress",
    description: "library.removalDeleting 12.7 GB",
  });
  await vi.advanceTimersByTimeAsync(2_000);
  stop();
  expect(removed).toHaveBeenCalledTimes(1);
  expect(getNotifications()).toHaveLength(1);
  expect(getNotifications()[0]).toMatchObject({
    tone: "success",
    title: "library.removed Apes",
    description: "library.removalDeleted 12.7 GB",
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(api.getTitleRemoval).toHaveBeenCalledTimes(3);
});

it("says so when the server refuses after answering, and keeps the title", async () => {
  api.removeLibraryTitle.mockResolvedValue(report("removing"));
  api.getTitleRemoval.mockResolvedValue(report("failed", { failure: "busy" }));
  const removed = vi.fn();
  const stop = onTitleRemoved(removed);
  await startTitleRemoval(film, "Apes", t).result;
  await vi.advanceTimersByTimeAsync(2_000);
  stop();
  expect(removed).not.toHaveBeenCalled();
  expect(getNotifications()[0]).toMatchObject({
    tone: "error",
    title: "library.removalFailedTitle Apes",
    description: "library.removeBusy",
  });
});

it("names what could not be deleted", async () => {
  api.removeLibraryTitle.mockResolvedValue(report("deleting"));
  api.getTitleRemoval.mockResolvedValue(
    report("done", { leftovers: ["Movies/.seyirlik-removing-film"] }),
  );
  await startTitleRemoval(film, "Apes", t).result;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(getNotifications()[0]).toMatchObject({
    tone: "error",
    description: "library.removedWithLeftovers Movies/.seyirlik-removing-film",
  });
});

it("does not claim the files are gone when the server forgot the removal", async () => {
  api.removeLibraryTitle.mockResolvedValue(report("deleting"));
  api.getTitleRemoval.mockResolvedValue(null);
  await startTitleRemoval(film, "Apes", t).result;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(getNotifications()[0]).toMatchObject({
    tone: "success",
    description: "library.removalUnknown",
  });
});

it("does not claim a removal the server forgot before the catalogue let go", async () => {
  api.removeLibraryTitle.mockResolvedValue(report("removing"));
  api.getTitleRemoval.mockResolvedValue(null);
  await startTitleRemoval(film, "Apes", t).result;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(getNotifications()[0]).toMatchObject({
    tone: "warning",
    description: "library.removalInterrupted",
  });
});

it("reports a refusal on the card once the dialog was hidden", async () => {
  api.removeLibraryTitle.mockRejectedValue(
    Object.assign(new Error("busy"), { code: "REMOVAL_BUSY" }),
  );
  const removal = startTitleRemoval(film, "Apes", t);
  removal.hide();
  await expect(removal.result).rejects.toThrow("busy");
  expect(getNotifications()).toHaveLength(1);
  expect(getNotifications()[0]).toMatchObject({
    tone: "error",
    title: "library.removalFailedTitle Apes",
    description: "library.removeBusy",
  });
});

it("leaves a refusal to the dialog while it is still open", async () => {
  api.removeLibraryTitle.mockRejectedValue(
    Object.assign(new Error("busy"), { code: "REMOVAL_BUSY" }),
  );
  await expect(startTitleRemoval(film, "Apes", t).result).rejects.toThrow();
  expect(getNotifications()).toHaveLength(0);
});
