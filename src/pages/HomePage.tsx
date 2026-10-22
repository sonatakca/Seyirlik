import { lazy, Suspense } from "react";
import { HomeSkeleton, MobileHomeSkeleton } from "../components/Skeletons";
import { useIsMobileView } from "../hooks/useIsMobileView";
import { useIsPhoneView } from "../hooks/useIsPhoneView";

const DesktopHomePage = lazy(() =>
  import("./desktop/DesktopHomePage").then((module) => ({
    default: module.DesktopHomePage,
  })),
);
const MobileHomePage = lazy(() =>
  import("./mobile/MobileHomePage").then((module) => ({
    default: module.MobileHomePage,
  })),
);

/*
 * While a page's code loads, its fallback is the same skeleton the page shows
 * while its data loads, so the two waits read as one: nothing is swapped, and
 * no placeholder flashes up before the hero's own.
 */
export function HomePage() {
  const isMobile = useIsMobileView();
  const isPhone = useIsPhoneView();

  if (isMobile) {
    return (
      <Suspense fallback={<MobileHomeSkeleton isPhone={isPhone} />}>
        <MobileHomePage />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<HomeSkeleton />}>
      <DesktopHomePage />
    </Suspense>
  );
}
