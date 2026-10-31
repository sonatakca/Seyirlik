import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { ADMIN_REDIRECTS } from "./lib/adminSections";
import { Layout } from "./components/Layout";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { RouteColorTransition } from "./components/RouteColorTransition";
import { RouteTransitionOutlet } from "./components/RouteTransitionOutlet";
import { NonPlayerHistoryTracker } from "./components/BackButton";
import { ScrollToTop } from "./components/ScrollToTop";
import { ServerConnectionErrorPage } from "./components/ServerConnectionErrorPage";
import {
  clearAuthSession,
  isAuthenticated,
  setAuthSession,
} from "./lib/authStorage";
import { loginPathFor } from "./lib/loginRedirect";
import {
  isDeviceOffline,
  isOfflineSupported,
} from "./lib/offline/offlineLibrary";
import {
  SERVER_UNAVAILABLE_EVENT,
  type ServerUnavailableEvent,
  type ServerUnavailableEventDetail,
} from "./lib/mediaApi";
import { checkServerAvailability } from "./lib/serverAvailability";
import { bootstrapIdentity } from "./lib/identityBootstrap";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/LibraryPage";
import { LibraryAliasPage } from "./pages/LibraryAliasPage";
import { LoginPage } from "./pages/LoginPage";
import { PlayerPage } from "./pages/PlayerPage";
import { ReaderPage } from "./pages/ReaderPage";
import { MonopolyBridgePage } from "./pages/MonopolyBridgePage";
import { NotificationAnnouncer } from "./components/notifications/NotificationAnnouncer";
import { useTaskNotifications } from "./hooks/useTaskNotifications";
import { setPageTitle } from "./lib/pageTitle";
import {
  PUBLIC_HOME_CANONICAL_PATH,
  SEO_ROBOTS,
  setPublicRootSeoMetadata,
} from "./lib/seo";

const DEFAULT_SERVER_CHECK_TIMEOUT_MS = 6000;

const RequireAdminAuth = lazy(async () => {
  const module = await import("./components/admin/RequireAdminAuth");

  return { default: module.RequireAdminAuth };
});

// The frame every administrative tool renders inside. Lazy like the pages it
// wraps, and resolved inside the same Suspense boundary as RequireAdminAuth,
// so there is one fallback for the whole area rather than one per level.
const DevToolsLayout = lazy(async () => {
  const module = await import("./components/admin/DevToolsLayout");

  return { default: module.DevToolsLayout };
});

// Admin/dev pages are only reachable behind RequireAdminAuth, so they stay out
// of the initial bundle. They resolve inside the Suspense boundary that already
// wraps RequireAdminAuth.
const IntegrationsPage = lazy(async () => ({
  default: (await import("./pages/admin/IntegrationsPage")).IntegrationsPage,
}));
const ImportsPage = lazy(async () => ({
  default: (await import("./pages/admin/ImportsPage")).ImportsPage,
}));
const NarrationReviewPage = lazy(async () => ({
  default: (await import("./pages/admin/NarrationReviewPage"))
    .NarrationReviewPage,
}));
const SubtitlesPage = lazy(async () => ({
  default: (await import("./pages/admin/SubtitlesPage")).SubtitlesPage,
}));
const ReleaseDecisionsPage = lazy(async () => ({
  default: (await import("./pages/admin/ReleaseDecisionsPage"))
    .ReleaseDecisionsPage,
}));
const AcquisitionsPage = lazy(async () => ({
  default: (await import("./pages/admin/AcquisitionsPage")).AcquisitionsPage,
}));
const AdminLibraryPage = lazy(async () => ({
  default: (await import("./pages/admin/LibraryPage")).LibraryPage,
}));
const TitlePage = lazy(async () => ({
  default: (await import("./pages/admin/TitlePage")).TitlePage,
}));
const PlaybackDiagnosticsPage = lazy(async () => ({
  default: (await import("./pages/admin/PlaybackDiagnosticsPage"))
    .PlaybackDiagnosticsPage,
}));
const OperationsHealthPage = lazy(async () => ({
  default: (await import("./pages/admin/OperationsHealthPage"))
    .OperationsHealthPage,
}));
const DevToolsPage = lazy(async () => ({
  default: (await import("./pages/DevToolsPage")).DevToolsPage,
}));
const MediaProcessingPage = lazy(async () => ({
  default: (await import("./pages/admin/MediaProcessingPage"))
    .MediaProcessingPage,
}));
const LibraryMaintenancePage = lazy(async () => ({
  default: (await import("./pages/LibraryMaintenancePage"))
    .LibraryMaintenancePage,
}));
const TmdbArtworkPage = lazy(() => import("./pages/TmdbArtworkPage"));
const AlertsPage = lazy(async () => ({
  default: (await import("./pages/AlertsPage")).AlertsPage,
}));
const DownloadsPage = lazy(async () => ({
  default: (await import("./pages/DownloadsPage")).DownloadsPage,
}));
const MyListPage = lazy(async () => ({
  default: (await import("./pages/MyListPage")).MyListPage,
}));
const CurationPage = lazy(async () => ({
  default: (await import("./pages/admin/CurationPage")).CurationPage,
}));
const SkeletonLabPage = lazy(async () => ({
  default: (await import("./pages/SkeletonLabPage")).SkeletonLabPage,
}));
const SignupPage = lazy(async () => ({
  default: (await import("./pages/SignupPage")).SignupPage,
}));
const UserManagementPage = lazy(async () => ({
  default: (await import("./pages/UserManagementPage")).UserManagementPage,
}));

type DefaultServerState = "checking" | "ready" | "failed";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`Default server check timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => {
        window.clearTimeout(timeoutId);
      });
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createConnectionFailureDetail(
  error: unknown,
  requestUrl = "/ownAPI/v1/health",
): ServerUnavailableEventDetail {
  return {
    requestUrl,
    reason: "network",
    message: getErrorMessage(error),
  };
}

export function DefaultServerGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  // Seyirlik serves its own API from this origin, so the startup check is
  // unconditional: there is no server to configure and none to skip.
  const [state, setState] = useState<DefaultServerState>("checking");
  const [renderSpinner, setRenderSpinner] = useState(true);
  const [isVisible, setIsVisible] = useState(false);
  const [connectionFailure, setConnectionFailure] =
    useState<ServerUnavailableEventDetail | null>(null);

  // Trigger fade-in after initial mount
  useEffect(() => {
    if (!renderSpinner) return;

    const timer = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(timer);
  }, [renderSpinner]);

  // Handle transition unmounting when state changes from "checking"
  useEffect(() => {
    if (state !== "checking") {
      setIsVisible(false);
      const timer = setTimeout(() => {
        setRenderSpinner(false);
      }, 300); // Wait for the 300ms CSS fade-out transition to complete
      return () => clearTimeout(timer);
    }
  }, [state]);

  useEffect(() => {
    if (state !== "checking") {
      return;
    }

    if (location.pathname === "/") {
      setPublicRootSeoMetadata();
      return;
    }

    setPageTitle("Seyirlik", {
      canonicalPath:
        location.pathname === "/app"
          ? PUBLIC_HOME_CANONICAL_PATH
          : location.pathname,
      robots: SEO_ROBOTS.noindex,
    });
  }, [location.pathname, state]);

  useEffect(() => {
    let isMounted = true;

    async function prepareServer() {
      let requestUrl = "/ownAPI/v1/health";

      try {
        await withTimeout(
          checkServerAvailability(),
          DEFAULT_SERVER_CHECK_TIMEOUT_MS,
        );
        requestUrl = "/ownAPI/v1/auth/me";
        const identity = await withTimeout(
          bootstrapIdentity(),
          DEFAULT_SERVER_CHECK_TIMEOUT_MS,
        );

        if (!isMounted) return;

        // The cookie is the real credential and the cache is only a hint, so
        // the server's answer wins. Reconciling here means an expired session
        // lands on the login page instead of on a home screen that 401s.
        if (identity.status === "authenticated") {
          setAuthSession({
            userId: identity.user.id,
            username: identity.user.username,
            displayName: identity.user.displayName,
            isAdministrator: identity.user.isAdministrator,
          });
        } else {
          clearAuthSession();
        }

        setState("ready");
      } catch (error) {
        console.warn("[Seyirlik] Startup server check failed", error);

        if (isMounted) {
          setConnectionFailure(
            createConnectionFailureDetail(error, requestUrl),
          );
          setState("failed");
        }
      }
    }

    void prepareServer();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    function handleServerUnavailable(event: Event) {
      const detail =
        "detail" in event ? (event as ServerUnavailableEvent).detail : null;

      console.warn("[Seyirlik] The server became temporarily unavailable.");
      setConnectionFailure(
        detail ?? {
          reason: "network",
          message: "The server became temporarily unavailable.",
        },
      );
      setState("ready");
    }

    window.addEventListener(SERVER_UNAVAILABLE_EVENT, handleServerUnavailable);

    return () => {
      window.removeEventListener(
        SERVER_UNAVAILABLE_EVENT,
        handleServerUnavailable,
      );
    };
  }, []);

  // With no connection at all, the downloads are all there is to watch, so a
  // signed-in viewer is taken there instead of to the server diagnostics.
  const hasConnectionFailure = state === "failed" || connectionFailure !== null;
  const canWatchOffline = isAuthenticated() && isOfflineSupported();
  const [isDeviceOfflineNow, setIsDeviceOfflineNow] = useState(false);
  useEffect(() => {
    if (!hasConnectionFailure || !canWatchOffline) return;
    let isCurrent = true;
    void isDeviceOffline().then((offline) => {
      if (isCurrent) setIsDeviceOfflineNow(offline);
    });
    return () => {
      isCurrent = false;
    };
  }, [hasConnectionFailure, canWatchOffline]);

  const retryConnection = async () => {
    await checkServerAvailability();
    await bootstrapIdentity();
  };

  if (renderSpinner) {
    return (
      <main
        className={`flex min-h-screen items-center justify-center px-4 text-white transition-opacity duration-300 ease-in-out ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="text-center">
          <LoadingSpinner label="" />
        </div>
      </main>
    );
  }

  if (
    hasConnectionFailure &&
    canWatchOffline &&
    (isDeviceOfflineNow || navigator.onLine === false)
  ) {
    return <Navigate to="/downloads" replace />;
  }

  if (connectionFailure) {
    return (
      <ServerConnectionErrorPage
        failure={connectionFailure}
        testConnection={retryConnection}
        onRetrySuccess={() => {
          setConnectionFailure(null);
          setState("ready");
        }}
      />
    );
  }

  if (state === "failed") {
    return (
      <ServerConnectionErrorPage
        testConnection={retryConnection}
        onRetrySuccess={() => {
          setState("ready");
        }}
      />
    );
  }

  return <>{children}</>;
}

function RootRedirect() {
  const location = useLocation();

  useEffect(() => {
    if (location.pathname === "/") {
      setPublicRootSeoMetadata();
      return;
    }

    setPageTitle("Seyirlik", {
      canonicalPath:
        location.pathname === "/app"
          ? PUBLIC_HOME_CANONICAL_PATH
          : location.pathname,
      robots: SEO_ROBOTS.noindex,
    });
  }, [location.pathname]);

  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to="/home" replace />;
}

function RequireAuth() {
  const location = useLocation();

  if (!isAuthenticated()) {
    return <Navigate to={loginPathFor(location)} replace />;
  }

  return <Outlet />;
}

export default function App() {
  // Background work is only reported to somebody who is signed in: the task
  // list is an admin surface, and polling it from the login screen would be a
  // guaranteed 401 every fifteen seconds.
  useTaskNotifications(isAuthenticated());

  return (
    <>
      <ScrollToTop />
      <NonPlayerHistoryTracker />
      <NotificationAnnouncer />

      <RouteColorTransition />
      <Routes>
        <Route element={<RouteTransitionOutlet />}>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/signup"
            element={
              <Suspense fallback={<LoadingSpinner label="" />}>
                <SignupPage />
              </Suspense>
            }
          />
        </Route>

        {/* Outside the server check on purpose: these are for when the server
            cannot be reached. The signed-in session remembered on this device
            is enough, since nothing here asks the server anything. */}
        <Route element={<RequireAuth />}>
          <Route
            path="/downloads"
            element={
              <Suspense fallback={<LoadingSpinner label="" />}>
                <DownloadsPage />
              </Suspense>
            }
          />
          <Route path="/downloads/watch/:itemId" element={<PlayerPage />} />
          {/* The game's sign-in: only the remembered name is handed over. */}
          <Route path="/monopoly" element={<MonopolyBridgePage />} />
          {/* The address from before the game was renamed: links and installed copies still sign in through it. */}
          <Route path="/tapu" element={<MonopolyBridgePage />} />
          <Route
            path="/alerts"
            element={
              <Suspense fallback={<LoadingSpinner label="" />}>
                <AlertsPage />
              </Suspense>
            }
          />
        </Route>

        <Route
          element={
            <DefaultServerGate>
              <Outlet />
            </DefaultServerGate>
          }
        >
          <Route path="/" element={<RootRedirect />} />
          <Route path="/app" element={<RootRedirect />} />

          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route path="/home" element={<HomePage />} />
              <Route
                element={
                  <Suspense
                    fallback={
                      <main className="flex min-h-[calc(100dvh-8rem)] items-center justify-center">
                        <LoadingSpinner label="" />
                      </main>
                    }
                  >
                    <RequireAdminAuth />
                  </Suspense>
                }
              >
                {/* One shell for the whole area: the breadcrumb, the tool
                    navigation and the content width live here, so a page only
                    renders its own work. */}
                <Route element={<DevToolsLayout />}>
                  {/* `/admin` is the name; `/dev` is kept because a dozen
                    pages link back to it and every bookmark points at it. */}
                  <Route path="/admin" element={<DevToolsPage />} />
                  <Route path="/dev" element={<DevToolsPage />} />
                  <Route
                    path="/admin/health"
                    element={<OperationsHealthPage />}
                  />
                  <Route
                    path="/admin/acquisitions"
                    element={<AcquisitionsPage />}
                  />
                  <Route
                    path="/admin/decisions"
                    element={<ReleaseDecisionsPage />}
                  />
                  <Route path="/admin/subtitles" element={<SubtitlesPage />} />
                  <Route
                    path="/admin/narration"
                    element={<NarrationReviewPage />}
                  />
                  <Route
                    path="/admin/narration/:itemId"
                    element={<NarrationReviewPage />}
                  />
                  <Route path="/admin/imports" element={<ImportsPage />} />
                  <Route path="/admin/library" element={<AdminLibraryPage />} />
                  <Route
                    path="/admin/library/:itemId"
                    element={<TitlePage />}
                  />
                  <Route
                    path="/admin/integrations"
                    element={<IntegrationsPage />}
                  />
                  <Route
                    path="/dev/playback"
                    element={<PlaybackDiagnosticsPage />}
                  />
                  <Route
                    path="/dev/media-processing"
                    element={<MediaProcessingPage />}
                  />
                  <Route
                    path="/dev/library-maintenance"
                    element={<LibraryMaintenancePage />}
                  />
                  <Route
                    path="/dev/tmdb-artwork"
                    element={<TmdbArtworkPage />}
                  />
                  <Route path="/dev/users" element={<UserManagementPage />} />
                  <Route path="/dev/curation" element={<CurationPage />} />
                  {/* The editor grew past the home page; the old path is kept so
                    a bookmark still lands somewhere real. */}
                  <Route path="/dev/home-curation" element={<CurationPage />} />
                  {import.meta.env.DEV ? (
                    <Route
                      path="/dev/skeleton-lab"
                      element={<SkeletonLabPage />}
                    />
                  ) : null}
                  {/* Tools that were merged into another keep their old
                    address, which opens the tool that absorbed them. */}
                  {Object.entries(ADMIN_REDIRECTS).map(([from, to]) => (
                    <Route
                      key={from}
                      path={from}
                      element={<Navigate to={to} replace />}
                    />
                  ))}
                </Route>
              </Route>
              <Route
                path="/my-list"
                element={
                  <Suspense fallback={<LoadingSpinner label="" />}>
                    <MyListPage />
                  </Suspense>
                }
              />
              <Route
                path="/library/:libraryId"
                element={<LibraryPage mode="library" />}
              />
              <Route
                path="/movies"
                element={<LibraryAliasPage slug="movies" />}
              />
              <Route
                path="/shows"
                element={<LibraryAliasPage slug="shows" />}
              />
              <Route
                path="/books"
                element={<LibraryAliasPage slug="books" />}
              />
              {/* Collections is off until further notice. */}
              <Route
                path="/collections"
                element={<Navigate to="/home" replace />}
              />
              <Route
                path="/movies/:libraryId"
                element={
                  <LibraryPage mode="library" libraryRouteKind="movie" />
                }
              />
              <Route
                path="/shows/:seriesId"
                element={<LibraryPage mode="series" libraryRouteKind="show" />}
              />
              <Route
                path="/shows/:seriesId/season/:seasonId"
                element={<LibraryPage mode="season" libraryRouteKind="show" />}
              />
              <Route
                path="/shows/season/:seasonId"
                element={<LibraryPage mode="season" libraryRouteKind="show" />}
              />
              <Route
                path="/collections/:libraryId"
                element={
                  <LibraryPage mode="library" libraryRouteKind="collection" />
                }
              />
              <Route
                path="/series/:seriesId"
                element={<LibraryPage mode="series" />}
              />
              <Route
                path="/series/:seriesId/season/:seasonId"
                element={<LibraryPage mode="season" />}
              />
              <Route
                path="/season/:seasonId"
                element={<LibraryPage mode="season" />}
              />
            </Route>
            <Route element={<RouteTransitionOutlet variant="player" />}>
              <Route path="/watch/:itemId" element={<PlayerPage />} />
              <Route path="/read/:itemId" element={<ReaderPage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
