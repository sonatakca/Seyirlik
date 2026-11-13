import { useCallback, useSyncExternalStore } from "react";

/**
 * Which player a viewer watches in.
 *
 * `classic` is the player Seyirlik has always had: controls drawn over the
 * picture. `sahne` is the stage: the picture steps back into a room and the
 * controls stand in the room beside it. The choice belongs to the device, like
 * the picture fit, and classic is what a device gets until someone chooses.
 */
export type PlayerUi = "classic" | "sahne";

export const PLAYER_UIS: readonly PlayerUi[] = ["classic", "sahne"];

const STORAGE_KEY = "seyirlik:player-ui";
const CHANGE_EVENT = "seyirlik:player-ui-change";

export function readStoredPlayerUi(): PlayerUi {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "sahne"
      ? "sahne"
      : "classic";
  } catch {
    return "classic";
  }
}

export function storePlayerUi(ui: PlayerUi): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, ui);
  } catch {
    // Private browsing: the choice still holds for this visit's open players.
  }
  window.dispatchEvent(new CustomEvent<PlayerUi>(CHANGE_EVENT, { detail: ui }));
}

/**
 * The stored choice, when it cannot be read back (private browsing), still has
 * to reach a player that is already open, so the last value dispatched wins
 * over storage for the rest of the visit.
 */
let lastDispatched: PlayerUi | null = null;

function subscribe(onChange: () => void): () => void {
  const handleChange = (event: Event) => {
    lastDispatched = (event as CustomEvent<PlayerUi>).detail ?? null;
    onChange();
  };
  // Another tab changing it reaches this one through `storage`.
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    lastDispatched = null;
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, handleChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function getSnapshot(): PlayerUi {
  return lastDispatched ?? readStoredPlayerUi();
}

export function usePlayerUi(): [PlayerUi, (ui: PlayerUi) => void] {
  const ui = useSyncExternalStore<PlayerUi>(
    subscribe,
    getSnapshot,
    () => "classic",
  );
  const setUi = useCallback((next: PlayerUi) => storePlayerUi(next), []);
  return [ui, setUi];
}

/*
 * Choosing another episode in Sahne's lobby goes to a new page, and the page
 * mounts a new player. The lobby is carried across: the choice is noted here
 * with the picture's shape, the wait draws the next episode where the lobby
 * picture stands, and the new player opens straight into its lobby.
 *
 * The note lives in memory only. It crosses the move inside the app and
 * never a reload, so nothing has to consume it: the page briefly hands the
 * outgoing player the new episode, and consuming it there once left the new
 * player nothing to find.
 */
/** Long enough for the next episode to load, short enough not to linger. */
const CARRY_TTL_MS = 20_000;

export interface SahneLobbyCarry {
  itemId: string;
  aspect: number;
  at: number;
}

let carry: SahneLobbyCarry | null = null;

export function carrySahneLobby(itemId: string, aspect: number): void {
  carry = { itemId, aspect, at: Date.now() };
}

export function peekSahneLobbyCarry(itemId: string): SahneLobbyCarry | null {
  if (!carry || carry.itemId !== itemId) return null;
  if (Date.now() - carry.at > CARRY_TTL_MS) return null;
  return carry;
}

/** Forget the carry, as when the viewer leaves the lobby. */
export function dropSahneLobbyCarry(): void {
  carry = null;
}
