import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaybackSourceCandidate } from "../../lib/types";
import { PlayerSettingsPanel } from "./PlayerSettingsPanel";
import type { CompleteFileQualityControls } from "./types";

vi.mock("../../i18n/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        "settings.settings": "Settings",
        "settings.track.surround": "Surround",
        "settings.track.hearing": "Hearing impaired",
        "settings.playbackOptions": "Playback options",
        "settings.quality": "Quality",
        "settings.audio": "Audio",
        "settings.subtitles": "Subtitles",
        "settings.currentSource": "Current source",
        "settings.auto": "Auto",
        "settings.currentQuality": "Current quality",
        "settings.hlsUpTo": "HLS · up to {mbps} Mbps",
        "settings.manualQuality": "Manual quality",
        "settings.noAlternateQualities": "No alternate qualities",
        "player.qualityLowData": "Low Data",
        "player.qualityLowDataDescription": "Uses less data",
        "player.qualityHigherResolution": "Higher Quality",
        "player.qualityHigherResolutionDescription": "Uses more data",
        "player.qualityAdvanced": "Advanced",
        "player.qualityBackToModes": "Quality modes",
        "player.qualityLockedTo": "Locked to {quality}",
        "player.qualityAutoEffective": "Auto ({quality})",
        "player.qualityFileAutoDescription":
          "Automatically chooses an existing file",
        "player.qualityCompleteFileLimitations":
          "Generated files carry the default audio track only.",
      })[key] ?? key,
  }),
}));

const source = {
  id: "quality-file-generated-720",
  mode: "DirectPlay",
  url: "https://media.example/720.mp4",
  mimeType: "video/mp4",
  isHls: false,
  label: "720p",
  mediaSource: {
    Id: "media-1",
    Container: "mp4",
    MediaStreams: [],
  },
} as unknown as PlaybackSourceCandidate;

function renderPanel(overrides: Partial<CompleteFileQualityControls> = {}) {
  const onSelectMode = vi.fn();
  const onSelectAdvancedQuality = vi.fn();

  render(
    <PlayerSettingsPanel
      source={source}
      qualityOptions={[]}
      selectedQualityId="auto"
      selectedSubtitleStreamIndex={-1}
      subtitleDelaySeconds={0}
      canSwitchAudio={false}
      canSwitchSubtitles={false}
      completeFileQuality={{
        activeMode: "auto",
        effectiveQualityLabel: "720p",
        modeQualityLabels: {
          "low-data": "480p",
          auto: "720p",
          "higher-resolution": "1080p",
        },
        advancedOptions: [
          {
            id: "generated-720",
            label: "720p",
            subtitle: "",
            maxHeight: 720,
            maxWidth: 1280,
            maxStreamingBitrate: 4_000_000,
          },
          {
            id: "original",
            label: "Original (2160p)",
            subtitle: "",
            maxHeight: 2160,
            maxWidth: 3840,
            maxStreamingBitrate: 80_000_000,
          },
        ],
        limitationsText: "Generated files carry the default audio track only.",
        onSelectMode,
        onSelectAdvancedQuality,
        ...overrides,
      }}
      onSelectAutoQuality={vi.fn()}
      onSelectQuality={vi.fn()}
      onSelectAudioStream={vi.fn()}
      onSelectSubtitleStream={vi.fn()}
      onSubtitleDelayChange={vi.fn()}
      compact
    />,
  );

  return { onSelectMode, onSelectAdvancedQuality };
}

describe("PlayerSettingsPanel complete-file qualities", () => {
  it("offers exactly the four top-level modes with their effective qualities", () => {
    renderPanel();

    expect(
      screen.getByRole("button", { name: /Low Data.*480p/s }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Auto \(720p\)/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Higher Quality.*1080p/s }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Advanced/ }),
    ).toBeInTheDocument();

    // Nothing repeats the current source or the effective quality twice.
    expect(
      screen.queryByText(/Current source|Now playing/),
    ).not.toBeInTheDocument();
    // The individual quality files stay behind the Advanced submenu.
    expect(screen.queryByText("Original (2160p)")).not.toBeInTheDocument();
    expect(screen.queryByText(/HLS/)).not.toBeInTheDocument();
  });

  it("reports the selected mode back to the player", () => {
    const { onSelectMode } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Low Data/ }));

    expect(onSelectMode).toHaveBeenCalledWith("low-data");
  });

  it("lists only the supplied files in Advanced and locks onto one", () => {
    const { onSelectAdvancedQuality } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));

    expect(screen.getByText("Original (2160p)")).toBeInTheDocument();
    expect(screen.getByText("720p")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.textContent)
        .slice(-3),
      // The 4K tag rides along in the accessible name; 720p earns no tag.
    ).toEqual(["Quality modes", "720p", "Original (2160p)4K"]);
    expect(screen.queryByText("480p")).not.toBeInTheDocument();
    // Entries carry no repeated boilerplate; the check mark marks the active one.
    expect(screen.queryByText("Complete file")).not.toBeInTheDocument();
    expect(screen.queryByText("Current quality")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Original \(2160p\)/ }));

    expect(onSelectAdvancedQuality).toHaveBeenCalledWith("original");
  });

  it("closes the Advanced submenu with Escape and restores focus", () => {
    renderPanel();

    const advancedButton = screen.getByRole("button", { name: /Advanced/ });
    fireEvent.click(advancedButton);
    expect(screen.getByText("Original (2160p)")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByText("Quality modes"), { key: "Escape" });

    expect(screen.queryByText("Original (2160p)")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Advanced/ })).toHaveFocus();
  });

  /**
   * The row names the rendition and nothing else. It is already the selected
   * one, under a heading that says Advanced, so wording like "Locked to" spent
   * a line repeating what the row's own state already shows.
   */
  it("names the chosen rendition under Advanced without extra wording", () => {
    renderPanel({ activeMode: "advanced", lockedQualityId: "generated-720" });

    const advanced = screen.getByRole("button", { name: /Advanced/ });
    expect(advanced.textContent).toContain("720p");
    expect(advanced.textContent).not.toContain("Locked to");
  });

  /**
   * The tag belongs on the first screen too, not only inside Advanced. That is
   * the view most people ever see, and it is where the rendition each mode
   * resolves to is shown.
   */
  it("tags the renditions the modes resolve to", () => {
    renderPanel();

    // Higher Quality resolves to 1080p here, so it is HD.
    const higher = screen.getByRole("button", { name: /Higher quality/i });
    expect(higher.textContent).toContain("HD");
    // Low Data resolves to 480p, which is not worth a tag.
    const lowData = screen.getByRole("button", { name: /Low data/i });
    expect(lowData.textContent).not.toContain("HD");
    expect(lowData.textContent).not.toContain("4K");
  });

  /**
   * The class tag streaming players show beside a rendition. It says something
   * the number does not — which tier this is — and only where that is worth
   * saying, so 720p and below carry none.
   */
  it("tags 4K and HD renditions and leaves the rest untagged", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));

    expect(
      screen.getByRole("button", { name: /Original \(2160p\)/ }).textContent,
    ).toContain("4K");
    expect(
      screen.getByRole("button", { name: /^720p/ }).textContent,
    ).not.toContain("HD");
  });
});

describe("PlayerSettingsPanel for a stored copy", () => {
  it("offers no quality, and opens on audio instead", () => {
    render(
      <PlayerSettingsPanel
        source={{ ...source, offline: true }}
        qualityOptions={[]}
        selectedQualityId="auto"
        selectedSubtitleStreamIndex={-1}
        subtitleDelaySeconds={0}
        canSwitchAudio
        canSwitchSubtitles
        onSelectAutoQuality={vi.fn()}
        onSelectQuality={vi.fn()}
        onSelectAudioStream={vi.fn()}
        onSelectSubtitleStream={vi.fn()}
        onSubtitleDelayChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Quality" })).toBeNull();
    expect(screen.queryByText("Auto")).toBeNull();
    expect(screen.getByRole("button", { name: "Audio" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Subtitles" }),
    ).toBeInTheDocument();
  });
});

describe("plain-language track selection", () => {
  it("shows short language names and still selects the original stream index", async () => {
    const onAudio = vi.fn();
    render(
      <PlayerSettingsPanel
        source={{
          ...source,
          offline: true,
          mediaSource: {
            ...source.mediaSource,
            MediaStreams: [
              {
                Index: 4,
                Type: "Audio",
                Language: "eng",
                Title: "TrueHD 5.1 eng",
                DisplayTitle: "TrueHD 5.1",
                Codec: "truehd",
                Channels: 6,
              },
              {
                Index: 9,
                Type: "Audio",
                Language: "eng",
                Title: "AC-3 5.1 eng",
                Codec: "ac3",
                Channels: 6,
              },
              {
                Index: 12,
                Type: "Subtitle",
                Language: "tur",
                Codec: "subrip",
                IsExternal: true,
              },
            ],
          },
        }}
        qualityOptions={[]}
        selectedQualityId="auto"
        selectedSubtitleStreamIndex={-1}
        subtitleDelaySeconds={0}
        canSwitchAudio
        canSwitchSubtitles
        onSelectAutoQuality={vi.fn()}
        onSelectQuality={vi.fn()}
        onSelectAudioStream={onAudio}
        onSelectSubtitleStream={vi.fn()}
        onSubtitleDelayChange={vi.fn()}
        compact
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^English · Surround 5\.1 \(2\)/ }),
    );
    expect(onAudio).toHaveBeenCalledWith(9);
    expect(screen.queryByText(/TrueHD|AC-3|ENG/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Subtitles$/ }));
    expect(
      await screen.findByRole("button", { name: /^Turkish/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/SUBRIP|External/)).toBeNull();
  });
});
