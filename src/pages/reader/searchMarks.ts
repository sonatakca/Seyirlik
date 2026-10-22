/**
 * The words a search found, on the page: where the reader is taken, and how
 * they stay marked once there.
 *
 * The server found them in the passage's text (bookSearchText.ts); here the
 * same rules find them again in the blocks epub.js rendered, whose text is
 * split across elements and carries the soft hyphens the reader sets. Like
 * the reader's highlights, the marks are CSS Custom Highlights: nothing is
 * written into the book's markup, so saved places and CFIs are untouched.
 */

import type { BookSearchFound } from "../../lib/bookSearchApi";
import {
  focusMark,
  foldWord,
  markText,
  type TextMark,
} from "../../lib/bookSearchText";
import { epubBlockText } from "../../lib/epubBlocks";

const FOUND_WORDS = "seyirlik-search-word";

interface BlockText {
  text: string;
  nodes: Text[];
  /** Where each node's text starts in `text`. */
  starts: number[];
}

function textOf(block: HTMLElement): BlockText {
  const walker = block.ownerDocument.createTreeWalker(block, 4 /* SHOW_TEXT */);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(text.length);
    text += node.textContent ?? "";
  }
  return { text, nodes, starts };
}

/** The node and offset a position of `text` falls in; an end belongs to the node it ends. */
function pointAt(block: BlockText, offset: number, end: boolean) {
  for (let at = block.nodes.length - 1; at >= 0; at--) {
    const start = block.starts[at]!;
    if (end ? offset > start : offset >= start)
      return { node: block.nodes[at]!, offset: offset - start };
  }
  return null;
}

function rangeOf(block: BlockText, mark: TextMark): Range | null {
  const from = pointAt(block, mark.start, false);
  const to = pointAt(block, mark.end, true);
  if (!from || !to) return null;
  const range = from.node.ownerDocument.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range;
}

export interface FoundOnPage {
  /** Every found word in the passage's blocks. */
  ranges: Range[];
  /** The one the reader is taken to: where the found words gather most. */
  focus: { block: number; range: Range } | null;
}

/**
 * The found words in `blocks`, the passage's blocks in order, one for each
 * line of `passage` (the hit's text). The focus is found in the passage's
 * text, then on the page in its block: the same word, at about the same
 * place in the block (a long block is cut into several passages).
 */
export function findOnPage(
  blocks: HTMLElement[],
  passage: string,
  found: BookSearchFound,
): FoundOnPage {
  const texts = blocks.map(textOf);
  const marksOf = texts.map((block) =>
    markText(block.text, found.terms, found.phrase, found.exact),
  );
  const ranges = texts.flatMap((block, at) =>
    marksOf[at]!.map((mark) => rangeOf(block, mark)).filter(
      (range): range is Range => range !== null,
    ),
  );

  const passageMarks = markText(
    passage,
    found.terms,
    found.phrase,
    found.exact,
  );
  const focus = focusMark(passage, passageMarks);
  if (!focus) return { ranges, focus: null };

  const lineStart = passage.lastIndexOf("\n", focus.start - 1) + 1;
  const lineIndex = passage.slice(0, lineStart).split("\n").length - 1;
  const block = lineIndex < blocks.length ? lineIndex : 0;
  const lineEnd = passage.indexOf("\n", lineStart);
  const line = passage.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const blockText = epubBlockText(blocks[block]!.textContent ?? "");
  const lineAt = Math.max(0, blockText.indexOf(line.slice(0, 40)));
  const place =
    (lineAt + focus.start - lineStart) / Math.max(1, blockText.length);
  const word = foldWord(passage.slice(focus.start, focus.end));

  const candidates = marksOf[block]!;
  const same = candidates.filter(
    (mark) => foldWord(texts[block]!.text.slice(mark.start, mark.end)) === word,
  );
  const length = Math.max(1, texts[block]!.text.length);
  const nearest = (same.length > 0 ? same : candidates).reduce<TextMark | null>(
    (best, mark) =>
      !best ||
      Math.abs(mark.start / length - place) <
        Math.abs(best.start / length - place)
        ? mark
        : best,
    null,
  );
  const range = nearest ? rangeOf(texts[block]!, nearest) : null;
  return { ranges, focus: range ? { block, range } : null };
}

type FrameWindow = Window &
  typeof globalThis & {
    CSS: typeof CSS & { highlights?: HighlightRegistry };
    Highlight?: typeof Highlight;
  };

/**
 * Marks the found words: a line under them in the reader's mark colour over
 * a faint wash of it, unlike any highlighter's. The ink is left as it is,
 * so the colour that writes the passage out (searchShimmer.ts) returns to
 * it without a change at the end. Returns a function that takes the marks
 * away.
 */
export function markFoundWords(
  ranges: Range[],
  { mark, scheme }: { mark: string; scheme: "dark" | "light" },
): () => void {
  const document = ranges[0]?.startContainer.ownerDocument;
  const view = document?.defaultView as FrameWindow | null | undefined;
  const registry = view?.CSS?.highlights;
  const Highlight = view?.Highlight;
  if (!document || !registry || typeof Highlight !== "function")
    return () => undefined;

  registry.set(FOUND_WORDS, new Highlight(...ranges));
  const rule = document.createElement("style");
  rule.textContent = `::highlight(${FOUND_WORDS}) {
  background-color: color-mix(in srgb, ${mark} ${scheme === "dark" ? 24 : 16}%, transparent);
  text-decoration: underline 2px ${mark};
  text-underline-offset: 0.18em;
}`;
  document.head.append(rule);
  return () => {
    registry.delete(FOUND_WORDS);
    rule.remove();
  };
}
