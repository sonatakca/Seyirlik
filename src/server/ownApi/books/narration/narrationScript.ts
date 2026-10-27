/**
 * What a narrator reads aloud: the book's text block by block, each block
 * named by the section and block index the reader counts (`readBookBlocks`).
 *
 * Every word the narrator times is a character range in one of these texts,
 * so the reader can find it on the page by the same numbers a saved place or
 * a search hit uses. A change to how blocks are cut or counted makes every
 * stored narration point at the wrong words: raise NARRATION_SCRIPT_VERSION
 * with it.
 */

import { readBookBlocks } from "../bookText";
import { BookRejectedError } from "../epubArchive";

export const NARRATION_SCRIPT_VERSION = 1;

export interface NarrationBlock {
  block: number;
  /** A title (h1–h6): read on its own, with a longer pause after it. */
  heading: boolean;
  /** `epubBlockText` of the block; word offsets count characters of this string. */
  text: string;
}

export interface NarrationSection {
  /** The section's position in the spine, as epub.js numbers it. */
  section: number;
  blocks: NarrationBlock[];
}

export interface NarrationScript {
  version: number;
  sections: NarrationSection[];
}

/** The book's readable text in reading order; pictures and empty sections are left out. */
export function buildNarrationScript(bytes: Buffer): NarrationScript {
  const sections = readBookBlocks(bytes)
    .map((blocks) => ({
      section: blocks[0]?.section ?? -1,
      blocks: blocks
        .filter((found) => found.text)
        .map(({ block, heading, text }) => ({ block, heading, text })),
    }))
    .filter((section) => section.blocks.length > 0);

  if (sections.length === 0)
    throw new BookRejectedError("This book has no text to read aloud.");
  return { version: NARRATION_SCRIPT_VERSION, sections };
}
