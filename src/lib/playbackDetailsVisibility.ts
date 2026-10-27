import { useSyncExternalStore } from "react";
import { isAdministrator } from "./authStorage";

/**
 * Whether the player shows its playback details chip and panel.
 *
 * The details are diagnostics — direct play or transcode, container, the
 * reasons a stream was converted — which mean something to whoever runs the
 * server and nothing to someone watching a film. So they are an administrator
 * tool, and one an administrator can hide from the administration menu when
 * they just want to watch. Held per browser, shown until switched off.
 */

export const PLAYBACK_DETAILS_STORAGE_KEY = "seyirlik-player-playback-details";
export const PLAYBACK_DETAILS_CHANGED_EVENT =
  "seyirlik:player-playback-details-changed";

export function getPlaybackDetailsEnabled(): boolean {
  if (typeof window === "undefined") return true;

  try {
    return (
      window.localStorage.getItem(PLAYBACK_DETAILS_STORAGE_KEY) !== "false"
    );
  } catch {
    return true;
  }
}

export function setPlaybackDetailsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      PLAYBACK_DETAILS_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch {
    // The current page still updates through the event when storage is blocked.
  }

  window.dispatchEvent(new Event(PLAYBACK_DETAILS_CHANGED_EVENT));
}

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  const handleStorage = (event: StorageEvent) => {
    if (event.key === PLAYBACK_DETAILS_STORAGE_KEY) onStoreChange();
  };

  window.addEventListener(PLAYBACK_DETAILS_CHANGED_EVENT, onStoreChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(PLAYBACK_DETAILS_CHANGED_EVENT, onStoreChange);
    window.removeEventListener("storage", handleStorage);
  };
}

/** The administrator's switch, regardless of who is signed in. */
export function usePlaybackDetailsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getPlaybackDetailsEnabled, () => true);
}

/** Whether this viewer sees playback details: administrators, unless hidden. */
export function useShowPlaybackDetails(): boolean {
  const enabled = usePlaybackDetailsEnabled();
  return enabled && isAdministrator();
}
