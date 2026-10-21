import type { ShareItemRow } from "./shareRepository";

/** Messengers show two or three lines; anything past this is cut anyway. */
export const MAX_DESCRIPTION_LENGTH = 300;

export interface ShareText {
  title: string;
  description: string | null;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Cut at a word boundary, so a preview never ends mid-word. */
export function clipDescription(
  value: string,
  limit = MAX_DESCRIPTION_LENGTH,
): string {
  const text = clean(value);
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

function withYear(title: string, year: number | null): string {
  return year ? `${title} (${year})` : title;
}

/**
 * What a shared link says, in the site's language.
 *
 * A season or an episode is named through its series, because that is the
 * name the reader knows; a book is introduced by its author, read from the
 * book itself, since the catalogue does not hold one.
 */
export function shareText(
  item: ShareItemRow,
  book?: { author: string | null; description: string | null } | null,
): ShareText {
  const title = clean(item.title);
  const series = clean(item.seriesTitle);
  const overview = clean(item.overview);
  const seriesOverview = clean(item.seriesOverview);
  const describe = (...candidates: string[]) => {
    const found = candidates.find((candidate) => candidate.length > 0);
    return found ? clipDescription(found) : null;
  };

  switch (item.kind) {
    case "movie":
    case "series":
      return {
        title: withYear(title, item.productionYear),
        description: describe(overview),
      };
    case "season":
      return {
        title: series ? `${series} · ${title}` : title,
        description: describe(overview, seriesOverview),
      };
    case "episode": {
      const position = [
        item.parentIndexNumber !== null
          ? `${item.parentIndexNumber}. Sezon`
          : "",
        item.indexNumber !== null ? `${item.indexNumber}. Bölüm` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return {
        title: [series, position, title].filter(Boolean).join(" · "),
        description: describe(overview, seriesOverview),
      };
    }
    case "book": {
      const author = clean(book?.author);
      const blurb = clean(book?.description) || overview;
      return {
        title: author ? `${title} · ${author}` : title,
        description: describe(blurb),
      };
    }
  }
}
