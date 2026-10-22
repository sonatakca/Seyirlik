import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNavbarScrolled } from "./useNavbarScrolled";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function scroll(top: number) {
  act(() => {
    vi.stubGlobal("scrollY", top);
    window.dispatchEvent(new Event("scroll"));
  });
}

it("changes state only after crossing the open or close threshold", () => {
  vi.stubGlobal("scrollY", 0);
  const { result } = renderHook(useNavbarScrolled);
  scroll(23);
  expect(result.current).toBe(false);
  scroll(24);
  expect(result.current).toBe(true);
  for (const top of [23, 17, 12, 9, 20]) {
    scroll(top);
    expect(result.current).toBe(true);
  }
  scroll(8);
  expect(result.current).toBe(false);
  scroll(16);
  expect(result.current).toBe(false);
  scroll(24);
  expect(result.current).toBe(true);
  scroll(-5);
  expect(result.current).toBe(false);
});

it("starts fully open at a restored scroll position", () => {
  vi.stubGlobal("scrollY", 32);
  const { result } = renderHook(useNavbarScrolled);
  expect(result.current).toBe(true);
});

it("removes its scroll listener when the navbar unmounts", () => {
  vi.stubGlobal("scrollY", 0);
  const remove = vi.spyOn(window, "removeEventListener");
  const { unmount } = renderHook(useNavbarScrolled);
  unmount();
  expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  remove.mockRestore();
});
