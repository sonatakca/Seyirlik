import { useSyncExternalStore } from "react";
import { isAdministrator } from "./authStorage";
import type { HeroMotion } from "../components/home/homeHeroModel";

/**
 * The motion lab: a panel over the live home hero that retunes the values it
 * moves by. Whether it shows, and what it was last set to, are kept in this
 * browser only; nothing here reaches anyone else's hero.
 */

const ENABLED_KEY = "seyirlik-motion-lab-enabled";
const VALUES_KEY = "seyirlik-motion-lab-values";
const CHANGED_EVENT = "seyirlik:motion-lab-changed";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The panel still works for this page when storage is blocked.
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function isMotionLabEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    isAdministrator() &&
    read(ENABLED_KEY) === "true"
  );
}

export function setMotionLabEnabled(enabled: boolean): void {
  write(ENABLED_KEY, enabled ? "true" : "false");
}

/** What the lab was last set to; only the values that were changed. */
export function getMotionLabValues(): Partial<HeroMotion> {
  try {
    const parsed: unknown = JSON.parse(read(VALUES_KEY) ?? "{}");
    return parsed && typeof parsed === "object"
      ? (parsed as Partial<HeroMotion>)
      : {};
  } catch {
    return {};
  }
}

export function setMotionLabValues(values: Partial<HeroMotion>): void {
  write(VALUES_KEY, JSON.stringify(values));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === ENABLED_KEY) onChange();
  };
  window.addEventListener(CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useMotionLabEnabled(): boolean {
  return useSyncExternalStore(subscribe, isMotionLabEnabled, () => false);
}
