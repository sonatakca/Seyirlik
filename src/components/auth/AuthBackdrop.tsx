import { RainbowAnimation } from "../animations/RainbowAnimation";

/**
 * The light behind the sign-in and sign-up cards: four slow bands of the
 * logo's colours drifting behind the form. Shared so the two doors into
 * Seyirlik look like the same room.
 */
export function AuthBackdrop() {
  return (
    <>
      <RainbowAnimation
        startDelay={0}
        fadeInDuration={2.5}
        holdDuration={5}
        fadeOutDuration={2.5}
        driftDuration={16.7}
        driftDistancePercent={35}
        startYPercent={-50}
        endYPercent={-50}
        startScale={0.92}
        endScale={1.08}
        maxOpacity={0.5}
        stripeAngleDeg={106}
        spinAngleDeg={2.2}
        spinSpeedDegPerSecond={0.035}
        blurPx={22}
        width="max(80vw, 62rem)"
        height="min(20rem, 35vh)"
        top="2rem"
        glowFadeInDuration={2.2}
        glowHoldDuration={5}
        glowFadeOutDuration={2.2}
        glowMaxOpacity={0.72}
        glowTop="-10rem"
        side="top"
      />

      <RainbowAnimation
        startDelay={0.5} // Slight delay so it follows the top
        fadeInDuration={2.5}
        holdDuration={5.5}
        fadeOutDuration={2.5}
        driftDuration={16}
        driftDistancePercent={-60}
        startYPercent={-56}
        endYPercent={-44}
        startScale={0.96}
        endScale={1.03}
        maxOpacity={0.45}
        stripeAngleDeg={75}
        spinAngleDeg={-3}
        spinSpeedDegPerSecond={-0.04}
        blurPx={34}
        width="max(80vw, 62rem)"
        height="min(20rem, 35vh)"
        top="2rem"
        glowFadeInDuration={2}
        glowHoldDuration={5.5}
        glowFadeOutDuration={2}
        glowMaxOpacity={0.5}
        glowTop="-10rem"
        side="bottom"
      />

      <RainbowAnimation
        startDelay={1}
        fadeInDuration={2.5}
        holdDuration={5}
        fadeOutDuration={2.5}
        driftDuration={15}
        driftDistancePercent={24}
        startYPercent={-50}
        endYPercent={-50}
        startScale={0.98}
        endScale={1.02}
        maxOpacity={0.3}
        stripeAngleDeg={108}
        spinAngleDeg={0.8}
        spinSpeedDegPerSecond={0.012}
        blurPx={30}
        width="max(64vw, 48rem)"
        height="min(20rem, 35vh)"
        top="2rem"
        glowFadeInDuration={2}
        glowHoldDuration={5}
        glowFadeOutDuration={2}
        glowMaxOpacity={0.28}
        glowTop="-7rem"
        glowWidth="min(32rem, 64vw)"
        glowHeight="min(8rem, 18vh)"
        glowBlurPx={22}
        side="left"
      />

      {/* --- RIGHT: Gentle sweeping, opposite rotation --- */}
      <RainbowAnimation
        startDelay={1.5}
        fadeInDuration={3}
        holdDuration={5}
        fadeOutDuration={3}
        driftDuration={17}
        driftDistancePercent={-50}
        startYPercent={-54}
        endYPercent={-46}
        startScale={0.95}
        endScale={1.04}
        maxOpacity={0.42}
        stripeAngleDeg={35}
        spinAngleDeg={-2.5}
        spinSpeedDegPerSecond={-0.03}
        blurPx={36}
        width="max(80vw, 62rem)"
        height="min(20rem, 35vh)"
        top="2rem"
        glowFadeInDuration={2.5}
        glowHoldDuration={5}
        glowFadeOutDuration={2.5}
        glowMaxOpacity={0.5}
        glowTop="-10rem"
        side="right"
      />
    </>
  );
}
