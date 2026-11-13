import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readStoredPlayerUi, storePlayerUi, usePlayerUi } from "./playerUi";

afterEach(() => {
  window.localStorage.removeItem("seyirlik:player-ui");
});

describe("player UI choice", () => {
  it("is classic until someone chooses", () => {
    expect(readStoredPlayerUi()).toBe("classic");
  });

  it("ignores anything it does not know", () => {
    window.localStorage.setItem("seyirlik:player-ui", "neon");
    expect(readStoredPlayerUi()).toBe("classic");
  });

  it("reaches a player that is already open", () => {
    const { result } = renderHook(() => usePlayerUi());
    expect(result.current[0]).toBe("classic");

    act(() => result.current[1]("sahne"));
    expect(result.current[0]).toBe("sahne");
    expect(readStoredPlayerUi()).toBe("sahne");

    act(() => storePlayerUi("classic"));
    expect(result.current[0]).toBe("classic");
  });
});
