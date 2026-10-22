import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The page a link-preview crawler sees for a title's address.
 *
 * WhatsApp, iMessage, Telegram and the like read a link's `og:` tags without
 * running any script, so to them every address on `www` is the same
 * `index.html` and every shared title looks like the Seyirlik home page.
 * `vercel.json` sends those crawlers — and only them — here, for title
 * addresses only; this asks the home server what the title is and answers with
 * its name, its description and its card.
 *
 * Everything degrades to the site's own preview: an address that is not a
 * title, a title without a card, or a home server that is down still gets a
 * page with the rainbow `seyirlik-preview.png`, exactly as links looked before.
 */

const SITE_ORIGIN = "https://www.seyirlik.org";
const DEFAULT_API_ORIGIN = "https://playback.seyirlik.org";
const SITE_TITLE = "Seyirlik";
const SITE_DESCRIPTION =
  "Seyirlik, film ve dizileri modern, sinematik ve kişisel bir arayüzle keşfetmek ve izlemek için geliştirilen bir medya deneyimi uygulamasıdır.";
const SITE_IMAGE = {
  url: `${SITE_ORIGIN}/seyirlik-preview.png`,
  width: 1024,
  height: 1024,
  type: "image/png",
};
/** Crawlers give up after a few seconds; a first draw can take two. */
const LOOKUP_TIMEOUT_MS = 5_000;

const TITLE_SECTIONS = new Set([
  "movies",
  "shows",
  "series",
  "season",
  "library",
  "watch",
  "read",
]);
const UUID_SEGMENT =
  /^([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i;

export interface SharePreviewCard {
  kind: string;
  title: string;
  description: string | null;
  image: { path: string; width: number; height: number; type: string } | null;
}

/**
 * The title an address is about: its last id, so a season's address
 * (`/shows/<series>/season/<season>`) names the season. Ids are written either
 * way the site has used, with or without dashes.
 */
export function titleIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (!TITLE_SECTIONS.has(segments[0] ?? "")) return null;
  for (const segment of segments.slice(1).reverse()) {
    const match = UUID_SEGMENT.exec(decodeURIComponent(segment));
    if (match) return match.slice(1).join("-").toLowerCase();
  }
  return null;
}

/** Only a path on this site; anything else is the home page. */
export function sitePath(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "/";
  const pathname = new URL(
    value.startsWith("/") ? value : `/${value}`,
    SITE_ORIGIN,
  ).pathname;
  return pathname.startsWith("//") ? "/" : pathname;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const OG_TYPES: Record<string, string> = {
  movie: "video.movie",
  series: "video.tv_show",
  season: "video.tv_show",
  episode: "video.episode",
  book: "book",
};

export function renderSharePreview(
  pathname: string,
  card: SharePreviewCard | null,
  apiOrigin: string,
): string {
  const url = `${SITE_ORIGIN}${pathname}`;
  const title = card?.title || SITE_TITLE;
  const description = card ? card.description ?? "" : SITE_DESCRIPTION;
  const image = card?.image
    ? { ...card.image, url: new URL(card.image.path, apiOrigin).href }
    : SITE_IMAGE;
  const type = (card && OG_TYPES[card.kind]) || "website";
  const meta: Array<[string, string, string]> = [
    ["name", "description", description],
    ["property", "og:type", type],
    ["property", "og:locale", "tr_TR"],
    ["property", "og:site_name", "Seyirlik"],
    ["property", "og:url", url],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:image", image.url],
    ["property", "og:image:secure_url", image.url],
    ["property", "og:image:type", image.type],
    ["property", "og:image:width", String(image.width)],
    ["property", "og:image:height", String(image.height)],
    ["property", "og:image:alt", title],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
    ["name", "twitter:image", image.url],
  ];
  const tags = meta
    .filter(([, , content]) => content !== "")
    .map(
      ([attribute, key, content]) =>
        `    <meta ${attribute}="${key}" content="${escapeHtml(content)}" />`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(title)}</title>
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <link rel="canonical" href="${escapeHtml(url)}" />
${tags}
  </head>
  <body>
    <a href="${escapeHtml(url)}">${escapeHtml(title)}</a>
  </body>
</html>
`;
}

function apiOrigin(): string {
  const configured = process.env.VITE_OWN_API_BASE_URL?.trim();
  try {
    return configured ? new URL(configured).origin : DEFAULT_API_ORIGIN;
  } catch {
    return DEFAULT_API_ORIGIN;
  }
}

function isCard(value: unknown): value is SharePreviewCard {
  if (!value || typeof value !== "object") return false;
  const card = value as Record<string, unknown>;
  const image = card.image as Record<string, unknown> | null;
  return (
    typeof card.kind === "string" &&
    typeof card.title === "string" &&
    (card.description === null || typeof card.description === "string") &&
    (image === null ||
      (typeof image === "object" &&
        typeof image.path === "string" &&
        image.path.startsWith("/ownAPI/") &&
        typeof image.width === "number" &&
        typeof image.height === "number" &&
        typeof image.type === "string"))
  );
}

export async function lookUpCard(
  itemId: string,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SharePreviewCard | null> {
  try {
    const response = await fetchImpl(
      `${origin}/ownAPI/v1/share/items/${itemId}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: unknown };
    return isCard(body.data) ? body.data : null;
  } catch {
    return null;
  }
}

export default async function sharePreviewHandler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", SITE_ORIGIN);
  // The rewrite passes the address the crawler asked for as `route`.
  const pathname = sitePath(
    requestUrl.searchParams.get("route") ?? requestUrl.pathname,
  );
  const itemId = titleIdFromPath(pathname);
  const origin = apiOrigin();
  const card = itemId ? await lookUpCard(itemId, origin) : null;

  response.statusCode = 200;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  // Short: a saved layout is a new card, and the next share should show it.
  // A miss is kept briefer still, so a server that was down recovers fast.
  response.setHeader(
    "Cache-Control",
    card
      ? "public, max-age=0, s-maxage=300, stale-while-revalidate=3600"
      : "public, max-age=0, s-maxage=30",
  );
  response.end(request.method === "HEAD" ? undefined : renderSharePreview(pathname, card, origin));
}
