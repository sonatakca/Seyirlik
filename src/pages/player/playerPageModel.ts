import { getBackdropImageUrl } from "../../lib/mediaApi";
import { initialFileSeconds, partStartSeconds } from "../../lib/fileParts";
import type { MediaItem } from "../../lib/types";

export function getPlayerLoadingBackdropUrl(item: MediaItem | null): string {
  const itemId = item
    ? (item.ParentBackdropItemId ?? item.SeriesId ?? item.Id)
    : null;
  const tag = item
    ? (item.ParentBackdropImageTags?.[0] ?? item.BackdropImageTags?.[0])
    : undefined;

  return itemId ? getBackdropImageUrl(itemId, tag, 1920) : "";
}

export function getInitialPlaybackSeconds(
  item: MediaItem | null,
  shouldStartFromBeginning: boolean,
): number {
  const savedPlaybackSeconds =
    typeof item?.UserData?.PlaybackPositionTicks === "number"
      ? item.UserData.PlaybackPositionTicks / 10_000_000
      : 0;

  // An episode inside a shared file starts, and resumes, from its own place.
  return shouldStartFromBeginning
    ? partStartSeconds(item)
    : initialFileSeconds(item, savedPlaybackSeconds);
}
