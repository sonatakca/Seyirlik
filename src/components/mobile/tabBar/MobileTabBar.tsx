import type { RefObject } from "react";
import { motion } from "framer-motion";
import { TabButton } from "./TabButton";
import { useTabBarMotion, useTabs } from "./useTabBar";

const INSET = 4;

/**
 * The phone and tablet tab bar, built as a projection booth: the bar is the
 * wall under the screen, and the tab you are on is lit by a beam that rises
 * from a lamp at the bar's foot and opens wider than its tab, lighting the
 * rim where it strikes. Changing tabs swings the beam across, its leading
 * side first; a finger sliding along the bar carries it.
 */
export function MobileTabBar() {
  const tabs = useTabs();
  const bar = useTabBarMotion({ tabs, inset: INSET });
  const showBeam = bar.activeIndex >= 0 || bar.scrubbing;

  return (
    <nav
      style={{ ["--tabbar-ground" as string]: "#0a0b0c" }}
      className={`fixed inset-x-0 bottom-0 z-50 touch-none select-none pb-[env(safe-area-inset-bottom)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] landscape:hidden focus-within:!translate-y-0 focus-within:!opacity-100 motion-reduce:transition-opacity ${
        bar.hidden
          ? "pointer-events-none translate-y-full motion-reduce:translate-y-0 motion-reduce:opacity-0"
          : "translate-y-0"
      }`}
    >
      {/* The wall: near-black glass, its top rim a whisper of hairline
          that fades out toward the screen's edges. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[rgba(8,9,10,0.84)] backdrop-blur-2xl backdrop-saturate-150"
      />
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.12)_18%,rgba(255,255,255,0.12)_82%,transparent)]"
      />

      {/* On a tablet the tabs gather in the middle rather than strung
          across the whole width, so the beam keeps a lamp's proportions. */}
      <div
        ref={bar.barRef as RefObject<HTMLDivElement>}
        {...bar.handlers}
        className="relative mx-auto flex h-[4.5rem] max-w-[36rem]"
        style={{ paddingInline: INSET }}
      >
        <motion.div
          ref={bar.beamRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 origin-left"
          style={{ width: bar.slot }}
          initial={false}
          animate={{ opacity: showBeam ? 1 : 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* The beam: narrow at the lamp, opening past its tab's edges by
              the time it meets the rim; brightest at its source. */}
          <div
            className="absolute inset-y-0 -inset-x-[16%]"
            style={{
              clipPath: "polygon(35% 100%, 65% 100%, 100% 0%, 0% 0%)",
              background:
                "linear-gradient(to top, color-mix(in srgb, var(--accent) 46%, transparent), color-mix(in srgb, var(--accent) 16%, transparent) 46%, color-mix(in srgb, var(--accent) 4%, transparent))",
            }}
          />
          {/* Where the beam strikes the rim, the rim lights. */}
          <div
            className="absolute -inset-x-[16%] top-0 h-px"
            style={{
              background:
                "linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent-hover) 85%, white) 25%, color-mix(in srgb, var(--accent-hover) 85%, white) 75%, transparent)",
            }}
          />
          {/* The lamp. */}
          <div
            ref={bar.lampRef}
            className="absolute bottom-0 left-1/2 h-[3px] w-6 -translate-x-1/2 rounded-t-full"
            style={{
              background: "color-mix(in srgb, var(--accent-hover) 70%, white)",
              boxShadow:
                "0 0 10px 1px color-mix(in srgb, var(--accent) 80%, transparent), 0 0 2px color-mix(in srgb, var(--accent-hover) 90%, white)",
            }}
          />
        </motion.div>

        {tabs.map((tab, index) => {
          const lit = index === bar.litIndex;
          return (
            <TabButton
              key={tab.key}
              tab={tab}
              index={index}
              lit={lit}
              reduced={bar.reduced}
              onTabClick={bar.onTabClick}
              className={`relative flex min-w-0 flex-1 flex-col items-center justify-center gap-[0.3rem] pb-0.5 outline-none transition-colors duration-200 focus-visible:[&>span:first-child]:rounded-full focus-visible:[&>span:first-child]:ring-2 focus-visible:[&>span:first-child]:ring-[var(--accent)] focus-visible:[&>span:first-child]:ring-offset-4 focus-visible:[&>span:first-child]:ring-offset-black ${
                lit ? "text-white" : "text-white/50"
              }`}
            >
              <span className="max-w-full truncate px-0.5 text-[0.6875rem] font-bold leading-none tracking-[0.01em]">
                {tab.label}
              </span>
            </TabButton>
          );
        })}
      </div>
    </nav>
  );
}
