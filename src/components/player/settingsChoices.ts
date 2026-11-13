import type { TranslationKey } from "../../i18n/translations";
import { isVisibleSubtitleLanguage } from "../../lib/subtitleLanguages";
import type {
  MediaStream,
  PlaybackSourceCandidate,
} from "../../lib/types";
import type { AutomaticQualityMode } from "./types";

/*
 * What a viewer can choose in the player's settings: the tracks, once each,
 * and the automatic quality modes. Shared by the classic settings panel and
 * Sahne's lobby so both offer exactly the same choices.
 */

/** The audio or subtitle tracks a viewer can choose between, once each. */
export function getSelectableStreams(
  source: PlaybackSourceCandidate,
  type: "Audio" | "Subtitle",
): MediaStream[] {
  return getUniqueStreams(getStreamsOfType(source, type));
}

function getStreamsOfType(
  source: PlaybackSourceCandidate,
  type: "Audio" | "Subtitle",
): MediaStream[] {
  return (
    source.mediaSource.MediaStreams?.filter(
      (stream) =>
        stream.Type?.toLowerCase() === type.toLowerCase() &&
        (type !== "Subtitle" || isVisibleSubtitleLanguage(stream.Language)),
    ) ?? []
  );
}

function getUniqueStreams(streams: MediaStream[]): MediaStream[] {
  const seenKeys = new Set<string>();

  return streams.filter((stream, index) => {
    const key =
      stream.Index !== undefined
        ? `index-${stream.Index}`
        : [
            stream.DisplayTitle,
            stream.Title,
            stream.Language,
            stream.Codec,
            stream.IsExternal,
            stream.IsDefault,
            index,
          ].join("-");

    if (seenKeys.has(key)) {
      return false;
    }

    seenKeys.add(key);
    return true;
  });
}

export const AUTOMATIC_QUALITY_MODES: Array<{
  mode: AutomaticQualityMode;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
}> = [
  {
    mode: "low-data",
    labelKey: "player.qualityLowData",
    descriptionKey: "player.qualityLowDataDescription",
  },
  {
    mode: "auto",
    labelKey: "settings.auto",
    descriptionKey: "player.qualityFileAutoDescription",
  },
  {
    mode: "higher-resolution",
    labelKey: "player.qualityHigherResolution",
    descriptionKey: "player.qualityHigherResolutionDescription",
  },
];
