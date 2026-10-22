/**
 * The two black shadows the hero copy stands on, and which one the art
 * behind it gets (see `copyTextStyle` in HeroCopy.tsx for why there are two).
 * Neither has a one-pixel edge: that read as an outline on a real screen.
 */
export const COPY_SHADOW_ON_BRIGHT =
  "drop-shadow(0 1px 3px rgba(0,0,0,0.7)) drop-shadow(0 0 8px rgba(0,0,0,0.7)) drop-shadow(0 0 16px rgba(0,0,0,0.55))";
export const COPY_SHADOW_ON_DARK =
  "drop-shadow(0 1px 3px rgba(0,0,0,0.6)) drop-shadow(0 0 10px rgba(0,0,0,0.6)) drop-shadow(0 0 20px rgba(0,0,0,0.5))";
/** The shade from which the art counts as bright (white sky: 1, night: 0.25). */
const BRIGHT_ART_SHADE = 0.6;

export function copyShadowFor(shade: number): string {
  return shade >= BRIGHT_ART_SHADE
    ? COPY_SHADOW_ON_BRIGHT
    : COPY_SHADOW_ON_DARK;
}
