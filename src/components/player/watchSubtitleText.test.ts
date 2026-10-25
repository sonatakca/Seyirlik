import { afterEach, describe, expect, it, vi } from "vitest";
import { watchSubtitleText } from "./watchSubtitleText";
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("live subtitle corrections", () => {
  it("reloads changed sidecars without resetting unchanged cues", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let text = "old cues";
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, _options?: RequestInit) => ({
        ok: true,
        text: async () => text,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const onText = vi.fn();
    stop = watchSubtitleText({
      url: "/subtitle",
      refresh: true,
      onText,
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onText).toHaveBeenLastCalledWith("old cues");
    await vi.advanceTimersByTimeAsync(5000);
    expect(onText).toHaveBeenCalledTimes(1);
    text = "corrected cues";
    await vi.advanceTimersByTimeAsync(5000);
    expect(onText).toHaveBeenLastCalledWith("corrected cues");
    expect(fetch).toHaveBeenCalledWith(
      "/subtitle",
      expect.objectContaining({ cache: "no-store", credentials: "include" }),
    );
  });
  it("does not poll immutable/offline tracks and aborts reads on cleanup", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, _options?: RequestInit) => ({
        ok: true,
        text: async () => "cues",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    stop = watchSubtitleText({
      url: "/subtitle",
      refresh: false,
      onText: vi.fn(),
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = fetch.mock.calls[0]?.[1]?.signal as AbortSignal;
    stop();
    expect(signal.aborted).toBe(true);
  });
  it("keeps the last valid text through a failed refresh and recovers next time", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => "old" })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, text: async () => "new" });
    vi.stubGlobal("fetch", fetch);
    const onText = vi.fn(),
      onError = vi.fn();
    stop = watchSubtitleText({
      url: "/subtitle",
      refresh: true,
      onText,
      onError,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onText).toHaveBeenLastCalledWith("new");
  });
});
