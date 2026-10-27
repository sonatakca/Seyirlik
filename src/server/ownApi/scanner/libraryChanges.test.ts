// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import type { EnqueueOptions, JobRecord } from "../tasks/jobQueue";
import { createLibraryChangeMonitor } from "./libraryChanges";

function fixture() {
  let active: JobRecord | null = null;
  const files = new Map([["Movies/Film.mkv", { size: 100, mtimeMs: 1 }]]);
  const libraries = {
    listAll: vi.fn(async () => [
      {
        id: "movies",
        slug: "movies",
        name: "Movies",
        kind: "movies" as const,
        roots: ["Movies"],
      },
      {
        id: "series",
        slug: "series",
        name: "Series",
        kind: "series" as const,
        roots: ["Series"],
      },
    ]),
  };
  const queue = {
    findActive: vi.fn(
      async ({ payload }: { payload: Record<string, unknown> }) =>
        active?.payload.libraryId === payload.libraryId ? active : null,
    ),
    enqueue: vi.fn(async (options: EnqueueOptions) => {
      active = {
        id: String(Math.random()),
        status: "queued",
        payload: options.payload,
      } as JobRecord;
      return active.id;
    }),
    get: vi.fn(async () => active),
  };
  const contents = new Map<string, string>();
  let unavailable = false;
  const fs = {
    readDirectory: async (root: string) => {
      if (unavailable) throw new Error("unavailable");
      return [...files.keys()]
        .filter((file) => file.startsWith(root + "/"))
        .map((file) => ({
          name: file.slice(root.length + 1),
          isDirectory: false,
        }));
    },
    statFile: async (file: string) => files.get(file)!,
    readTextFile: async (file: string) => contents.get(file) ?? "",
  };
  const close = vi.fn();
  const watch = vi.fn(
    () => Object.assign(new EventEmitter(), { close }) as unknown as FSWatcher,
  );
  const monitor = createLibraryChangeMonitor({
    mediaRoot: "/media",
    libraries,
    queue,
    fileSystem: fs,
    watch: watch as never,
  });
  return {
    monitor,
    queue,
    files,
    contents,
    watch,
    close,
    setActive: (job: JobRecord | null) => {
      active = job;
    },
    unavailable: (next: boolean) => {
      unavailable = next;
    },
  };
}
describe("library file changes", () => {
  it("queues only the affected class as soon as an operation commits", async () => {
    const f = fixture();
    await f.monitor.notifyPath("Series/Arcane/Season 1/file.tr.srt");
    expect(f.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ libraryId: "series" }),
        dedupeKey: "library.scan:series",
      }),
    );
    expect(f.queue.enqueue).toHaveBeenCalledTimes(1);
    await f.monitor.close();
  });
  it("keeps a change pending while a scan is running, then queues a fresh scan", async () => {
    const f = fixture();
    f.setActive({
      id: "old",
      status: "running",
      payload: { libraryId: "movies" },
    } as unknown as JobRecord);
    await f.monitor.notifyPath("Movies/Film.tr.srt");
    expect(f.queue.enqueue).not.toHaveBeenCalled();
    f.setActive(null);
    await f.monitor.flush();
    expect(f.queue.enqueue).toHaveBeenCalledTimes(1);
    await f.monitor.flush();
    expect(f.queue.enqueue).toHaveBeenCalledTimes(1);
    await f.monitor.close();
  });
  it("coalesces changes into a scan that has not started yet", async () => {
    const f = fixture();
    await f.monitor.notifyPath("Movies/Film.tr.srt");
    await f.monitor.notifyPath("Movies/Film.en.srt");
    expect(f.queue.enqueue).toHaveBeenCalledTimes(1);
    await f.monitor.close();
  });
  it("notices a file update even if the mount delivers no watch event", async () => {
    const f = fixture();
    await f.monitor.poll();
    f.queue.enqueue.mockClear();
    f.setActive(null);
    await f.monitor.poll();
    expect(f.queue.enqueue).not.toHaveBeenCalled();
    f.files.set("Movies/Film.mkv", { size: 100, mtimeMs: 2 });
    await f.monitor.poll();
    expect(f.queue.enqueue).toHaveBeenCalledTimes(1);
    await f.monitor.close();
    expect(f.close).toHaveBeenCalledTimes(2);
  });
  it("notices subtitle edits even when size and mtime are preserved", async () => {
    const f = fixture();
    f.files.set("Movies/Film.tr.srt", { size: 20, mtimeMs: 1 });
    f.contents.set("Movies/Film.tr.srt", "old timings");
    await f.monitor.poll();
    f.queue.enqueue.mockClear();
    f.setActive(null);
    f.contents.set("Movies/Film.tr.srt", "new timings");
    await f.monitor.poll();
    expect(f.queue.enqueue).toHaveBeenCalledTimes(1);
    await f.monitor.close();
  });
  it("does not turn an unreadable mount into an empty-library change", async () => {
    const f = fixture();
    await f.monitor.poll();
    f.queue.enqueue.mockClear();
    f.setActive(null);
    f.unavailable(true);
    await f.monitor.poll();
    expect(f.queue.enqueue).not.toHaveBeenCalled();
    f.unavailable(false);
    await f.monitor.poll();
    expect(f.queue.enqueue).not.toHaveBeenCalled();
    await f.monitor.close();
  });
  it("ignores its own staging and backup writes", async () => {
    const f = fixture();
    await f.monitor.notifyPath("Movies/.seyirlik/state/backup.srt");
    await f.monitor.notifyPath(".seyirlik/state/subtitle-rewrites/before");
    expect(f.queue.enqueue).not.toHaveBeenCalled();
    await f.monitor.close();
  });
  it("retries a failed enqueue rather than dropping the change", async () => {
    const f = fixture();
    f.queue.enqueue.mockRejectedValueOnce(new Error("database offline"));
    await f.monitor.notifyPath("Movies/Film.tr.srt");
    await f.monitor.flush();
    expect(f.queue.enqueue).toHaveBeenCalledTimes(2);
    await f.monitor.close();
  });
});
