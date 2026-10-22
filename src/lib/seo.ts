export const SITE_URL = "https://www.seyirlik.org/";

export const DEFAULT_SEO_TITLE = "Seyirlik";

export const DEFAULT_SEO_DESCRIPTION =
  "Seyirlik, film ve dizileri modern, sinematik ve kişisel bir arayüzle keşfetmek ve izlemek için geliştirilen bir medya deneyimi uygulamasıdır.";

export const PUBLIC_HOME_CANONICAL_PATH = "/";
export const PUBLIC_SEO_LANG = "tr";
export const PUBLIC_OG_LOCALE = "tr_TR";

export const SEO_ROBOTS = {
  index: "index, follow",
  noindex: "noindex, nofollow",
} as const;

export type RobotsDirective = (typeof SEO_ROBOTS)[keyof typeof SEO_ROBOTS];

interface SeoMetadataInput {
  title?: string;
  description?: string;
  canonicalPath?: string;
  robots?: RobotsDirective;
  lang?: string;
  ogLocale?: string;
}

function getCanonicalUrl(path?: string): string {
  if (!path) {
    return new URL(window.location.pathname || "/", SITE_URL).toString();
  }

  return new URL(path, SITE_URL).toString();
}

function ensureMeta(selector: string, attributes: Record<string, string>) {
  const existing = document.head.querySelector<HTMLMetaElement>(selector);

  if (existing) {
    return existing;
  }

  const meta = document.createElement("meta");

  for (const [key, value] of Object.entries(attributes)) {
    meta.setAttribute(key, value);
  }

  document.head.appendChild(meta);
  return meta;
}

function setMetaContent(
  selector: string,
  attributes: Record<string, string>,
  content: string,
) {
  const meta = ensureMeta(selector, attributes);
  meta.setAttribute("content", content);
}

function ensureCanonicalLink() {
  const existing = document.head.querySelector<HTMLLinkElement>(
    "link[rel='canonical']",
  );

  if (existing) {
    return existing;
  }

  const link = document.createElement("link");
  link.setAttribute("rel", "canonical");
  document.head.appendChild(link);
  return link;
}

export function setSeoMetadata({
  title = DEFAULT_SEO_TITLE,
  description = DEFAULT_SEO_DESCRIPTION,
  canonicalPath,
  robots = SEO_ROBOTS.noindex,
  lang,
  ogLocale,
}: SeoMetadataInput): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const canonicalUrl = getCanonicalUrl(canonicalPath);

  if (lang) {
    document.documentElement.lang = lang;
  }

  document.title = title;
  setMetaContent(
    "meta[name='description']",
    { name: "description" },
    description,
  );
  setMetaContent("meta[name='robots']", { name: "robots" }, robots);
  ensureCanonicalLink().setAttribute("href", canonicalUrl);
  setMetaContent("meta[property='og:title']", { property: "og:title" }, title);
  if (ogLocale) {
    setMetaContent(
      "meta[property='og:locale']",
      { property: "og:locale" },
      ogLocale,
    );
  }
  setMetaContent(
    "meta[property='og:description']",
    { property: "og:description" },
    description,
  );
  setMetaContent(
    "meta[property='og:url']",
    { property: "og:url" },
    canonicalUrl,
  );
  setMetaContent(
    "meta[name='twitter:title']",
    { name: "twitter:title" },
    title,
  );
  setMetaContent(
    "meta[name='twitter:description']",
    { name: "twitter:description" },
    description,
  );
}

export function setPublicRootSeoMetadata(): void {
  setSeoMetadata({
    title: DEFAULT_SEO_TITLE,
    description: DEFAULT_SEO_DESCRIPTION,
    canonicalPath: PUBLIC_HOME_CANONICAL_PATH,
    robots: SEO_ROBOTS.index,
    lang: PUBLIC_SEO_LANG,
    ogLocale: PUBLIC_OG_LOCALE,
  });
}
