import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LanguageProvider } from "../../i18n/LanguageContext";
import { PlayerOverlay } from "./PlayerOverlay";

function overlay(props: { isPlaying: boolean; loading: boolean; pending?: boolean }) {
  return (
    <MemoryRouter>
      <LanguageProvider>
        <PlayerOverlay
          title="Example"
          backTo="/movies/example"
          visible
          isPlaying={props.isPlaying}
          isPlayPauseLoading={props.loading}
          isPlayPausePending={props.pending ?? false}
          onTogglePlay={vi.fn()}
          chrome="sahne"
        />
      </LanguageProvider>
    </MemoryRouter>
  );
}

describe("PlayerOverlay in Sahne", () => {
  it("shows the loading mark in the middle and nothing else", () => {
    const view = render(overlay({ isPlaying: true, loading: true }));
    expect(view.queryByTestId("player-loading-state")).toBeInTheDocument();
    expect(view.queryByTestId("player-play-pause-state")).not.toBeInTheDocument();
  });

  it("never draws play or pause there, paused, playing or waiting", () => {
    for (const isPlaying of [true, false]) {
      const view = render(overlay({ isPlaying, loading: false, pending: true }));
      expect(view.queryByTestId("player-play-pause-state")).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("does not draw play or pause while the mark leaves", () => {
    const view = render(overlay({ isPlaying: true, loading: true }));
    view.rerender(overlay({ isPlaying: true, loading: false }));
    expect(view.queryByTestId("player-play-pause-state")).not.toBeInTheDocument();
  });
});
