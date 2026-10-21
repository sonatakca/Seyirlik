import { useSyncExternalStore } from "react";

/**
 * Whether an administrator sees the admin dock on title pages.
 *
 * Kept on the device rather than on the account: the same person runs the
 * library from a laptop and watches on the living-room screen, and hiding the
 * tools there should not take them away from the laptop. Shown by default, so
 * the dock is found without first having to know it can be switched on.
 */
export const ADMIN_DOCK_HIDDEN_STORAGE_KEY = "seyirlik-admin-dock-hidden";
const CHANGED_EVENT = "seyirlik:admin-dock-changed";

export function getAdminDockHidden(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(ADMIN_DOCK_HIDDEN_STORAGE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

export function setAdminDockHidden(hidden: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (hidden) {
      window.localStorage.setItem(ADMIN_DOCK_HIDDEN_STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(ADMIN_DOCK_HIDDEN_STORAGE_KEY);
    }
  } catch {
    // The current page still updates through the event when storage is blocked.
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ADMIN_DOCK_HIDDEN_STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGED_EVENT, onChange);
  // Another tab switching it off should not leave this one showing the dock.
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAdminDockHidden(): boolean {
  return useSyncExternalStore(subscribe, getAdminDockHidden, () => false);
}
