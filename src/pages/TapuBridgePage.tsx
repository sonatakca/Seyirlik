import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { getCachedSession } from "../lib/authStorage";
import { tapuUrlFor } from "../lib/tapuBridge";

/** `/tapu`: on to the game as whoever is signed in here. */
export function TapuBridgePage() {
  const session = getCachedSession();
  const username = session?.username;
  const displayName = session?.displayName;
  const back = new URLSearchParams(useLocation().search).get("back");

  useEffect(() => {
    // Replace, so Back from the game returns to the page the menu was on.
    if (username)
      window.location.replace(tapuUrlFor(username, back, displayName));
  }, [username, back, displayName]);

  return (
    <main className="flex min-h-dvh items-center justify-center">
      <LoadingSpinner label="" />
    </main>
  );
}
