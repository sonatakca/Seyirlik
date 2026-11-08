import { type RefObject, useEffect, useRef } from "react";

// Only decides how a hint spells its modifier, so a platform sniff is enough
// and never blocks a shortcut.
export const isMacPlatform =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/** How a hint writes Option/Alt plus `key`: "⌥1" on a Mac, "Alt 1" elsewhere. */
export function altShortcut(key: string): string {
  return isMacPlatform ? `⌥${key}` : `Alt ${key}`;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

/** Widgets whose arrow keys already mean something to whoever is in them. */
const OWNS_ARROW_KEYS =
  '[role="menu"],[role="menubar"],[role="listbox"],[role="slider"],[role="tablist"],[role="radiogroup"],[role="dialog"]';

interface Carousel {
  element: () => HTMLElement | null;
  /** The carousel arrows move when no other one is focused or hovered. */
  isDefault: boolean;
  step: (direction: "previous" | "next") => void;
}

const carousels = new Set<Carousel>();

function isOnScreen(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 0;
}

/**
 * Which carousel ← and → move: the one holding the focus, else the one under
 * the pointer, else the page's default (the home hero) while it is on screen.
 */
function pickCarousel(target: EventTarget | null): Carousel | null {
  const all = [...carousels];
  const node = target instanceof Node ? target : null;
  return (
    all.find((c) => node && c.element()?.contains(node)) ??
    all.find((c) => c.element()?.matches(":hover")) ??
    all.find((c) => {
      const element = c.element();
      return c.isDefault && element !== null && isOnScreen(element);
    }) ??
    null
  );
}

function handleArrowKey(event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (event.defaultPrevented || event.repeat) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (isTypingTarget(event.target)) return;
  if (
    event.target instanceof Element &&
    event.target.closest(OWNS_ARROW_KEYS)
  ) {
    return;
  }

  const carousel = pickCarousel(event.target);
  if (!carousel) return;
  event.preventDefault();
  carousel.step(event.key === "ArrowLeft" ? "previous" : "next");
}

/**
 * ← and → step this carousel: see `pickCarousel` for which one when several
 * are on the page. One window listener serves them all.
 */
export function useCarouselArrowKeys(
  ref: RefObject<HTMLElement | null>,
  step: (direction: "previous" | "next") => void,
  { isDefault = false, enabled = true } = {},
) {
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const carousel: Carousel = {
      element: () => ref.current,
      isDefault,
      step: (direction) => stepRef.current(direction),
    };
    if (carousels.size === 0) {
      window.addEventListener("keydown", handleArrowKey);
    }
    carousels.add(carousel);
    return () => {
      carousels.delete(carousel);
      if (carousels.size === 0) {
        window.removeEventListener("keydown", handleArrowKey);
      }
    };
  }, [ref, isDefault, enabled]);
}
