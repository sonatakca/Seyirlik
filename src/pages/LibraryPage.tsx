import { lazy, Suspense, useCallback } from "react";
import {
  LibrarySkeleton,
  MovieLibrarySkeleton,
  ShowLibrarySkeleton,
} from "../components/Skeletons";
import { TitleAdminDockGate } from "../components/admin/titleDock/TitleAdminDockGate";
import {
  HeroCentreDockContext,
  type HeroCentreDockPlace,
} from "../components/home/heroCentreDock";
import { useIsMobileView } from "../hooks/useIsMobileView";
import type { LibraryPageProps } from "./libraryPageTypes";

const DesktopLibraryPage = lazy(() =>
  import("./desktop/DesktopLibraryPage").then((module) => ({
    default: module.DesktopLibraryPage,
  })),
);
const MobileLibraryPage = lazy(() =>
  import("./mobile/MobileLibraryPage").then((module) => ({
    default: module.MobileLibraryPage,
  })),
);

function LibraryPageLoading({
  isMobile,
  mode,
  libraryRouteKind,
}: LibraryPageProps & { isMobile: boolean }) {
  if (libraryRouteKind === "movie") {
    return <MovieLibrarySkeleton mobile={isMobile} />;
  }

  if (libraryRouteKind === "show" || mode === "series" || mode === "season") {
    return <ShowLibrarySkeleton mobile={isMobile} />;
  }

  return <LibrarySkeleton />;
}

export function LibraryPage(props: LibraryPageProps) {
  const isMobile = useIsMobileView();
  const { mode, libraryRouteKind } = props;
  // The title hero asks for this and decides where it stands.
  const renderAdminDock = useCallback(
    (place: HeroCentreDockPlace) => (
      <TitleAdminDockGate
        mode={mode}
        libraryRouteKind={libraryRouteKind}
        place={place}
      />
    ),
    [mode, libraryRouteKind],
  );

  if (isMobile) {
    return (
      <HeroCentreDockContext.Provider value={renderAdminDock}>
        <Suspense fallback={<LibraryPageLoading {...props} isMobile />}>
          <MobileLibraryPage {...props} />
        </Suspense>
      </HeroCentreDockContext.Provider>
    );
  }

  return (
    <HeroCentreDockContext.Provider value={renderAdminDock}>
      <Suspense fallback={<LibraryPageLoading {...props} isMobile={false} />}>
        <DesktopLibraryPage {...props} />
      </Suspense>
    </HeroCentreDockContext.Provider>
  );
}
