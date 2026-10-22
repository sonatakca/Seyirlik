/**
 * Makes a book's section safe to show in a frame that allows scripts.
 *
 * The reader's frames carry `allow-scripts` for one reason: WebKit (Safari on
 * Mac, iPhone and iPad) delivers no events at all, not even to listeners the
 * reader itself registers, inside a frame sandboxed without it, so a tap on the
 * book could never show the bar. With `allow-same-origin` beside it, a script
 * in the book would run as this site, so the book's own scripts must never
 * run. Two layers:
 *
 * - A Content Security Policy as the first element of the section's head:
 *   no script of any kind (elements, inline handlers, `javascript:` URLs,
 *   eval), no plugins, no nested frames or workers. The reader's listeners are
 *   functions of the reader's own page and are not affected.
 * - The markup is cleaned as well: script, frame and plugin elements, `on*`
 *   attributes and `javascript:` URLs are removed, so nothing relies on the
 *   policy alone.
 */
export const BOOK_CONTENT_SECURITY_POLICY =
  "script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'";

const REMOVED_ELEMENTS =
  "script, iframe, frame, frameset, object, embed, applet";
const URL_ATTRIBUTES = [
  "href",
  "src",
  "action",
  "formaction",
  "data",
  "xlink:href",
];
const POLICY_TAG = `<meta http-equiv="Content-Security-Policy" content="${BOOK_CONTENT_SECURITY_POLICY}" />`;

function isScriptUrl(value: string): boolean {
  // Browsers ignore control characters and whitespace inside a scheme.
  const scheme = Array.from(value)
    .filter((character) => character.charCodeAt(0) > 0x20)
    .join("");
  return /^javascript:/i.test(scheme);
}

function clean(document: Document): void {
  document
    .querySelectorAll(REMOVED_ELEMENTS)
    .forEach((element) => element.remove());

  for (const element of Array.from(document.getElementsByTagName("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();

      if (
        name.startsWith("on") ||
        (URL_ATTRIBUTES.includes(name) && isScriptUrl(attribute.value))
      ) {
        element.removeAttributeNode(attribute);
      }
    }
  }
}

/** Puts the policy first in the head, before anything it has to govern. */
function insertPolicy(document: Document): void {
  const namespace = document.documentElement.namespaceURI;
  let head: Element | null =
    document.head ?? document.getElementsByTagName("head")[0] ?? null;

  if (!head) {
    head = namespace
      ? document.createElementNS(namespace, "head")
      : document.createElement("head");
    document.documentElement.insertBefore(
      head,
      document.documentElement.firstChild,
    );
  }

  const meta = namespace
    ? document.createElementNS(namespace, "meta")
    : document.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", BOOK_CONTENT_SECURITY_POLICY);
  head.insertBefore(meta, head.firstChild);
}

/**
 * The section's markup, cleaned and carrying the policy. Markup that will not
 * parse still gets the policy, by text, ahead of everything else, so a
 * failure here never leaves a book's scripts free to run.
 */
export function neutraliseBookScripts(markup: string): string {
  try {
    const parser = new DOMParser();
    let document = parser.parseFromString(markup, "application/xhtml+xml");
    let xml = true;

    if (document.getElementsByTagName("parsererror").length > 0) {
      document = parser.parseFromString(markup, "text/html");
      xml = false;
    }

    clean(document);
    insertPolicy(document);

    return xml
      ? new XMLSerializer().serializeToString(document)
      : `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
  } catch {
    return `${POLICY_TAG}${markup.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")}`;
  }
}
