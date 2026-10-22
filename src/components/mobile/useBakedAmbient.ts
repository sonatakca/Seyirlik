import { useEffect, useState } from "react";
import { bakeAmbient, type AmbientLook } from "../../lib/ambientBlur";

/**
 * The baked light for the front poster, and its neighbours baked ahead.
 *
 * Holds the last field until the next one is ready, so a turn never shows
 * the room unlit for a moment; the neighbours are baked once the front one
 * is, so the next turn usually finds its field already made.
 */
export function useBakedAmbient(
  source: string,
  neighbours: string[],
  look: AmbientLook,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const { blurPx, saturation, drawnWidth } = look;
  const neighbourKey = neighbours.join("\n");

  useEffect(() => {
    if (!source) return undefined;
    let cancelled = false;
    const current = { blurPx, saturation, drawnWidth };
    void bakeAmbient(source, current)
      .then((baked) => {
        if (cancelled) return;
        setUrl(baked);
        for (const next of neighbourKey.split("\n")) {
          if (next) void bakeAmbient(next, current).catch(() => {});
        }
      })
      .catch(() => {
        // An image that cannot be read leaves the room in its own dark.
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [source, neighbourKey, blurPx, saturation, drawnWidth]);

  return source ? url : null;
}
