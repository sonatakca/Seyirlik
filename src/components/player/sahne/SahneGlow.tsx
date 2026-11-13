import type { CSSProperties } from "react";
import type { Rect, SahneMode } from "./sahneGeometry";

/**
 * The room's light: the title's own artwork, tiny and blurred, standing behind
 * the picture and fading out well before its edge.
 *
 * It is drawn from the backdrop image, never from the video. Copying frames
 * out of the playing element costs a second decode in Safari and can take an
 * HDR picture off its direct path to the display; and the light has to sit
 * under the picture, never over it, or it washes the film out.
 */
export function SahneGlow({
  imageUrl,
  target,
  mode,
}: {
  imageUrl?: string | null;
  target: Rect;
  mode: SahneMode;
}) {
  if (!imageUrl) return null;
  const style: CSSProperties = {
    transform: `translate(${target.x - target.w * 0.24}px, ${
      target.y - target.h * 0.55
    }px) scale(${(target.w * 1.48) / 48}, ${(target.h * 2.1) / 20})`,
  };
  return (
    <img
      src={imageUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="sahne-glow"
      data-sahne-glow={mode}
      style={style}
    />
  );
}
