import { useEffect, useState } from "react";
import { getDropShadowReach } from "../../lib/logoLayout";
import {
  DEFAULT_LOGO_SHADOW,
  measureLogoShadow,
  type LogoShadow,
  type SampleRegion,
} from "../../lib/logoShadow";

/**
 * How a hero's logo stands on its artwork: measured against the part of the
 * picture behind it, and drawn as a halo in the logo's own shape. Shared by
 * the desktop stage (`HeroComposition`) and a phone's title page
 * (`PhoneTitleHero`).
 */

/** A small copy of the artwork, enough to measure the brightness behind a logo. */
export function sampleUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.searchParams.has("maxWidth"))
      parsed.searchParams.set("maxWidth", "160");
    return parsed.toString();
  } catch {
    return url;
  }
}

/** The shadow a logo needs against the part of the artwork behind it. */
export function useLogoShadow(
  logoUrl: string,
  artworkUrl: string | undefined,
  region: SampleRegion,
) {
  const [shadow, setShadow] = useState<LogoShadow>(DEFAULT_LOGO_SHADOW);
  const { left, top, width, height } = region;
  useEffect(() => {
    if (!logoUrl || !artworkUrl) return undefined;
    let cancelled = false;
    void measureLogoShadow(logoUrl, sampleUrl(artworkUrl), {
      left,
      top,
      width,
      height,
    }).then((next) => {
      if (!cancelled) setShadow(next);
    });
    return () => {
      cancelled = true;
    };
  }, [artworkUrl, logoUrl, left, top, width, height]);
  return shadow;
}

/**
 * The halo a logo on stage stands on: its own shape, blurred, always black
 * (never a light glow, whatever the logo's colour), as strong as the artwork
 * behind it needs. Over a dark picture it is little more than the resting drop shadow;
 * over a white sky it is what keeps a white logo there at all. Blur is in
 * the title box's own px, which the resting title shows at 0.6×.
 */
export function stageLogoFilter(shadow: LogoShadow, presence: number): string {
  const base = "drop-shadow(0 6px 30px rgba(0,0,0,0.55))";
  const s = shadow.strength * presence;
  if (s <= 0.01) return base;
  return `drop-shadow(0 0 3px rgba(0,0,0,${(0.55 * s).toFixed(3)})) drop-shadow(0 0 22px rgba(0,0,0,${(0.6 * s).toFixed(3)})) ${base}`;
}

/**
 * How far the stage logo's halo can paint past the logo, in the title box's
 * px. The filter goes on a frame padded by this much, never on the `<img>`:
 * iOS WebKit can clip a filtered element to its own box, which cut the halo
 * off in straight lines (see `getLogoShadowFrameStyle`). Taken at full
 * presence, the furthest the halo ever reaches; presence only changes alpha.
 */
export function stageLogoReach(shadow: LogoShadow): number {
  return Math.ceil(getDropShadowReach(stageLogoFilter(shadow, 1)));
}
