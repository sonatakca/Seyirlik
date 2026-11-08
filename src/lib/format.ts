import type { MediaItem } from "./types";

const TICKS_PER_MINUTE = 600_000_000;

export interface MediaFormatLabels {
  season: string;
  hourShort: string;
  minuteShort: string;
}

const DEFAULT_MEDIA_FORMAT_LABELS: MediaFormatLabels = {
  season: "Season",
  hourShort: "h",
  minuteShort: "m",
};

export function formatRuntime(
  runTimeTicks?: number,
  labels: MediaFormatLabels = DEFAULT_MEDIA_FORMAT_LABELS,
): string | null {
  if (!runTimeTicks) {
    return null;
  }

  const totalMinutes = Math.round(runTimeTicks / TICKS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${minutes}${labels.minuteShort}`;
  }

  return minutes > 0
    ? `${hours}${labels.hourShort} ${minutes}${labels.minuteShort}`
    : `${hours}${labels.hourShort}`;
}

export function getDisplayTitle(
  item: MediaItem,
  labels: MediaFormatLabels = DEFAULT_MEDIA_FORMAT_LABELS,
): string {
  if (item.Type === "Season") {
    if (typeof item.IndexNumber === "number" && item.IndexNumber > 0) {
      return labels.season.includes("{number}")
        ? labels.season.replace("{number}", String(item.IndexNumber))
        : `${labels.season} ${item.IndexNumber}`;
    }
    return item.Name;
  }

  if (item.Type === "Episode" && item.SeriesName) {
    const episodeNumber = item.IndexNumber ? `E${item.IndexNumber}` : "";
    const seasonNumber = item.ParentIndexNumber
      ? `S${item.ParentIndexNumber}`
      : "";
    const prefix = `${seasonNumber}${episodeNumber}`;
    return prefix ? `${item.SeriesName} ${prefix}` : item.SeriesName;
  }

  return item.Name;
}

/** `episodeName` is an episode's name in the site's language, when known. */
export function getItemSubtitle(
  item: MediaItem,
  labels: MediaFormatLabels = DEFAULT_MEDIA_FORMAT_LABELS,
  episodeName?: string | null,
): string | null {
  if (item.Type === "Season") {
    const parts = [item.SeriesName, item.ProductionYear?.toString()].filter(
      Boolean,
    );
    return parts.length > 0 ? parts.join(" / ") : null;
  }

  const parts = [
    item.ProductionYear?.toString(),
    item.Type === "Episode" ? (episodeName ?? item.Name) : undefined,
    formatRuntime(item.RunTimeTicks, labels) ?? undefined,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" / ") : null;
}

export function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}
