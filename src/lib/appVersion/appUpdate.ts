import { releaseNoteProblem, type BuildInfo } from "./buildInfo";

/*
 * Notices when a newer build of the site is live, and moves this tab onto it.
 *
 * The service worker precaches the app shell, so a tab opened after a deploy
 * is served the build it last saw, and a reload only swaps it once the new
 * worker has installed in the background. The tab could run the old build for
 * a whole session without anyone knowing. So the page asks the origin which
 * build is live (`/version.json`, never cached), and when it differs from the
 * one running, offers an update in the navbar.
 *
 * Applying it brings the new worker in, clears what would still serve the old
 * build, and reloads. A reload that starts on a stale build does the same once,
 * so pressing reload is enough too.
 */

export const RUNNING_BUILD: BuildInfo = __SEYIRLIK_BUILD__;

/** Titles kept for offline playback. A site update must never cost these. */
const KEPT_CACHE_PREFIX = "seyirlik-offline";
const AUTO_APPLY_KEY = "seyirlik.update.autoApplied";
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const MIN_CHECK_GAP_MS = 60 * 1000;
const ACTIVATION_TIMEOUT_MS = 10 * 1000;

export type AppUpdateState =
  | { status: "current" }
  | { status: "available"; latest: BuildInfo }
  | { status: "applying"; latest: BuildInfo };

let state: AppUpdateState = { status: "current" };
const listeners = new Set<() => void>();

function setState(next: AppUpdateState) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function getAppUpdateState(): AppUpdateState {
  return state;
}

export function subscribeToAppUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The build the origin is serving now, or null when it cannot be learned. */
export async function fetchLiveBuild(): Promise<BuildInfo | null> {
  try {
    const response = await fetch(`/version.json?t=${Date.now()}`, {
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<BuildInfo>;
    if (typeof body.buildId !== "string" || typeof body.version !== "string") {
      return null;
    }
    // A note is only shown as written; anything else reads as none.
    const { note, ...build } = body as BuildInfo;
    if (note === undefined) return build;
    return { ...build, note: releaseNoteProblem(note) === null ? note : null };
  } catch {
    // Offline, or the origin is down: neither says anything about versions.
    return null;
  }
}

let lastCheckAt = 0;

/** Learns whether a newer build is live; returns it when one is. */
export async function checkForAppUpdate(): Promise<BuildInfo | null> {
  lastCheckAt = Date.now();
  const live = await fetchLiveBuild();
  if (!live || live.buildId === RUNNING_BUILD.buildId) return null;
  if (state.status !== "applying") {
    setState({ status: "available", latest: live });
  }
  return live;
}

function waitForActivation(registration: ServiceWorkerRegistration) {
  const incoming = registration.installing ?? registration.waiting;
  if (!incoming) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, ACTIVATION_TIMEOUT_MS);
    const settle = () => {
      if (incoming.state === "activated" || incoming.state === "redundant") {
        window.clearTimeout(timeout);
        incoming.removeEventListener("statechange", settle);
        resolve();
      }
    };
    incoming.addEventListener("statechange", settle);
    settle();
  });
}

/**
 * Deletes caches that belong to no live worker: anything but the precache and
 * the downloaded titles.
 *
 * The precache is never touched. It used to be dropped whenever it still held
 * the old shell, but that is exactly its state while a new worker installs —
 * and on a phone that takes longer than the wait for activation. Deleting it
 * then left the active worker with no shell at all, and a worker still
 * installing into it activated with a partial copy. Nothing showed online,
 * where every miss falls through to the network; offline, every page load
 * failed inside the worker. The worker keeps the precache in step itself:
 * activation removes the old revisions.
 */
export async function purgeStaleCaches(): Promise<string[]> {
  if (typeof caches === "undefined") return [];
  const deleted: string[] = [];

  for (const name of await caches.keys()) {
    if (name.startsWith(KEPT_CACHE_PREFIX) || name.includes("precache")) {
      continue;
    }
    if (await caches.delete(name)) deleted.push(name);
  }
  return deleted;
}

/**
 * Moves this tab onto the newest build: the new service worker first, so it
 * is the one answering, then any stray cache, then a reload. Never unregisters the worker — that would drop push alerts.
 */
export async function applyAppUpdate(): Promise<void> {
  if (state.status === "applying") return;
  const latest =
    state.status === "available" ? state.latest : await fetchLiveBuild();
  if (!latest) {
    window.location.reload();
    return;
  }
  setState({ status: "applying", latest });

  try {
    const registration =
      "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistration()
        : undefined;
    if (registration) {
      await registration.update().catch(() => undefined);
      await waitForActivation(registration);
    }
    await purgeStaleCaches();
  } catch {
    // Whatever was not cleared, the reload still asks the network.
  } finally {
    window.location.reload();
  }
}

function readAutoApplied() {
  try {
    return window.sessionStorage.getItem(AUTO_APPLY_KEY);
  } catch {
    return null;
  }
}

function writeAutoApplied(buildId: string) {
  try {
    window.sessionStorage.setItem(AUTO_APPLY_KEY, buildId);
  } catch {
    // Without storage, the loop guard is lost; the button still works.
  }
}

/**
 * Checks once at start, then on an interval and whenever the tab comes back.
 *
 * A stale build found at start is replaced right away — the page has only
 * just loaded, so nothing is interrupted, and this is what makes a plain
 * reload enough. It is tried once per build per tab: if the origin and the
 * worker disagree for longer than that, the button is left to the person
 * rather than reloading in a loop. Found any later, it is only offered.
 */
export function startAppUpdateWatch(): () => void {
  if (import.meta.env.DEV) return () => undefined;

  void checkForAppUpdate().then((latest) => {
    if (!latest || readAutoApplied() === latest.buildId) return;
    writeAutoApplied(latest.buildId);
    void applyAppUpdate();
  });

  const checkIfDue = () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastCheckAt < MIN_CHECK_GAP_MS) return;
    void checkForAppUpdate();
  };
  // A lazy route whose chunk the deploy removed fails to load; if that is
  // because a newer build is live, moving onto it is the repair.
  const onPreloadError = () => {
    void checkForAppUpdate().then((latest) => {
      if (latest && readAutoApplied() !== latest.buildId) {
        writeAutoApplied(latest.buildId);
        void applyAppUpdate();
      }
    });
  };

  const interval = window.setInterval(checkIfDue, CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", checkIfDue);
  window.addEventListener("online", checkIfDue);
  window.addEventListener("vite:preloadError", onPreloadError);

  return () => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", checkIfDue);
    window.removeEventListener("online", checkIfDue);
    window.removeEventListener("vite:preloadError", onPreloadError);
  };
}

/** Test seam: forget what this module has learned. */
export function resetAppUpdateForTests() {
  state = { status: "current" };
  lastCheckAt = 0;
  listeners.clear();
}
