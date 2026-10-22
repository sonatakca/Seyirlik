import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LanguageProvider } from "../../i18n/LanguageContext";
import { PlayerOverlay } from "./PlayerOverlay";

describe("PlayerOverlay", () => {
  it("cross-fades from the loading ring back to the play/pause control", async () => {
    const view = render(
      <MemoryRouter>
        <LanguageProvider>
          <PlayerOverlay
            title="Example"
            backTo="/movies/example"
            visible={false}
            isPlaying
            isPlayPauseLoading
            onTogglePlay={vi.fn()}
          />
        </LanguageProvider>
      </MemoryRouter>,
    );

    const centerControl = view.container.querySelector(
      ".seyirlik-player-center-toggle",
    );

    expect(centerControl).toHaveClass("bg-transparent");
    expect(
      centerControl?.querySelector("md-circular-progress[indeterminate]"),
    ).toBeInTheDocument();
    expect(centerControl?.querySelector("img")).not.toBeInTheDocument();
    expect(
      centerControl?.querySelector("svg.lucide-loader-circle"),
    ).not.toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <LanguageProvider>
          <PlayerOverlay
            title="Example"
            backTo="/movies/example"
            visible
            isPlaying
            onTogglePlay={vi.fn()}
          />
        </LanguageProvider>
      </MemoryRouter>,
    );

    expect(view.getByTestId("player-loading-state")).toBeInTheDocument();
    expect(view.getByTestId("player-play-pause-state")).toBeInTheDocument();

    await waitFor(() => {
      expect(
        view.queryByTestId("player-loading-state"),
      ).not.toBeInTheDocument();
    });

    view.rerender(
      <MemoryRouter>
        <LanguageProvider>
          <PlayerOverlay
            title="Example"
            backTo="/movies/example"
            visible
            isPlaying
            isPlayPauseLoading
            onTogglePlay={vi.fn()}
          />
        </LanguageProvider>
      </MemoryRouter>,
    );

    expect(view.getByTestId("player-play-pause-state")).toBeInTheDocument();
    expect(view.getByTestId("player-loading-state")).toBeInTheDocument();

    await waitFor(() => {
      expect(
        view.queryByTestId("player-play-pause-state"),
      ).not.toBeInTheDocument();
    });
  });
});
