import { MAX_ARTWORK_WIDTH } from "../../lib/artworkSizes";
import { getBackdropImageUrl, getPrimaryImageUrl } from "../../lib/mediaApi";
import type { ImageFocus } from "../../lib/imageFocus";
import type { MediaItem } from "../../lib/types";

export const HERO_TRAILERS_ENABLED_STORAGE_KEY =
  "seyirlik-hero-trailers-enabled";

export type HeroImageType = "backdrop" | "primary" | "poster";

export interface HeroImageCandidate {
  type: HeroImageType;
  url: string;
  /** For a backdrop: the point a crop keeps in view, when one was chosen. */
  focus?: ImageFocus;
}

export function readHeroTrailersEnabledPreference(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    return (
      window.localStorage.getItem(HERO_TRAILERS_ENABLED_STORAGE_KEY) !== "false"
    );
  } catch {
    return true;
  }
}

export function saveHeroTrailersEnabledPreference(enabled: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      HERO_TRAILERS_ENABLED_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch {
    // Ignore storage failures so private browsing never blocks the hero UI.
  }
}

export function getHeroImageCandidates(item?: MediaItem): HeroImageCandidate[] {
  if (!item) {
    return [];
  }

  const candidates: HeroImageCandidate[] = [];

  // The hero is full-bleed, so it asks for the largest artwork the pipeline
  // renders. Asking for more than that used to fail the request outright and
  // drop the hero back to the poster.
  if (item.BackdropImageTags?.[0]) {
    candidates.push({
      type: "backdrop",
      url: getBackdropImageUrl(
        item.Id,
        item.BackdropImageTags[0],
        MAX_ARTWORK_WIDTH,
      ),
      ...(item.BackdropFocus ? { focus: item.BackdropFocus } : {}),
    });
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    candidates.push({
      type: "backdrop",
      url: getBackdropImageUrl(
        item.ParentBackdropItemId,
        item.ParentBackdropImageTags[0],
        MAX_ARTWORK_WIDTH,
      ),
      ...(item.ParentBackdropFocus ? { focus: item.ParentBackdropFocus } : {}),
    });
  }

  if (item.ImageTags?.Primary) {
    candidates.push({
      type: "primary",
      url: getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 900),
    });
  }

  return candidates;
}

/**
 * The artwork for a stage of a given shape. A landscape stage takes the
 * backdrop, as it always has. A portrait one takes the poster first: it is
 * drawn for that shape, a backdrop cut to it keeps a third of its width and
 * often loses its subject, and a poster's own lettering sits low, where the
 * hero's foot fades it under the title. An episode stands on its series'
 * poster. Without a poster a portrait stage falls back to the backdrop.
 */
export function getStageImageCandidates(
  item: MediaItem | undefined,
  form: "wide" | "tall",
  stageWidth = 0,
): HeroImageCandidate[] {
  if (!item) return [];
  if (form === "wide") return getHeroImageCandidates(item);
  // Enough for the stage at the screen's density, never above the ceiling.
  const density =
    typeof window === "undefined" ? 2 : Math.min(3, window.devicePixelRatio);
  const width = Math.min(
    MAX_ARTWORK_WIDTH,
    Math.max(680, Math.ceil(stageWidth * density)),
  );
  const posters: HeroImageCandidate[] = [];
  if (item.Type === "Episode" && item.SeriesId && item.SeriesPrimaryImageTag) {
    posters.push({
      type: "poster",
      url: getPrimaryImageUrl(item.SeriesId, item.SeriesPrimaryImageTag, width),
    });
  } else if (item.ImageTags?.Primary) {
    posters.push({
      type: "poster",
      url: getPrimaryImageUrl(item.Id, item.ImageTags.Primary, width),
    });
  }
  return [
    ...posters,
    ...getHeroImageCandidates(item).filter(
      (candidate) => candidate.type === "backdrop",
    ),
  ];
}
