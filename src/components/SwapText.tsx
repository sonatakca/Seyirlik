import { useEffect, useRef, useState } from "react";

/**
 * A label whose trailing value is exchanged, not retyped or moved.
 *
 * These labels are mostly stable: "Otomatik (2160p HDR)" keeps its name and
 * changes only the reading in brackets, sometimes twice in a second as the
 * rung moves. Animating the whole string makes the stable half restless for no
 * reason, and animating each character — which is what `AnimatedText` does,
 * correctly, for a heading that changes once — leaves twenty letters in motion
 * for the better part of a second, so the number is at its least readable
 * exactly when it has just changed.
 *
 * So only the bracketed reading is touched, and it is touched only by opacity:
 * the old value fades out where it stands and the new one fades in over it.
 * Nothing slides, so nothing draws the eye away from the word it is replacing.
 */

type SwapTextProps = {
  value: string;
  className?: string;
};

type Layer = { id: number; text: string; visible: boolean };

/** Long enough to register as a change, short enough not to lag the value. */
const FADE_MS = 200;

/**
 * A trailing "(…)" group, which is the part these labels actually vary.
 *
 * The separating space is deliberately left outside the match so it stays with
 * the name; consuming it here dropped it from the rendered label.
 */
const TRAILING_GROUP = /\([^()]*\)\s*$/;

/**
 * Splits a label into the part that stays and the part that changes.
 *
 * A label with no bracketed reading — a bare "1080p HDR" subtitle — is all
 * changing part, and fades as one.
 */
export function splitSwappableValue(value: string): {
  stable: string;
  swapped: string;
} {
  const match = value.match(TRAILING_GROUP);
  if (!match || match.index === undefined || match.index === 0) {
    return { stable: "", swapped: value };
  }
  return {
    stable: value.slice(0, match.index),
    swapped: match[0].trim(),
  };
}

export function SwapText({ value, className = "" }: SwapTextProps) {
  const { stable, swapped } = splitSwappableValue(value);
  const nextId = useRef(1);
  const reducedMotion = usePrefersReducedMotion();
  const [layers, setLayers] = useState<Layer[]>([
    { id: 0, text: swapped, visible: true },
  ]);

  useEffect(() => {
    if (reducedMotion) {
      setLayers([{ id: nextId.current++, text: swapped, visible: true }]);
      return undefined;
    }

    let cancelled = false;
    let raf = 0;
    let timeout = 0;

    setLayers((current) => {
      // The same reading arriving again is not a change. A label refreshed on
      // a timer would otherwise never come to rest.
      if (current[current.length - 1]?.text === swapped) return current;
      const id = nextId.current++;
      raf = window.requestAnimationFrame(() => {
        if (cancelled) return;
        setLayers((next) =>
          next.map((layer) =>
            layer.id === id ? { ...layer, visible: true } : layer,
          ),
        );
      });
      timeout = window.setTimeout(() => {
        if (cancelled) return;
        setLayers((next) => next.filter((layer) => layer.id === id));
      }, FADE_MS + 40);
      return [
        ...current.map((layer) => ({ ...layer, visible: false })),
        { id, text: swapped, visible: false },
      ];
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
    };
  }, [reducedMotion, swapped]);

  if (reducedMotion) {
    return <span className={className}>{value}</span>;
  }

  const settled = layers.length === 1 && layers[0]?.visible;

  return (
    <span
      className={`inline-block whitespace-nowrap align-middle ${className}`}
      // One current name, so the overlap during a fade is never read aloud.
      aria-label={value}
    >
      {stable ? <span aria-hidden="true">{stable}</span> : null}
      {settled ? (
        <span aria-hidden="true">{layers[0]!.text}</span>
      ) : (
        // Only the newest reading holds a place in the layout, so the label
        // takes its new width at once (AnimatedWidth carries the change) and
        // does not snap when the old reading is finally removed.
        <span className="relative inline-block align-baseline">
          {layers.map((layer, index) => (
            <span
              key={layer.id}
              aria-hidden="true"
              className={`whitespace-nowrap leading-[inherit] will-change-[opacity] ${
                index === layers.length - 1 ? "" : "absolute left-0 top-0"
              }`}
              style={{
                transition: `opacity ${FADE_MS}ms ease-in-out`,
                opacity: layer.visible ? 1 : 0,
              }}
            >
              {layer.text}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}
