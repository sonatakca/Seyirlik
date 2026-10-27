import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clearCachedSession, setAuthSession } from "./authStorage";
import {
  PLAYBACK_DETAILS_STORAGE_KEY,
  setPlaybackDetailsEnabled,
  useShowPlaybackDetails,
} from "./playbackDetailsVisibility";

function signIn(isAdministrator: boolean) {
  setAuthSession({ userId: "u1", username: "viewer", isAdministrator });
}

afterEach(() => {
  clearCachedSession();
  window.localStorage.removeItem(PLAYBACK_DETAILS_STORAGE_KEY);
});

describe("playback details visibility", () => {
  it("never shows the details to someone who is not an administrator", () => {
    signIn(false);
    setPlaybackDetailsEnabled(true);

    const { result } = renderHook(() => useShowPlaybackDetails());

    expect(result.current).toBe(false);
  });

  it("shows them to an administrator until switched off, then follows the switch", () => {
    signIn(true);
    const { result } = renderHook(() => useShowPlaybackDetails());

    expect(result.current).toBe(true);

    act(() => setPlaybackDetailsEnabled(false));
    expect(result.current).toBe(false);

    act(() => setPlaybackDetailsEnabled(true));
    expect(result.current).toBe(true);
  });
});
