import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FrameCaptureToast } from "./FrameCaptureToast";

const t = (key: string) => key;

describe("the save-frame toast", () => {
  it("names the time while saving", () => {
    render(
      <FrameCaptureToast
        capture={{ id: 1, status: "saving", atSeconds: 1013.2 }}
        leaving={false}
        onRetry={() => {}}
        t={t}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "player.saveFrameSaving16:53 · player.saveFrameFullResolution",
    );
  });

  it("shows the saved file with its real size once it has loaded", () => {
    const { container } = render(
      <FrameCaptureToast
        capture={{
          id: 2,
          status: "saved",
          atSeconds: 1013.2,
          imageUrl: "blob:frame",
        }}
        leaving={false}
        onRetry={() => {}}
        t={t}
      />,
    );
    const print = container.querySelector("img")!;
    expect(print).toHaveAttribute("src", "blob:frame");
    expect(screen.getByRole("status")).toHaveTextContent(/16:53$/);

    Object.defineProperty(print, "naturalWidth", { value: 1920 });
    Object.defineProperty(print, "naturalHeight", { value: 800 });
    fireEvent.load(print);

    expect(screen.getByRole("status")).toHaveTextContent("16:53 · 1920 × 800");
  });

  it("offers to try again after a failure, without reaching the player", () => {
    const onRetry = vi.fn();
    const onPlayerClick = vi.fn();
    render(
      <div onClick={onPlayerClick}>
        <FrameCaptureToast
          capture={{ id: 3, status: "failed", atSeconds: 10 }}
          leaving={false}
          onRetry={onRetry}
          t={t}
        />
      </div>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "player.saveFrameRetry" }),
    );

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onPlayerClick).not.toHaveBeenCalled();
  });
});
