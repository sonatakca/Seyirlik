import { lazy, Suspense, useState } from "react";
import { readIsMobileView } from "../hooks/useIsMobileView";

const loadDesktopPlayerPage = () => import("./desktop/DesktopPlayerPage");
const loadMobilePlayerPage = () => import("./mobile/MobilePlayerPage");

const DesktopPlayerPage = lazy(() =>
  loadDesktopPlayerPage().then((module) => ({
    default: module.DesktopPlayerPage,
  })),
);
const MobilePlayerPage = lazy(() =>
  loadMobilePlayerPage().then((module) => ({
    default: module.MobilePlayerPage,
  })),
);

export function preloadPlayerPage(isMobile?: boolean): Promise<unknown> {
  if (isMobile === true) {
    return loadMobilePlayerPage();
  }

  if (isMobile === false) {
    return loadDesktopPlayerPage();
  }

  return Promise.all([loadDesktopPlayerPage(), loadMobilePlayerPage()]);
}

function PlayerPageLoading() {
  return <main className="min-h-screen bg-black" />;
}

/**
 * The player page, chosen once for the visit.
 *
 * The two pages differ only in how they wait for playback; both play through
 * the same player, which lays itself out for the screen it is on. Following
 * the width as it changes swapped one page for the other, and an iPad turned
 * on its side crosses that width (810 px upright, 1080 px across): the film
 * stopped, its element and session were thrown away, and playback started
 * again. A rotation is a change of layout, never a reason to reload playback.
 */
export function PlayerPage() {
  const [isMobile] = useState(readIsMobileView);

  if (isMobile) {
    return (
      <Suspense fallback={<PlayerPageLoading />}>
        <MobilePlayerPage />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<PlayerPageLoading />}>
      <DesktopPlayerPage />
    </Suspense>
  );
}
