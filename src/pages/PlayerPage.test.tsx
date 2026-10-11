import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mounts = vi.hoisted(() => ({ desktop: 0, mobile: 0 }));

vi.mock("./desktop/DesktopPlayerPage", async () => {
  const { useEffect } = await import("react");
  return {
    DesktopPlayerPage: () => {
      useEffect(() => {
        mounts.desktop += 1;
      }, []);
      return <p>desktop player</p>;
    },
  };
});
vi.mock("./mobile/MobilePlayerPage", async () => {
  const { useEffect } = await import("react");
  return {
    MobilePlayerPage: () => {
      useEffect(() => {
        mounts.mobile += 1;
      }, []);
      return <p>mobile player</p>;
    },
  };
});

import { PlayerPage } from "./PlayerPage";

/** A media query whose answer the test can flip, as a rotation does. */
function installViewport(initiallyNarrow: boolean) {
  let narrow = initiallyNarrow;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      media: query,
      get matches() {
        return narrow;
      },
      addEventListener: (_: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) =>
        listeners.delete(listener),
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => true,
    })),
  );
  return (nextNarrow: boolean) => {
    narrow = nextNarrow;
    for (const listener of listeners) listener();
  };
}

describe("the player page across a rotation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mounts.desktop = 0;
    mounts.mobile = 0;
  });

  it("keeps an upright iPad's player when it is turned on its side", async () => {
    const rotate = installViewport(true);
    render(<PlayerPage />);
    expect(await screen.findByText("mobile player")).toBeInTheDocument();

    await act(async () => rotate(false));
    await act(async () => rotate(true));
    await act(async () => rotate(false));

    expect(screen.getByText("mobile player")).toBeInTheDocument();
    expect(screen.queryByText("desktop player")).not.toBeInTheDocument();
    expect(mounts).toEqual({ desktop: 0, mobile: 1 });
  });

  it("keeps a landscape iPad's player when it is turned upright", async () => {
    const rotate = installViewport(false);
    render(<PlayerPage />);
    expect(await screen.findByText("desktop player")).toBeInTheDocument();

    await act(async () => rotate(true));

    expect(screen.getByText("desktop player")).toBeInTheDocument();
    expect(mounts).toEqual({ desktop: 1, mobile: 0 });
  });
});
