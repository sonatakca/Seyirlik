/** An illustration tapped in a book, and where it sits on the page. */
export type ReaderImage = {
  element: HTMLImageElement;
  src: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
};

/** Smallest picture worth opening: anything less is an ornament or a spacer. */
const MIN_ZOOMABLE_PX = 32;
/**
 * The picture a tap in a book's page landed on, if it is one worth enlarging.
 * The page lives in an epub.js frame, so this compares names rather than
 * `instanceof`, which fails across documents, and the local name because an
 * XHTML chapter's `tagName` is lower case.
 */
export function zoomableImageAt(target: Element | null): ReaderImage | null {
  const element = target?.closest?.("img") as HTMLImageElement | null;

  if (
    !element ||
    element.localName !== "img" ||
    !element.complete ||
    Math.max(element.naturalWidth, element.naturalHeight) < MIN_ZOOMABLE_PX
  ) {
    return null;
  }

  return {
    element,
    src: element.currentSrc || element.src,
    alt: element.alt,
    naturalWidth: element.naturalWidth,
    naturalHeight: element.naturalHeight,
  };
}
