import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MORPH_EASE, MORPH_MS, catchUp, track } from "../lib/labelMorph";

type AnimatedTextProps = {
  value: string;
  className?: string;
};

type TextLayer = {
  id: number;
  text: string;
};

/** How far a word rises as it is replaced. */
const RISE = "0.25em";
/**
 * The old words are nearly gone before the new ones show, so the two wordings
 * never sit over each other at full strength.
 */
const EXIT_MS = 120;
const ENTER_DELAY_MS = 50;
const ENTER_FADE_MS = 220;
const EXIT_EASE = "cubic-bezier(0.4, 0, 1, 1)";

/**
 * A label whose words are replaced whole, in the same time for any length.
 *
 * The new words take their place in the layout at once; the old ones leave the
 * flow and fade out where they were drawn, lifting a little as the new words
 * rise into place. So the label is never half one wording and half the other,
 * and its width is the new one from the first frame. `AnimatedWidth` carries
 * that width change to the label's surroundings.
 *
 * Only opacity and transform move, on the compositor.
 */
export function AnimatedText({ value, className = "" }: AnimatedTextProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [layers, setLayers] = useState<TextLayer[]>([{ id: 0, text: value }]);
  const nodes = useRef(new Map<number, HTMLSpanElement>());
  const motion = useRef(new Map<number, "enter" | "exit">());

  const current = layers[layers.length - 1]!;
  if (current.text !== value) {
    // Adopted during render, so the new words are laid out in the same commit
    // that AnimatedWidth measures. The newest layer always has the highest id.
    // With nothing to play the change with, the new words simply stand.
    const next = { id: current.id + 1, text: value };
    setLayers(
      prefersReducedMotion || !canAnimate() ? [next] : [...layers, next],
    );
  }

  useLayoutEffect(() => {
    const last = layers[layers.length - 1]!;
    for (const layer of layers) {
      const node = nodes.current.get(layer.id);
      if (!node || typeof node.animate !== "function") continue;
      const phase = motion.current.get(layer.id);

      if (layer === last) {
        // The first words a label shows simply appear.
        if (phase || layers.length === 1) continue;
        motion.current.set(layer.id, "enter");
        track(
          node.animate(
            [
              { transform: `translateY(${RISE})` },
              { transform: "translateY(0)" },
            ],
            {
              duration: MORPH_MS - ENTER_DELAY_MS,
              delay: ENTER_DELAY_MS,
              easing: MORPH_EASE,
              fill: "backwards",
            },
          ),
        );
        track(
          node.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: ENTER_FADE_MS,
            delay: ENTER_DELAY_MS,
            easing: "ease-out",
            fill: "backwards",
          }),
        );
        continue;
      }

      if (phase === "exit") continue;
      motion.current.set(layer.id, "exit");
      // Leaves from wherever it is drawn now, even part way in.
      catchUp();
      const drawn = getComputedStyle(node);
      const opacity = drawn.opacity;
      const transform =
        drawn.transform === "none" ? "translateY(0)" : drawn.transform;
      for (const animation of node.getAnimations()) animation.cancel();
      const id = layer.id;
      node
        .animate(
          [
            { opacity, transform },
            { opacity: 0, transform: `translateY(-${RISE})` },
          ],
          { duration: EXIT_MS, easing: EXIT_EASE, fill: "forwards" },
        )
        .finished.then(
          () => {
            motion.current.delete(id);
            setLayers((now) => now.filter((entry) => entry.id !== id));
          },
          () => {},
        );
    }
  }, [layers]);

  if (prefersReducedMotion) {
    return <span className={className}>{value}</span>;
  }

  const changing = layers.length > 1;

  return (
    <span
      className={`relative inline-block whitespace-nowrap align-middle ${className}`}
      aria-label={changing ? value : undefined}
    >
      {layers.map((layer) => {
        const leaving = layer !== current || layer.text !== value;
        return (
          <span
            key={layer.id}
            ref={(node) => {
              if (node) nodes.current.set(layer.id, node);
              else nodes.current.delete(layer.id);
            }}
            aria-hidden={changing ? true : undefined}
            className={`inline-block whitespace-nowrap py-[0.12em] leading-[inherit] ${
              leaving ? "pointer-events-none absolute left-0 top-0" : ""
            }`}
          >
            {layer.text}
          </span>
        );
      })}
    </span>
  );
}

function canAnimate(): boolean {
  return typeof HTMLElement.prototype.animate === "function";
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);

    return () => {
      mediaQuery.removeEventListener("change", updatePreference);
    };
  }, []);

  return prefersReducedMotion;
}
