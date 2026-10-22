import { lazy, Suspense, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getCachedSession } from "../../../lib/authStorage";
import { useAdminDockHidden } from "../../../lib/adminDockPreference";
import { getItem } from "../../../lib/mediaApi";
import type { LibraryPageProps } from "../../../pages/libraryPageTypes";
import type { HeroCentreDockPlace } from "../../home/heroCentreDock";
import type { DockScope } from "./titleDockModel";

const TitleAdminDock = lazy(() => import("./TitleAdminDock"));

/**
 * Which title a library route is showing, as the dock needs it.
 *
 * A season reached as `/shows/season/:seasonId` carries no show id, and the
 * library keeps subtitles, trickplay and monitoring on the show, so that one
 * case asks the catalogue which show the season belongs to.
 */
function useDockScope({
  mode,
  libraryRouteKind,
}: LibraryPageProps): DockScope | null {
  const { libraryId, seriesId, seasonId } = useParams();
  const [resolvedSeries, setResolvedSeries] = useState<{
    seasonId: string;
    seriesId: string | null;
  } | null>(null);
  const needsLookup = mode === "season" && !seriesId && Boolean(seasonId);

  useEffect(() => {
    if (!needsLookup || !seasonId) return undefined;
    let cancelled = false;
    getItem(seasonId)
      .then((season) => {
        if (!cancelled)
          setResolvedSeries({ seasonId, seriesId: season.SeriesId ?? null });
      })
      .catch(() => {
        if (!cancelled) setResolvedSeries({ seasonId, seriesId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [needsLookup, seasonId]);

  if (mode === "library")
    return libraryRouteKind === "movie" && libraryId
      ? { kind: "movie", itemId: libraryId }
      : null;
  if (mode === "series") return seriesId ? { kind: "series", seriesId } : null;
  if (!seasonId) return null;
  if (seriesId) return { kind: "series", seriesId, seasonId };
  return resolvedSeries?.seasonId === seasonId && resolvedSeries.seriesId
    ? { kind: "series", seriesId: resolvedSeries.seriesId, seasonId }
    : null;
}

/**
 * Puts the admin dock in a film, show or season page's hero — for
 * administrators only, and only while they have not switched it off on this
 * device.
 *
 * Everyone else never downloads it: the dock is its own chunk, requested only
 * once both checks pass.
 */
export function TitleAdminDockGate({
  place,
  ...props
}: LibraryPageProps & { place: HeroCentreDockPlace }) {
  const hidden = useAdminDockHidden();
  const isAdmin = getCachedSession()?.isAdministrator === true;
  const scope = useDockScope(props);

  if (!isAdmin || hidden || !scope) return null;

  return (
    <Suspense fallback={null}>
      <TitleAdminDock
        key={
          scope.kind === "movie"
            ? scope.itemId
            : `${scope.seriesId}:${scope.seasonId ?? ""}`
        }
        scope={scope}
        place={place}
      />
    </Suspense>
  );
}
