import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { getCachedSession } from "../lib/authStorage";
import { monopolyUrlFor } from "../lib/monopolyBridge";

/** `/monopoly` (and the old `/tapu`): on to the game as whoever is signed in here. */
export function MonopolyBridgePage() {
  const session = getCachedSession();
  const username = session?.username;
  const displayName = session?.displayName;
  const userId = session?.userId;
  const back = new URLSearchParams(useLocation().search).get("back");

  useEffect(() => {
    // Replace, so Back from the game returns to the page the menu was on.
    if (username)
      window.location.replace(
        monopolyUrlFor(username, back, displayName, userId),
      );
  }, [username, back, displayName, userId]);

  return (
    <main className="flex min-h-dvh items-center justify-center">
      <LoadingSpinner label="" />
    </main>
  );
}
