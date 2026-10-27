/**
 * A block's text as the narrator read it, mapped onto the page.
 *
 * The narrator times words as character ranges of `epubBlockText` (soft
 * hyphens gone, whitespace collapsed and trimmed). On the page the same text
 * is split across elements and carries the soft hyphens the reader sets, so
 * every character of the narrator's text is mapped back to its text node and
 * offset here, and a word or sentence becomes a Range over the live markup.
 */

const SOFT_HYPHEN = "­";
const SPACE = /\s/;

export interface VoiceText {
  /** Equal to `epubBlockText(block.textContent)`. */
  text: string;
  nodes: Text[];
  /** For each character of `text`: its node (an index into `nodes`), and its offset there. */
  node: Uint32Array;
  offset: Uint32Array;
  /** For each node, the first character of `text` at or after it. */
  firstOf: Map<Text, number>;
}

export function voiceText(block: HTMLElement): VoiceText {
  const walker = block.ownerDocument.createTreeWalker(block, 4 /* SHOW_TEXT */);
  const nodes: Text[] = [];
  const firstOf = new Map<Text, number>();
  const node: number[] = [];
  const offset: number[] = [];
  let text = "";

  for (let found = walker.nextNode(); found; found = walker.nextNode()) {
    const current = found as Text;
    const data = current.data;
    firstOf.set(current, text.length);
    nodes.push(current);

    for (let at = 0; at < data.length; at++) {
      const char = data[at]!;
      if (char === SOFT_HYPHEN) continue;
      if (SPACE.test(char)) {
        if (text.length === 0 || text.endsWith(" ")) continue;
        text += " ";
      } else {
        text += char;
      }
      node.push(nodes.length - 1);
      offset.push(at);
    }
  }

  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    node.pop();
    offset.pop();
  }
  // A node whose characters all collapsed away starts where the next one does.
  for (const [current, first] of firstOf)
    firstOf.set(current, Math.min(first, text.length));

  return {
    text,
    nodes,
    node: Uint32Array.from(node),
    offset: Uint32Array.from(offset),
    firstOf,
  };
}

/** Characters [start, end) of the narrator's text, as a Range on the page. */
export function voiceRange(
  voice: VoiceText,
  start: number,
  end: number,
): Range | null {
  const from = Math.max(0, start);
  const to = Math.min(voice.text.length, end);
  if (to <= from) return null;

  const first = voice.nodes[voice.node[from]!]!;
  const last = voice.nodes[voice.node[to - 1]!]!;
  const range = first.ownerDocument.createRange();
  try {
    range.setStart(first, voice.offset[from]!);
    range.setEnd(last, voice.offset[to - 1]! + 1);
  } catch {
    return null;
  }
  return range;
}

/** The character of the narrator's text at a point of the page (a caret position), or -1. */
export function voiceIndexAt(
  voice: VoiceText,
  container: Node,
  offset: number,
): number {
  const first = voice.firstOf.get(container as Text);
  if (first === undefined) return -1;

  const at = voice.nodes.indexOf(container as Text);
  let index = first;
  while (
    index < voice.text.length &&
    voice.node[index] === at &&
    voice.offset[index]! < offset
  )
    index++;
  return Math.min(index, voice.text.length - 1);
}

/**
 * A sentence ends where the next one visibly begins: after its stop and any
 * closing quote, before a capital, a number or an opening quote or dash. So
 * "“Seni gidi çapkın seni!” manasına" runs on, as it is read.
 */
const SENTENCE_END =
  /(?:\.\.\.|[.!?…])["'”’»)]*(?=\s+(?:["“«'‘(–—-]|\p{Lu}|\d)|\s*$)/gu;

/** The sentences of a text, as [start, end) character ranges that cover it. */
export function voiceSentences(text: string): Array<[number, number]> {
  const sentences: Array<[number, number]> = [];
  const end = new RegExp(SENTENCE_END.source, SENTENCE_END.flags);
  let start = 0;

  for (let match = end.exec(text); match; match = end.exec(text)) {
    const stop = match.index + match[0].length;
    sentences.push([start, stop]);
    start = stop;
    while (text[start] === " ") start++;
  }
  if (start < text.length) sentences.push([start, text.length]);
  return sentences;
}

/** The sentence a character falls in (the last that starts at or before it). */
export function sentenceAt(
  sentences: Array<[number, number]>,
  position: number,
): number {
  let low = 0;
  let high = sentences.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (sentences[middle]![0] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The last of `items` whose key is at or before `value`, or -1 (keys ascending). */
export function lastAtOrBefore<T>(
  items: readonly T[],
  value: number,
  key: (item: T) => number,
): number {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (key(items[middle]!) <= value) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
