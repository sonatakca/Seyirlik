import type {
  BookNarration,
  NarrationTimings,
} from "../../lib/bookNarrationApi";
import { READING_LINE, clamp } from "./readerModel";
import {
  lastAtOrBefore,
  sentenceAt,
  voiceIndexAt,
  voiceRange,
  voiceSentences,
  voiceText,
  type VoiceText,
} from "./readAlongText";

/** What the player shows; replaced whenever any of it changes. */
export interface ReadAlongState {
  /** The voice holds the reading light: the player is open. */
  engaged: boolean;
  playing: boolean;
  rate: number;
  /** Seconds in the whole narration. */
  duration: number;
  /** Where the voice is from the screen, once the reader has scrolled away from it. */
  away: "up" | "down" | null;
}

/** The reader's side of the read-along: its page, its sections and the narration's files. */
export interface ReadAlongHost {
  /** The reader's viewport; the reading line is READING_LINE down it. */
  viewport: HTMLElement;
  scroller(): HTMLElement | null;
  /** A section's blocks, once it is on the page with its typography in. */
  blocks(section: number): HTMLElement[] | null;
  /** Brings a section's block to the reading line when it is not on the page. */
  show(section: number, block: number): Promise<void>;
  timings(section: number): Promise<NarrationTimings>;
  audioUrl(section: number): string;
  metadata: { title: string; artist: string; artwork: string };
}

/** The reader's light, as the voice paints it. */
export interface VoiceInks {
  ground: string;
  ink: string;
  /** The hover underline under the word a click would play from. */
  hint: string;
  /** The ink of the page around the voice, 0 (ground) to 1 (ink). */
  far: number;
}

/** A word the voice can be sent to: its section (an index into the narration) and its place there. */
export interface VoiceWord {
  index: number;
  word: number;
}

export const VOICE_RATES = [0.8, 1, 1.15, 1.3, 1.5];
const RATE_KEY = "seyirlik.reader.voiceRate";

/** The rest of the lit sentence, and what the voice has said of it. */
const AHEAD = 0.6;
const SPOKEN = 1;
/** How soft the edge of the ink is, in letters. */
const FRONT = 1.6;
/** The lit sentence comes up from the page in this long, and the one just left goes back in this. */
const ARRIVE_MS = 350;
const LEAVE_MS = 600;
/** "Previous" this far into a sentence goes back to its start, as a player's previous does. */
const RESTART_MS = 1500;
/** A scroll this soon after the reader's own input is theirs: the page stops following. */
const INPUT_MS = 500;

const NAMES = {
  prev: "seyirlik-voice-prev",
  ahead: "seyirlik-voice-ahead",
  spoken: "seyirlik-voice-spoken",
  hover: "seyirlik-voice-hover",
} as const;
const EDGE = [1, 2, 3, 4].map((bin) => `seyirlik-voice-f${bin}`);
const ATTRIBUTE = "data-seyirlik-voice";
/** Set while the pointer is over a word a click would play from. */
const WORD_ATTRIBUTE = "data-seyirlik-voice-word";

const sine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));

function rgbOf(colour: string): number[] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour.trim());
  if (hex) return hex.slice(1).map((part) => parseInt(part, 16));
  return (colour.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
}

type FrameWindow = Window &
  typeof globalThis & {
    CSS: typeof CSS & { highlights?: HighlightRegistry };
    Highlight?: typeof Highlight;
  };

interface Section {
  timings: NarrationTimings;
  /** Each block's words: the first and last index into `timings.words`. */
  byBlock: Map<number, [number, number]>;
  /** The furthest character each block's words reach, to check the page holds that text. */
  reach: Map<number, number>;
}

interface Line {
  first: number;
  last: number;
  top: number;
  bottom: number;
}

interface LineCache {
  width: number;
  height: number;
  lines: Line[];
}

/** The ranges last painted, so an unchanged frame paints nothing. */
interface Painted {
  document: Document;
  key: string;
}

/**
 * The voice reading the book aloud, carrying the reading light.
 *
 * The sentence being said is lit and the page around it rests at the reader's
 * dimmed ink. Ink fills in behind the voice letter by letter, with a soft
 * edge where the voice is: words said are full ink, the rest of the sentence
 * a step lighter. All of it is CSS Custom Highlights in each epub.js frame,
 * so nothing is written into the book's markup and saved places, CFIs and
 * the reader's own highlights are untouched.
 *
 * The page drifts at the pace of the reading so the voice's line stays on the
 * reading line: through a line it moves by exactly that line's height, never
 * in steps. A browser keeps scroll on whole pixels, so the scroller is set to
 * the whole pixel and the rest is carried by a sub-pixel transform. The
 * reader's own scroll is respected: the page stops following, and the player
 * offers the way back.
 */
export class ReadAlong {
  private readonly audio = new Audio();
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly reduced =
    window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  private narration: BookNarration | null = null;
  /** Where each section's audio starts in the whole narration, in seconds. */
  private starts: number[] = [];
  private readonly sections = new Map<number, Section>();
  private readonly loading = new Map<number, Promise<Section | null>>();
  private readonly documents = new Map<Document, number>();
  private texts = new WeakMap<
    HTMLElement,
    { voice: VoiceText; sentences: Array<[number, number]> } | null
  >();
  private lineCaches = new WeakMap<HTMLElement, LineCache>();
  private state: ReadAlongState = {
    engaged: false,
    playing: false,
    rate: 1,
    duration: 0,
    away: null,
  };
  private inks: VoiceInks | null = null;
  private ground = [0, 0, 0];
  private ink = [255, 255, 255];
  /** The index (into the narration's sections) of the audio loaded. */
  private current = -1;
  /** Where the voice should go once its section's audio and timings are in, in ms. */
  private pending: { index: number; ms: number | null; block?: number } | null =
    null;

  // The light.
  private front = 0;
  private frontBlock = -1;
  private lit: {
    element: HTMLElement;
    block: number;
    start: number;
    end: number;
  } | null = null;
  private left: {
    element: HTMLElement;
    start: number;
    end: number;
    at: number;
  } | null = null;
  private arrivedAt = 0;
  private painted: Painted | null = null;
  private written = new WeakMap<HTMLElement, Map<string, string>>();

  // Following.
  private following = true;
  private scrollY = 0;
  private carry = 0;
  /** The whole px this last set the scroller to, NaN when it is not following. */
  private placed = Number.NaN;
  private inputAt = 0;
  private leaping = false;
  private showing = false;

  private frameId = 0;
  private last = 0;

  constructor(private readonly host: ReadAlongHost) {
    const signal = this.controller.signal;
    this.audio.preload = "auto";
    try {
      const rate = Number(window.localStorage.getItem(RATE_KEY));
      if (VOICE_RATES.includes(rate)) this.state.rate = rate;
    } catch {
      // Storage may be unavailable; the voice reads at 1×.
    }
    this.audio.playbackRate = this.state.rate;
    this.audio.addEventListener("play", () => this.update({ playing: true }), {
      signal,
    });
    this.audio.addEventListener(
      "pause",
      () => this.update({ playing: false }),
      { signal },
    );
    this.audio.addEventListener("ended", () => this.onEnded(), { signal });
    this.audio.addEventListener("loadedmetadata", () => this.applyPending(), {
      signal,
    });
    this.audio.addEventListener("seeked", () => this.kick(), { signal });
    this.listenForInput(window);
  }

  /**
   * The reader's own input, which makes a scroll theirs: a page they scroll
   * is no longer following the voice. A frame's events never reach the
   * window, so each section's document is listened to as well.
   */
  private listenForInput(target: Window | Document) {
    const signal = this.controller.signal;
    const input = () => {
      this.inputAt = performance.now();
    };
    for (const type of ["wheel", "touchmove", "pointerdown", "keydown"])
      target.addEventListener(type, input, { passive: true, signal });
  }

  /* ---------- The player's side ---------- */

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  get hasNarration() {
    return this.narration !== null;
  }

  /** Seconds into the whole narration. */
  get time() {
    if (this.current < 0) return 0;
    return (this.starts[this.current] ?? 0) + (this.audio.currentTime || 0);
  }

  setNarration(narration: BookNarration | null) {
    this.narration = narration;
    this.starts = [];
    let total = 0;
    for (const section of narration?.sections ?? []) {
      this.starts.push(total);
      total += section.duration;
    }
    this.update({ duration: total });
  }

  setInks(inks: VoiceInks) {
    this.inks = inks;
    this.ground = rgbOf(inks.ground);
    this.ink = rgbOf(inks.ink);
    this.documents.forEach((_, document) => this.writeStyle(document));
    this.written = new WeakMap();
    this.painted = null;
    this.kick();
  }

  /** A section of the book is on the page: the voice can light it and be sent there. */
  addDocument(document: Document, section: number) {
    if (!this.documents.has(document)) this.listenForInput(document);
    this.documents.set(document, section);
    this.writeStyle(document);
    void this.load(this.indexOf(section));
  }

  /** The page was laid out again: its lines are measured afresh. */
  invalidate() {
    this.lineCaches = new WeakMap();
    this.kick();
  }

  /**
   * Opens the player and plays from `from` (a section and block on the page,
   * usually the reading line's), or from the start of the narration when
   * nothing there is narrated.
   */
  start(from: { section: number; block: number } | null) {
    if (!this.narration) return;
    let index = from ? this.indexOf(from.section) : -1;
    let block: number | undefined = from?.block;
    if (index < 0) {
      index = 0;
      block = undefined;
    }
    this.engage();
    this.go(index, null, block);
    this.play();
  }

  play() {
    if (!this.narration) return;
    this.engage();
    if (this.current < 0) this.go(0, 0);
    void this.audio.play().catch(() => this.update({ playing: false }));
  }

  pause() {
    this.audio.pause();
  }

  toggle() {
    if (this.audio.paused) this.play();
    else this.pause();
  }

  /** Closes the player: the voice stops and the reader's own light comes back. */
  close() {
    this.audio.pause();
    this.clearPaint();
    this.documents.forEach((_, document) =>
      document.documentElement?.removeAttribute(ATTRIBUTE),
    );
    this.stopCarry();
    this.lit = null;
    this.left = null;
    this.frontBlock = -1;
    this.update({ engaged: false, away: null });
    this.clearMediaSession();
  }

  setRate(rate: number) {
    this.audio.playbackRate = rate;
    try {
      window.localStorage.setItem(RATE_KEY, String(rate));
    } catch {
      // Remembered for this page only.
    }
    this.update({ rate });
  }

  nextRate() {
    const at = VOICE_RATES.indexOf(this.state.rate);
    this.setRate(VOICE_RATES[(at + 1) % VOICE_RATES.length]!);
  }

  /** A share of the whole narration, as the scrub bar gives it. */
  seekFraction(fraction: number) {
    const seconds = clamp(fraction, 0, 1) * this.state.duration;
    const index = Math.max(
      0,
      lastAtOrBefore(this.starts, seconds, (start) => start),
    );
    this.go(index, (seconds - (this.starts[index] ?? 0)) * 1000);
  }

  /** To the start of the next sentence, or back to the start of this or the last one. */
  seekSentence(direction: 1 | -1) {
    const section = this.sections.get(this.current);
    if (!section) return;
    const words = section.timings.words;
    const ms = this.audio.currentTime * 1000;
    const at = Math.max(
      0,
      lastAtOrBefore(words, ms, (word) => word[3]),
    );
    const first = this.sentenceStart(section, at);

    if (direction < 0) {
      if (ms - words[first]![3] > RESTART_MS || first === 0) {
        if (
          first === 0 &&
          ms - words[0]![3] <= RESTART_MS &&
          this.current > 0
        ) {
          this.go(this.current - 1, null, Number.POSITIVE_INFINITY);
          return;
        }
        this.go(this.current, words[first]![3]);
        return;
      }
      this.go(this.current, words[this.sentenceStart(section, first - 1)]![3]);
      return;
    }

    const key = this.sentenceKey(section, at);
    let next = at + 1;
    while (next < words.length && this.sentenceKey(section, next) === key)
      next++;
    if (next < words.length) this.go(this.current, words[next]![3]);
    else if (this.current + 1 < this.starts.length)
      this.go(this.current + 1, 0);
  }

  /** The narrated word at a point of a section's frame (a tap, a pointer), or null. */
  wordAt(document: Document, x: number, y: number): VoiceWord | null {
    const sectionNumber = this.documents.get(document);
    if (sectionNumber === undefined) return null;
    const index = this.indexOf(sectionNumber);
    const section = this.sections.get(index);
    if (!section) return null;

    const caret = caretAt(document, x, y);
    if (!caret) return null;
    const element = (
      caret.node.nodeType === 1
        ? (caret.node as Element)
        : caret.node.parentElement
    )?.closest<HTMLElement>(".seyirlik-reader-block");
    const blocks = this.host.blocks(sectionNumber);
    const block = element && blocks ? blocks.indexOf(element) : -1;
    const span = section.byBlock.get(block);
    const text = element ? this.textOf(element, section, block) : null;
    if (!element || !span || !text) return null;

    const position = voiceIndexAt(text.voice, caret.node, caret.offset);
    if (position < 0) return null;
    const words = section.timings.words;
    let word = span[0];
    for (let at = span[0]; at <= span[1] && words[at]![1] <= position; at++)
      word = at;
    // Between two words, the nearer.
    const next = words[word + 1];
    if (
      next &&
      word + 1 <= span[1] &&
      position >= words[word]![2] &&
      next[1] - position < position - words[word]![2] + 1
    )
      word++;

    // The caret snaps to the nearest text, so the point must be on the word
    // or just beside it: a click in the margin or between lines says nothing.
    const fontSize = parseFloat(
      document.defaultView?.getComputedStyle(element).fontSize ?? "16",
    );
    const slack = fontSize * 0.5;
    const near = Array.from(
      voiceRange(
        text.voice,
        words[word]![1],
        words[word]![2],
      )?.getClientRects() ?? [],
    ).some(
      (box) =>
        x >= box.left - slack &&
        x <= box.right + slack &&
        y >= box.top - fontSize * 0.4 &&
        y <= box.bottom + fontSize * 0.4,
    );
    return near ? { index, word } : null;
  }

  /** Plays from a word the reader chose. */
  playFrom(target: VoiceWord) {
    const section = this.sections.get(target.index);
    const word = section?.timings.words[target.word];
    if (!word) return;
    this.engage();
    this.go(target.index, word[3]);
    this.play();
  }

  /** Underlines the word a click at this point would play from. */
  hover(document: Document, x: number, y: number) {
    const found = this.state.engaged ? this.wordAt(document, x, y) : null;
    const registry = registryOf(document);
    if (!registry) return false;
    const word = found
      ? this.sections.get(found.index)?.timings.words[found.word]
      : null;
    const blocks = word
      ? this.host.blocks(this.narration!.sections[found!.index]!.section)
      : null;
    const element = word && blocks ? blocks[word[0]] : null;
    const text = element ? this.texts.get(element) : null;
    const range =
      word && text ? voiceRange(text.voice, word[1], word[2]) : null;
    setHighlight(document, NAMES.hover, range ? [range] : []);
    // A hand over a word only: a click anywhere else does what it always did.
    document.documentElement?.toggleAttribute(WORD_ATTRIBUTE, range !== null);
    return range !== null;
  }

  /** The way back to the voice after scrolling away from it. */
  follow() {
    const scroller = this.host.scroller();
    this.following = true;
    this.scrollY = scroller?.scrollTop ?? 0;
    this.placed = Number.NaN;
    this.update({ away: null });
    this.kick();
  }

  /** The page scrolled: if the reader moved it, the player offers the way back. */
  scrolled() {
    this.kick();
  }

  /** True if the scroller stands where this put it: the scroll is the voice's, not the reader's. */
  ownsScroll(top: number) {
    return this.state.engaged && this.following && top === this.placed;
  }

  destroy() {
    this.listeners.clear();
    this.close();
    this.controller.abort();
    window.cancelAnimationFrame(this.frameId);
    this.audio.removeAttribute("src");
    this.audio.load();
  }

  /* ---------- Audio ---------- */

  private indexOf(section: number) {
    return (
      this.narration?.sections.findIndex((info) => info.section === section) ??
      -1
    );
  }

  private load(index: number): Promise<Section | null> {
    const info = this.narration?.sections[index];
    if (!info) return Promise.resolve(null);
    const ready = this.sections.get(index);
    if (ready) return Promise.resolve(ready);
    let loading = this.loading.get(index);
    if (!loading) {
      loading = this.host.timings(info.section).then(
        (timings) => {
          const byBlock = new Map<number, [number, number]>();
          const reach = new Map<number, number>();
          timings.words.forEach(([block, , end], at) => {
            const span = byBlock.get(block);
            if (span) span[1] = at;
            else byBlock.set(block, [at, at]);
            reach.set(block, Math.max(reach.get(block) ?? 0, end));
          });
          const section = { timings, byBlock, reach };
          this.sections.set(index, section);
          this.applyPending();
          this.kick();
          return section;
        },
        () => {
          this.loading.delete(index);
          return null;
        },
      );
      this.loading.set(index, loading);
    }
    return loading;
  }

  /**
   * Sends the voice to `ms` of a section's audio; with `ms` null, to the
   * first word of `block` there (the section's start when it has none). The
   * page follows again.
   */
  private go(index: number, ms: number | null, block?: number) {
    const info = this.narration?.sections[index];
    if (!info) return;
    if (index !== this.current) {
      this.current = index;
      this.audio.src = this.host.audioUrl(info.section);
      this.audio.playbackRate = this.state.rate;
    }
    this.pending = { index, ms, block };
    // Silent until it is where it was sent: the start of a section is not heard on the way.
    this.audio.muted = true;
    void this.load(index);
    this.applyPending();
    this.lit = null;
    this.frontBlock = -1;
    this.follow();
  }

  private applyPending() {
    const pending = this.pending;
    if (!pending || pending.index !== this.current) return;
    if (this.audio.readyState < 1) return;
    let ms = pending.ms;
    if (ms === null) {
      const section = this.sections.get(pending.index);
      if (!section) return;
      const words = section.timings.words;
      const block = pending.block ?? -1;
      const word =
        block === Number.POSITIVE_INFINITY
          ? this.sentenceStart(section, words.length - 1)
          : Math.max(
              0,
              words.findIndex((word) => word[0] >= block),
            );
      ms = words[word]?.[3] ?? 0;
    }
    this.pending = null;
    // A hair before the word, so its first sound is not cut.
    this.audio.currentTime = Math.max(0, ms / 1000 - 0.04);
    this.audio.muted = false;
    this.kick();
  }

  private onEnded() {
    if (this.current + 1 < this.starts.length) {
      this.go(this.current + 1, 0);
      void this.audio.play().catch(() => this.update({ playing: false }));
    } else {
      this.update({ playing: false });
    }
  }

  private engage() {
    if (this.state.engaged) return;
    this.documents.forEach((_, document) => {
      this.writeStyle(document);
      document.documentElement?.setAttribute(ATTRIBUTE, "");
    });
    this.following = true;
    this.scrollY = this.host.scroller()?.scrollTop ?? 0;
    this.update({ engaged: true });
    this.setMediaSession();
  }

  private setMediaSession() {
    const session = navigator.mediaSession;
    if (!session || typeof MediaMetadata !== "function") return;
    const { title, artist, artwork } = this.host.metadata;
    session.metadata = new MediaMetadata({
      title,
      artist,
      album: "Seyirlik",
      artwork: artwork ? [{ src: artwork }] : [],
    });
    const actions: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => this.play()],
      ["pause", () => this.pause()],
      ["previoustrack", () => this.seekSentence(-1)],
      ["nexttrack", () => this.seekSentence(1)],
    ];
    for (const [action, handler] of actions) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Not every browser knows every action.
      }
    }
  }

  private clearMediaSession() {
    const session = navigator.mediaSession;
    if (!session) return;
    session.metadata = null;
    for (const action of [
      "play",
      "pause",
      "previoustrack",
      "nexttrack",
    ] as const) {
      try {
        session.setActionHandler(action, null);
      } catch {
        // As above.
      }
    }
  }

  private update(patch: Partial<ReadAlongState>) {
    const next = { ...this.state, ...patch };
    if (
      (Object.keys(patch) as Array<keyof ReadAlongState>).every(
        (key) => next[key] === this.state[key],
      )
    )
      return;
    this.state = next;
    this.listeners.forEach((listener) => listener());
    this.kick();
  }

  /* ---------- Sentences ---------- */

  /** A block's text as the narrator read it, or null when the page holds other text. */
  private textOf(element: HTMLElement, section: Section, block: number) {
    if (!this.texts.has(element)) {
      const voice = voiceText(element);
      // The page must hold the text the words were timed against.
      const fits = voice.text.length >= (section.reach.get(block) ?? 0);
      this.texts.set(
        element,
        fits ? { voice, sentences: voiceSentences(voice.text) } : null,
      );
    }
    return this.texts.get(element) ?? null;
  }

  /** The sentence a word is in, as a number to compare; a block's own when its text is not on the page. */
  private sentenceKey(section: Section, word: number) {
    const [block, start] = section.timings.words[word]!;
    const blocks = this.host.blocks(section.timings.section);
    const element = blocks?.[block];
    const text = element ? this.textOf(element, section, block) : null;
    return block * 100_000 + (text ? sentenceAt(text.sentences, start) : 0);
  }

  private sentenceStart(section: Section, word: number) {
    const key = this.sentenceKey(section, word);
    let first = word;
    while (first > 0 && this.sentenceKey(section, first - 1) === key) first--;
    return first;
  }

  /* ---------- The frame ---------- */

  private kick() {
    if (this.frameId || !this.state.engaged) return;
    this.last = performance.now();
    this.frameId = window.requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.frameId = 0;
    if (!this.state.engaged) return;
    const dt = Math.min(64, now - this.last);
    this.last = now;
    const moving = this.step(now, dt);
    if (moving || !this.audio.paused) {
      this.frameId = window.requestAnimationFrame(this.frame);
    }
  };

  /** One frame of the light and the page; true while something is still moving. */
  private step(now: number, dt: number): boolean {
    const section = this.sections.get(this.current);
    const info = this.narration?.sections[this.current];
    if (!section || !info || this.pending) return false;

    const words = section.timings.words;
    const ms = this.audio.currentTime * 1000;
    const at = lastAtOrBefore(words, ms, (word) => word[3]);
    const word = words[Math.max(0, at)]!;
    const [block, start, end, t0, t1] = word;
    const reduced = this.reduced?.matches ?? false;
    // Where the voice is in the block, in characters: through a word, at the pace it is said.
    const spoken =
      at < 0
        ? start
        : reduced || ms >= t1
          ? end
          : start + (end - start) * ((ms - t0) / Math.max(1, t1 - t0));

    const blocks = this.host.blocks(info.section);
    const element = blocks?.[block];
    if (!element) {
      // The voice is in a part of the book not on the page: it is brought there.
      if (!this.showing) {
        this.showing = true;
        this.clearPaint();
        void this.host.show(info.section, block).finally(() => {
          this.showing = false;
          this.follow();
        });
      }
      return false;
    }
    const text = this.textOf(element, section, block);
    if (!text) {
      this.clearPaint();
      return false;
    }

    let moving = false;
    if (
      block !== this.frontBlock ||
      Math.abs(spoken - this.front) > 30 ||
      reduced
    ) {
      this.front = spoken;
      this.frontBlock = block;
    } else {
      this.front += (spoken - this.front) * (1 - Math.exp(-dt / 45));
      moving ||= Math.abs(spoken - this.front) > 0.01;
    }

    const sentence = text.sentences[sentenceAt(text.sentences, start)]!;
    if (
      !this.lit ||
      this.lit.element !== element ||
      this.lit.start !== sentence[0]
    ) {
      if (this.lit) {
        this.left = { ...this.lit, at: now };
      }
      this.lit = { element, block, start: sentence[0], end: sentence[1] };
      this.arrivedAt = now;
    }

    moving = this.paint(element, text.voice, now) || moving;
    moving = this.place(element, text.voice, dt, now) || moving;
    return moving;
  }

  private mix(level: number) {
    return `rgb(${this.ground
      .map((ground, at) =>
        Math.round(ground + (this.ink[at]! - ground) * level),
      )
      .join(",")})`;
  }

  /** Sets a custom property on a block, only when its value changes. */
  private setVar(element: HTMLElement, name: string, value: string) {
    let values = this.written.get(element);
    if (!values) {
      values = new Map();
      this.written.set(element, values);
    }
    if (values.get(name) === value) return;
    values.set(name, value);
    element.style.setProperty(`--${name}`, value);
  }

  private paint(element: HTMLElement, voice: VoiceText, now: number): boolean {
    const lit = this.lit!;
    const document = element.ownerDocument;
    const far = this.inks?.far ?? 0.36;
    const reduced = this.reduced?.matches ?? false;
    let moving = false;

    // The sentence just left goes back to the page; the new one comes up from it.
    const leaving = this.left;
    const leftFor = leaving ? sine((now - leaving.at) / LEAVE_MS) : 1;
    if (leaving && leftFor < 1) {
      this.setVar(
        leaving.element,
        NAMES.prev,
        this.mix(SPOKEN + (far - SPOKEN) * leftFor),
      );
      moving = true;
    } else {
      this.left = null;
    }
    const arrived = reduced ? 1 : sine((now - this.arrivedAt) / ARRIVE_MS);
    const ahead = far + (AHEAD - far) * arrived;
    moving ||= arrived < 1;
    this.setVar(element, NAMES.ahead, this.mix(ahead));
    this.setVar(element, NAMES.spoken, this.mix(SPOKEN));

    // Behind the voice, full ink; ahead of it, the sentence's own; a soft edge between.
    const front = clamp(this.front, lit.start, lit.end);
    const soft = reduced ? 0 : FRONT;
    const low = Math.max(lit.start, Math.floor(front - soft));
    const high = Math.min(lit.end, Math.ceil(front + soft));
    const bins: number[][] = [[], [], [], []];
    for (let letter = low; letter < high; letter++) {
      const share = soft
        ? clamp((front - (letter + 0.5)) / soft + 0.5, 0, 1)
        : letter < front
          ? 1
          : 0;
      if (share >= 0.9 || share <= 0.1) continue;
      bins[Math.min(3, Math.floor(share * 4))]!.push(letter);
    }
    const edge = bins.flat();
    const spokenEnd = edge.length ? Math.min(...edge) : Math.round(front);
    const aheadStart = edge.length ? Math.max(...edge) + 1 : Math.round(front);
    EDGE.forEach((name, bin) =>
      this.setVar(
        element,
        name,
        this.mix(ahead + (SPOKEN - ahead) * ((bin + 0.5) / 4)),
      ),
    );

    const key = [
      lit.block,
      lit.start,
      lit.end,
      spokenEnd,
      aheadStart,
      leaving ? `${leaving.start}:${leaving.end}` : "",
      ...bins.map((letters) => letters.join(".")),
    ].join("|");
    if (this.painted?.document === document && this.painted.key === key)
      return moving;
    if (this.painted && this.painted.document !== document) this.clearPaint();
    this.painted = { document, key };

    const range = (from: number, to: number) => voiceRange(voice, from, to);
    const ranges = (list: Array<Range | null>) =>
      list.filter((found): found is Range => found !== null);
    const leftVoice = leaving ? this.texts.get(leaving.element)?.voice : null;
    setHighlight(
      document,
      NAMES.prev,
      leaving && leftVoice
        ? ranges([voiceRange(leftVoice, leaving.start, leaving.end)])
        : [],
    );
    setHighlight(document, NAMES.spoken, ranges([range(lit.start, spokenEnd)]));
    setHighlight(document, NAMES.ahead, ranges([range(aheadStart, lit.end)]));
    bins.forEach((letters, bin) =>
      setHighlight(
        document,
        EDGE[bin]!,
        ranges(letters.map((letter) => range(letter, letter + 1))),
      ),
    );
    return moving;
  }

  private clearPaint() {
    const document = this.painted?.document;
    this.painted = null;
    if (!document) return;
    for (const name of [NAMES.prev, NAMES.spoken, NAMES.ahead, ...EDGE])
      setHighlight(document, name, []);
  }

  /** The frame's far ink and the highlight rules, rewritten when the light changes. */
  private writeStyle(document: Document) {
    const inks = this.inks;
    const head = document.head;
    if (!inks || !head) return;
    let style = head.querySelector<HTMLStyleElement>(
      "style[data-seyirlik-voice]",
    );
    if (!style) {
      style = document.createElement("style");
      style.dataset.seyirlikVoice = "";
      head.append(style);
    }
    const colour = (name: string) =>
      `::highlight(${name}) { color: var(--${name}); }`;
    style.textContent = [
      // The page at the reader's dimmed ink, the book's own colours included.
      `html[${ATTRIBUTE}] body, html[${ATTRIBUTE}] body * { color: ${this.mix(inks.far)} !important; }`,
      ...[NAMES.prev, NAMES.ahead, NAMES.spoken, ...EDGE].map(colour),
      `::highlight(${NAMES.hover}) { text-decoration: underline 1.5px ${inks.hint}; text-underline-offset: 0.26em; }`,
      `html[${ATTRIBUTE}][${WORD_ATTRIBUTE}] body { cursor: pointer; }`,
    ].join("\n");
    if (this.state.engaged)
      document.documentElement?.setAttribute(ATTRIBUTE, "");
  }

  /* ---------- Following ---------- */

  /** Where in the window the voice's line falls, as the reading would have it now. */
  private voiceY(element: HTMLElement, voice: VoiceText): number | null {
    const length = voice.text.length;
    if (length === 0) return null;
    const at = clamp(Math.floor(this.front), 0, length - 1);
    const line = this.lineOf(element, voice, at);
    if (!line) return null;
    const before =
      line.first > 0 ? this.lineOf(element, voice, line.first - 1) : null;
    const after =
      line.last < length - 1
        ? this.lineOf(element, voice, line.last + 1)
        : null;
    // A line's box is its leading: halfway into the gap above it to halfway into the one below.
    const high = before ? (before.bottom + line.top) / 2 : line.top;
    const low = after ? (line.bottom + after.top) / 2 : line.bottom;
    // Through a line the page moves by exactly its height, at the pace of the reading.
    const through = clamp(
      (this.front - line.first) / Math.max(1, line.last + 1 - line.first),
      0,
      1,
    );
    const frame = element.ownerDocument.defaultView?.frameElement;
    const frameTop = frame?.getBoundingClientRect().top ?? 0;
    return (
      frameTop +
      element.getBoundingClientRect().top +
      high +
      (low - high) * through
    );
  }

  /** The line of a block a character is set on, in px from the block's top; measured once per layout. */
  private lineOf(
    element: HTMLElement,
    voice: VoiceText,
    at: number,
  ): Line | null {
    let cache = this.lineCaches.get(element);
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    if (!cache || cache.width !== width || cache.height !== height) {
      cache = { width, height, lines: [] };
      this.lineCaches.set(element, cache);
    }
    const known = cache.lines.find(
      (line) => at >= line.first && at <= line.last,
    );
    if (known) return known;

    const origin = element.getBoundingClientRect().top;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    const lineHeight =
      parseFloat(style?.lineHeight ?? "") ||
      parseFloat(style?.fontSize ?? "16") * 1.5;
    // A drop cap's letter is set beside three lines, not on one.
    const cap = element.classList.contains("seyirlik-dropcap")
      ? voice.text.search(/[\p{L}\p{N}]/u)
      : -1;
    const box = (index: number): DOMRect | null => {
      for (let probe = index; probe < voice.text.length; probe++) {
        if (probe <= cap) continue;
        const range = voiceRange(voice, probe, probe + 1);
        const rect = Array.from(range?.getClientRects() ?? []).find(
          (found) => found.height > 0 && found.height <= lineHeight * 1.6,
        );
        if (rect) return rect;
        if (probe - index > 8) break;
      }
      return null;
    };
    const here = box(at);
    if (!here) return null;
    const top = here.top;
    const onOrAfter = (index: number) => {
      const found = box(index);
      return found ? found.top >= top - lineHeight / 2 : true;
    };
    const onOrBefore = (index: number) => {
      const found = box(index);
      return found ? found.top <= top + lineHeight / 2 : false;
    };

    // The line's first character: the earliest at or after the line above.
    let low = 0;
    let high = at;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (onOrAfter(middle)) high = middle;
      else low = middle + 1;
    }
    const first = low;
    // Its last: the latest not yet on the line below.
    low = at;
    high = voice.text.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (onOrBefore(middle)) low = middle;
      else high = middle - 1;
    }
    const line: Line = {
      first: cap >= 0 && first <= cap + 1 ? 0 : first,
      last: low,
      top: here.top - origin,
      bottom: here.bottom - origin,
    };
    cache.lines.push(line);
    return line;
  }

  /** Moves the page with the voice; true while it is still on its way. */
  private place(
    element: HTMLElement,
    voice: VoiceText,
    dt: number,
    now: number,
  ) {
    const scroller = this.host.scroller();
    if (!scroller || this.leaping) return this.leaping;
    const y = this.voiceY(element, voice);
    if (y === null) return false;

    const whole = scroller.scrollTop;
    if (this.following && !Number.isNaN(this.placed) && whole !== this.placed) {
      if (now - this.inputAt < INPUT_MS) {
        // The reader scrolled: the page is theirs until they ask for the voice again.
        this.following = false;
        this.stopCarry();
      } else {
        // The page moved under it (a section above reflowed and was held in place).
        this.scrollY += whole - this.placed;
      }
    }

    const view = this.host.viewport.getBoundingClientRect();
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const target = clamp(
      whole + (y - this.carry) - (view.top + view.height * READING_LINE),
      0,
      max,
    );

    if (!this.following) {
      const off = target - whole;
      this.update({
        away:
          Math.abs(off) > view.height * 0.3 ? (off > 0 ? "down" : "up") : null,
      });
      return false;
    }

    const gap = target - this.scrollY;
    if (Math.abs(gap) > view.height * 1.5) {
      this.leap(scroller, target);
      return true;
    }
    const reduced = this.reduced?.matches ?? false;
    // An eased approach, never more than 32 px in a frame.
    const step = reduced ? gap : gap * (1 - Math.exp(-dt / 220));
    this.scrollY = clamp(this.scrollY + clamp(step, -32, 32), 0, max);
    this.setScroll(scroller, this.scrollY, reduced);
    return Math.abs(gap) > 0.5;
  }

  private setScroll(scroller: HTMLElement, y: number, reduced: boolean) {
    scroller.scrollTop = Math.floor(y);
    this.placed = scroller.scrollTop;
    const rest = reduced ? 0 : this.placed - y;
    if (rest !== this.carry) {
      this.carry = Math.abs(rest) < 1 ? rest : 0;
      scroller.style.transform = this.carry
        ? `translate3d(0, ${this.carry.toFixed(3)}px, 0)`
        : "";
    }
  }

  private stopCarry() {
    this.placed = Number.NaN;
    if (this.carry) {
      this.carry = 0;
      const scroller = this.host.scroller();
      if (scroller) scroller.style.transform = "";
    }
  }

  /** A long way is never swept: the page fades, moves, and comes back. */
  private leap(scroller: HTMLElement, target: number) {
    this.leaping = true;
    const easing = "cubic-bezier(0.37, 0, 0.63, 1)";
    const out = scroller.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 180,
      easing,
      fill: "forwards",
    });
    void out.finished
      .then(() => {
        this.scrollY = target;
        this.setScroll(scroller, target, this.reduced?.matches ?? false);
        const back = scroller.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 180,
          easing,
        });
        out.cancel();
        return back.finished;
      })
      .catch(() => undefined)
      .finally(() => {
        this.leaping = false;
        this.kick();
      });
  }
}

/** The text position under a point, in either engine's way of asking. */
function caretAt(document: Document, x: number, y: number) {
  const withPosition = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof withPosition.caretPositionFromPoint === "function") {
    const position = withPosition.caretPositionFromPoint(x, y);
    return position
      ? { node: position.offsetNode, offset: position.offset }
      : null;
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range
    ? { node: range.startContainer, offset: range.startOffset }
    : null;
}

function registryOf(document: Document) {
  const view = document.defaultView as FrameWindow | null;
  const registry = view?.CSS?.highlights;
  return registry && typeof view?.Highlight === "function"
    ? { registry, Highlight: view.Highlight }
    : null;
}

/**
 * Paints `ranges` as a highlight in a frame, or takes it away. Never with a
 * priority: WebKit crashes the page (MarkedText::collectForHighlights) when
 * highlights of different priorities meet in one line of text while one of
 * them changes, as the voice's do every frame, and the reader's own
 * highlights and the hover underline both meet the voice. None needs one:
 * the voice's ranges never overlap one another, and what overlaps them sets
 * only a background or an underline.
 */
function setHighlight(document: Document, name: string, ranges: Range[]) {
  const found = registryOf(document);
  if (!found) return;
  if (ranges.length === 0) {
    found.registry.delete(name);
    return;
  }
  found.registry.set(name, new found.Highlight(...ranges));
}
