/**
 * A book's text, cut into the passages its search compares a question with.
 *
 * Every passage names the block the reader should open at, as a section (the
 * spine position) and a block index within it. Those numbers are only useful
 * if they count exactly what the reader counts, so each section goes through
 * the reader's own steps: parsed the way epub.js parses it, serialized, cleaned
 * by `neutraliseBookScripts`, parsed again as the frame's HTML, and divided by
 * `getEpubBlocks`. jsdom stands in for the browser.
 *
 * Changing how a book is cut or counted makes every stored index wrong: raise
 * the passage rules' number in INDEX_KEY (bookSearchProtocol.ts) with it.
 *
 * jsdom is slow and this is CPU work, so it runs only in the search's own
 * low-priority process (bookSearchWorker.ts), never on the server's event loop.
 */

import path from "node:path";
import { JSDOM } from "jsdom";

import { epubBlockText, getEpubBlocks } from "../../../lib/epubBlocks";
import { neutraliseBookScripts } from "../../../pages/reader/epubSafety";
import {
  BookRejectedError,
  entryName,
  openEpub,
  readEntryText,
} from "./epubArchive";

export interface BookPassage {
  /** The section's position in the spine, as epub.js numbers it. */
  section: number;
  /** The block the passage starts in, as `getEpubBlocks` numbers it. */
  block: number;
  /**
   * The start of the passage's own text in that block. The reader checks the
   * block holds it before trusting the index, and looks for it otherwise.
   */
  anchor: string;
  text: string;
}

/** One block of a section, as the reader counts it. */
export interface BookBlock {
  /** The section's position in the spine, as epub.js numbers it. */
  section: number;
  /** The block's index within the section, as `getEpubBlocks` numbers it. */
  block: number;
  /** A title (h1–h6) rather than running text. */
  heading: boolean;
  /** `epubBlockText` of the block: empty for a picture. */
  text: string;
}

/** About a paragraph or three: small enough to land on, large enough to mean something. */
const PASSAGE_TARGET = 700;
/** A single block longer than this (a chapter set as one block) is cut into pieces. */
const PASSAGE_MAX = 1_400;
const ANCHOR_LENGTH = 60;
/** A section of a real book is well under this; it is a ceiling, not a guess. */
const MAX_SECTION_BYTES = 16 * 1024 * 1024;

/** The parser epub.js picks by a section's extension (see epubjs/src/archive.js). */
function sectionType(name: string): DOMParserSupportedType {
  const extension = path.posix.extname(name).slice(1).toLowerCase();
  if (extension === "html" || extension === "htm") return "text/html";
  if (["xml", "opf", "ncx"].includes(extension)) return "text/xml";
  return "application/xhtml+xml";
}

let parserDom: JSDOM | null = null;

/** A window to borrow a DOMParser and XMLSerializer from; it never loads a document of its own. */
function parsing(): JSDOM["window"] {
  parserDom ??= new JSDOM("");
  return parserDom.window;
}

/** The spine's documents, in reading order, as archive entry names. */
function spineEntries(
  packageName: string,
  packageDocument: string,
): Array<{ name: string } | null> {
  const opf = new (parsing().DOMParser)().parseFromString(
    packageDocument,
    "text/xml",
  );
  const base = path.posix.dirname(packageName);
  const manifest = new Map<string, string>();
  for (const item of Array.from(opf.getElementsByTagNameNS("*", "item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, href.split("#")[0]!);
  }

  // Every itemref counts, linear="no" included: epub.js numbers them all.
  return Array.from(opf.getElementsByTagNameNS("*", "itemref")).map(
    (itemref) => {
      const href = manifest.get(itemref.getAttribute("idref") ?? "");
      return href
        ? { name: path.posix.normalize(path.posix.join(base, href)) }
        : null;
    },
  );
}

/**
 * `neutraliseBookScripts` uses the page's DOMParser and XMLSerializer. This
 * process has no page, so for the length of the call they are jsdom's.
 */
function withJsdomParser<T>(run: () => T): T {
  const scope = globalThis as unknown as Record<string, unknown>;
  const previous = [scope.DOMParser, scope.XMLSerializer];
  scope.DOMParser = parsing().DOMParser;
  scope.XMLSerializer = parsing().XMLSerializer;
  try {
    return run();
  } finally {
    [scope.DOMParser, scope.XMLSerializer] = previous;
  }
}

const XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);
const htmlEntities = new Map<string, string>();

/**
 * Named HTML entities (`&nbsp;`, `&rsquo;`) as numeric references. Browsers
 * read them in XHTML that declares the XHTML DTD, as most EPUB 2 books do;
 * jsdom's XML parser does not, and would fail the whole section.
 */
function numericEntities(markup: string): string {
  return markup.replace(/&([a-z][a-z0-9]*);/gi, (whole, name: string) => {
    if (XML_ENTITIES.has(name)) return whole;
    let decoded = htmlEntities.get(name);
    if (decoded === undefined) {
      const holder = parsing().document.createElement("span");
      holder.innerHTML = whole;
      decoded = holder.textContent === whole ? "" : (holder.textContent ?? "");
      htmlEntities.set(name, decoded);
    }
    return decoded
      ? Array.from(
          decoded,
          (c) => `&#x${c.codePointAt(0)!.toString(16)};`,
        ).join("")
      : whole;
  });
}

/** Each of a section's blocks: its text, empty for a picture, and whether it is a title. */
function sectionBlocks(
  markup: string,
  type: DOMParserSupportedType,
): Array<{ heading: boolean; text: string }> {
  const { DOMParser, XMLSerializer } = parsing();
  // What epub.js hands the serialize hook: the parsed section, serialized.
  let parsed = new DOMParser().parseFromString(
    type === "text/html" ? markup : numericEntities(markup),
    type,
  );
  // Markup no XML parser accepts: its text is still worth finding, even if
  // the reader may not show this section as it should.
  if (parsed.getElementsByTagName("parsererror").length > 0)
    parsed = new DOMParser().parseFromString(markup, "text/html");
  const serialized = new XMLSerializer().serializeToString(parsed);
  // What the frame is given, parsed as the frame parses it. jsdom runs no
  // script and fetches nothing unless asked to.
  const frame = new JSDOM(
    withJsdomParser(() => neutraliseBookScripts(serialized)),
  );
  const blocks = getEpubBlocks(frame.window.document).map((block) => ({
    heading: /^h[1-6]$/i.test(block.tagName),
    text: epubBlockText(block.textContent ?? ""),
  }));
  frame.window.close();
  return blocks;
}

/** Cuts one block's text at sentence ends into pieces near the target length. */
function pieces(text: string): string[] {
  if (text.length <= PASSAGE_MAX) return [text];
  const sentences = text.split(/(?<=[.!?…]["'”’»)]*)\s+/);
  const result: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > PASSAGE_TARGET) {
      result.push(current.trim());
      current = "";
    }
    current += current ? ` ${sentence}` : sentence;
    // A "sentence" with no end in sight is cut where it stands.
    while (current.length > PASSAGE_MAX) {
      result.push(current.slice(0, PASSAGE_TARGET).trim());
      current = current.slice(PASSAGE_TARGET);
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

/** One section's passages: whole blocks gathered to the target, never across sections. */
function sectionPassages(blocks: BookBlock[]): BookPassage[] {
  const passages: BookPassage[] = [];
  let open: BookPassage | null = null;
  const close = () => {
    if (open) passages.push(open);
    open = null;
  };

  for (const { section, block, text } of blocks) {
    if (!text) continue;
    const cut = pieces(text);

    // A block too long for one passage stands alone, a passage per piece.
    if (cut.length > 1) {
      close();
      for (const piece of cut)
        passages.push({
          section,
          block,
          anchor: piece.slice(0, ANCHOR_LENGTH),
          text: piece,
        });
      continue;
    }

    if (!open) {
      open = { section, block, anchor: text.slice(0, ANCHOR_LENGTH), text };
    } else {
      open.text += `\n${text}`;
    }
    if (open.text.length >= PASSAGE_TARGET) close();
  }
  close();
  return passages;
}

/**
 * The book's passages in reading order. Refuses (BookRejectedError) a book the
 * reader could not open either.
 */
export function readBookPassages(bytes: Buffer): BookPassage[] {
  const passages = readBookBlocks(bytes).flatMap(sectionPassages);
  if (passages.length === 0)
    throw new BookRejectedError("This book has no text to search.");
  return passages;
}

/**
 * Every block of the book in reading order, one list per section the reader
 * can show. Refuses (BookRejectedError) a book the reader could not open either.
 */
export function readBookBlocks(bytes: Buffer): BookBlock[][] {
  const { entries, packageName, packageDocument } = openEpub(bytes);
  const spine = spineEntries(packageName, packageDocument);

  const sections: BookBlock[][] = [];
  spine.forEach((entry, section) => {
    if (!entry) return;
    const name = entryName(entries, entry.name);
    const markup = readEntryText(
      bytes,
      entries,
      name,
      MAX_SECTION_BYTES,
      "A chapter of this EPUB is too large to be read here.",
    );
    if (markup === null) return;
    sections.push(
      sectionBlocks(markup, sectionType(name)).map((found, block) => ({
        section,
        block,
        ...found,
      })),
    );
  });
  return sections;
}
