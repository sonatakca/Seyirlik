import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { morphLanguage } from "./languageMorph";
import { AnimatedText } from "../components/AnimatedText";
import { AnimatedWidth } from "../components/AnimatedWidth";

afterEach(cleanup);

/**
 * The words a language switch plays are drawn by stand-ins ("ghosts") over
 * the hidden real ones. A ghost's glyphs must start exactly where the real
 * glyphs do: the leaving words where they were, the arriving words where the
 * real ones stand. Off by the half-leading, the words drop as the switch
 * starts and jump back up when it ends.
 */

const WORDS = {
  en: {
    row: "Downloads",
    block: "Ezel returns to settle an old debt.",
    inline: "Episode",
  },
  tr: {
    row: "İndirilenler",
    block:
      "Ezel, yıllar sonra yeni bir yüz ve yeni bir isimle eski bir hesabı kapatmaya döner.",
    inline: "Bölüm",
  },
};

type Language = "en" | "tr";
/** Hands a test component's language setter out, once it is mounted. */
type Control = { set?: (language: Language) => void };
const handTo = (control: Control) => (set: (language: Language) => void) => {
  control.set = set;
};

function useControl(onReady: (set: (language: Language) => void) => void) {
  const [language, setLanguage] = useState<Language>("en");
  useEffect(() => onReady(setLanguage), [onReady]);
  return language;
}

const page: Control = {};

function Page({
  onReady,
}: {
  onReady: (set: (language: Language) => void) => void;
}) {
  const language = useControl(onReady);
  const words = WORDS[language];
  return (
    <div style={{ font: "14px/28px sans-serif", width: 320, padding: 12 }}>
      {/* A menu row: a flex box, an icon, then the words, in a tall line. */}
      <a
        data-testid="row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          height: 40,
          padding: "0 12px",
        }}
      >
        <svg width="16" height="16" />
        {words.row}
      </a>
      {/* A paragraph that wraps differently in each language. */}
      <p data-testid="block" style={{ margin: "8px 0", lineHeight: "22px" }}>
        {words.block}
      </p>
      {/* Words inside a line of other words. */}
      <p style={{ margin: 0 }}>
        1. <span data-testid="inline">{words.inline}</span> · 54m
      </p>
    </div>
  );
}

/** Where each named text's first glyph starts, keyed by its words. */
function glyphs(predicate: (node: Text) => boolean) {
  const found = new Map<string, { left: number; top: number }>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data.trim() || !predicate(text)) continue;
    range.selectNodeContents(text);
    const first = range.getClientRects()[0];
    if (first)
      found.set(text.data.trim(), { left: first.left, top: first.top });
  }
  return found;
}

const isGhost = (role: "out" | "in") => (node: Text) => {
  const ghost = node.parentElement?.closest("[data-language-morph-ghost]");
  if (!ghost) return false;
  return role === "out"
    ? ghost.hasAttribute("data-language-morph-out")
    : !ghost.hasAttribute("data-language-morph-out");
};
const isReal = (node: Text) =>
  !node.parentElement?.closest("[data-language-morph-ghost]");

function expectSamePlaces(
  ghosts: Map<string, { left: number; top: number }>,
  real: Map<string, { left: number; top: number }>,
  words: string[],
) {
  for (const word of words) {
    const ghost = ghosts.get(word);
    const truth = real.get(word);
    expect(ghost, `a ghost for "${word}"`).toBeDefined();
    expect(
      Math.abs(ghost!.top - truth!.top),
      `"${word}" vertically`,
    ).toBeLessThan(0.5);
    expect(
      Math.abs(ghost!.left - truth!.left),
      `"${word}" horizontally`,
    ).toBeLessThan(0.5);
  }
}

it("draws every leaving and arriving word exactly where the real words are", async () => {
  render(<Page onReady={handTo(page)} />);
  const before = glyphs(isReal);

  act(() => {
    morphLanguage(() => page.set!("tr"));
  });
  // Frozen at the switch's first frame, before any is painted.
  const animations = document.getAnimations();
  for (const animation of animations) {
    animation.pause();
    animation.currentTime = 0;
  }
  expectSamePlaces(glyphs(isGhost("out")), before, Object.values(WORDS.en));

  // And at its last frame, over the real words it hands back to.
  for (const animation of animations) animation.currentTime = 10_000;
  expectSamePlaces(
    glyphs(isGhost("in")),
    glyphs(isReal),
    Object.values(WORDS.tr),
  );

  await act(async () => {
    for (const animation of animations) animation.finish();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  expect(document.querySelectorAll("[data-language-morph-ghost]")).toHaveLength(
    0,
  );
  expect(
    document.querySelectorAll("[data-language-morph-hidden]"),
  ).toHaveLength(0);
});

/**
 * Shadows the words are drawn with must stay on them while they play.
 *
 * A text-shadow travels on the ghost, with room for it inside the ghost's
 * box: Safari paints nothing past that box while its filter animates. Beneath
 * a drop-shadow filter (the navbar's), the ghosts animate through registered
 * custom properties instead of on the compositor: Safari leaves compositor
 * layers out of an ancestor's drop-shadow, so the words lost their shadow for
 * as long as they played. No headless engine composites the way Safari does,
 * so this checks the mechanism; the pixels were checked in Safari.
 */
const SHADOWED = {
  en: { link: "Home", glow: "My List", plain: "Books" },
  tr: { link: "Ana Sayfa", glow: "Listem", plain: "Kitaplar" },
};
const shadowed: Control = {};

function ShadowedPage({
  onReady,
}: {
  onReady: (set: (language: Language) => void) => void;
}) {
  const language = useControl(onReady);
  const words = SHADOWED[language];
  return (
    <div style={{ font: "16px/24px sans-serif", display: "flex", gap: 24 }}>
      <a style={{ filter: "drop-shadow(0 1px 6px rgba(0, 0, 0, 0.5))" }}>
        <span data-testid="link">{words.link}</span>
      </a>
      <span style={{ textShadow: "0 2px 8px rgba(0, 0, 0, 0.6)" }}>
        <span data-testid="glow">{words.glow}</span>
      </span>
      <span data-testid="plain">{words.plain}</span>
    </div>
  );
}

const ghostsIn = (testId: string) =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-testid="${testId}"] > [data-language-morph-ghost]`,
    ),
  );

it("keeps every shadow the words are drawn with while they play", async () => {
  render(<ShadowedPage onReady={handTo(shadowed)} />);
  act(() => {
    morphLanguage(() => shadowed.set!("tr"));
  });

  // Beneath the drop-shadow: painted with the page, through the custom
  // properties, never a compositor filter of its own.
  for (const ghost of ghostsIn("link")) {
    expect(ghost.style.filter).toContain("var(--language-morph-blur)");
    expect(ghost.style.opacity).toBe("var(--language-morph-opacity)");
    const frames = ghost.getAnimations()[0]!.effect as KeyframeEffect;
    const animated = frames
      .getKeyframes()
      .flatMap((frame) => Object.keys(frame))
      .filter(
        (key) =>
          !["offset", "computedOffset", "easing", "composite"].includes(key),
      );
    expect(new Set(animated)).toEqual(
      new Set([
        "--language-morph-opacity",
        "--language-morph-scale",
        "--language-morph-blur",
      ]),
    );
  }

  // A text-shadow: on the ghost, with room for it in the ghost's box.
  const glow = ghostsIn("glow");
  expect(glow.length).toBeGreaterThan(0);
  for (const ghost of glow) {
    expect(getComputedStyle(ghost).textShadow).toContain("8px");
    expect(parseFloat(ghost.style.paddingBottom)).toBeGreaterThanOrEqual(10);
  }

  // No shadow anywhere above: the compositor plays it.
  for (const ghost of ghostsIn("plain")) {
    const keys = (ghost.getAnimations()[0]!.effect as KeyframeEffect)
      .getKeyframes()
      .flatMap((frame) => Object.keys(frame));
    expect(keys).toContain("filter");
    expect(keys).not.toContain("--language-morph-blur");
  }

  await act(async () => {
    for (const animation of document.getAnimations()) animation.finish();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  expect(document.querySelectorAll("[data-language-morph-ghost]")).toHaveLength(
    0,
  );
  expect(screen.getByTestId("link").style.filter).toBe("");
});

/**
 * The per-label animation (AnimatedText, AnimatedWidth) still plays labels
 * that change for other reasons, Play becoming Resume. A language switch
 * plays every word itself, so the old animation stands down for it: one set
 * of words, changed in place, and no second stretch of its pill.
 */
const label: Control = {};

function Label({
  onReady,
}: {
  onReady: (set: (language: Language) => void) => void;
}) {
  const language = useControl(onReady);
  const words = language === "en" ? "Details" : "Detaylar";
  return (
    <button
      data-testid="pill"
      style={{
        display: "inline-flex",
        padding: "0 16px",
        height: 40,
        borderRadius: 999,
        background: "rgb(240, 240, 240)",
      }}
    >
      <AnimatedWidth value={words}>
        <AnimatedText value={words} />
      </AnimatedWidth>
    </button>
  );
}

it("lets the switch, not the per-label animation, play a label", () => {
  render(<Label onReady={handTo(label)} />);
  act(() => {
    morphLanguage(() => label.set!("tr"));
  });
  const pill = screen.getByTestId("pill");
  // One wording in the label, rewritten in place and played by the switch.
  const real = Array.from(pill.querySelectorAll("span")).filter(
    (span) =>
      !span.closest("[data-language-morph-ghost]") &&
      Array.from(span.childNodes).some(
        (node) =>
          node.nodeType === Node.TEXT_NODE && node.textContent === "Detaylar",
      ),
  );
  expect(real).toHaveLength(1);
  expect(real[0]!.hasAttribute("data-language-morph-hidden")).toBe(true);
  // The old animation's own stretch layers never appear.
  expect(pill.querySelector("[data-morph-paint]")).toBeNull();
  for (const animation of document.getAnimations()) animation.finish();
});
