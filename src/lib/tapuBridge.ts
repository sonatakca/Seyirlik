/**
 * Tapu, the board game at monopoly.seyirlik.org, takes its player's name from
 * Seyirlik. It cannot read this origin's session, so `/tapu` hands it over:
 * signed out, `RequireAuth` sends the visitor to sign in and back; signed in,
 * the page leaves with the username and display name in the fragment, which
 * never reaches a server. The name is not a credential, only who is playing.
 */

export const TAPU_ORIGIN = "https://monopoly.seyirlik.org";

/**
 * The game, told who is playing, at `back` (the game's own path and query,
 * so an invite link survives sign-in). `back` arrives in the URL, so it is
 * untrusted: anything that would leave the game's origin lands on its lobby.
 */
export function tapuUrlFor(
  username: string,
  back?: string | null,
  displayName?: string,
  userId?: string,
): string {
  let url = new URL(TAPU_ORIGIN);
  if (back?.startsWith("/")) {
    try {
      const candidate = new URL(back, TAPU_ORIGIN);
      if (candidate.origin === TAPU_ORIGIN) url = candidate;
    } catch {
      // Not a path; the lobby it is.
    }
  }
  url.hash = `seyirlik=${encodeURIComponent(username)}`;
  if (displayName?.trim()) url.hash += `&ad=${encodeURIComponent(displayName)}`;
  // The account’s id, which never changes and no two accounts share: Tapu keeps each player’s settings under it.
  if (userId) url.hash += `&id=${encodeURIComponent(userId)}`;
  return url.href;
}
