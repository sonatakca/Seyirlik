/**
 * Monopoly, the board game at monopoly.seyirlik.org, takes its player's name from
 * Seyirlik. It cannot read this origin's session, so `/monopoly` hands it over (`/tapu`, its
 * old address, too):
 * signed out, `RequireAuth` sends the visitor to sign in and back; signed in,
 * the page leaves with the username and display name in the fragment, which
 * never reaches a server. The name is not a credential, only who is playing.
 */

export const MONOPOLY_ORIGIN = "https://monopoly.seyirlik.org";

/**
 * The game, told who is playing, at `back` (the game's own path and query,
 * so an invite link survives sign-in). `back` arrives in the URL, so it is
 * untrusted: anything that would leave the game's origin lands on its lobby.
 */
export function monopolyUrlFor(
  username: string,
  back?: string | null,
  displayName?: string,
  userId?: string,
): string {
  let url = new URL(MONOPOLY_ORIGIN);
  if (back?.startsWith("/")) {
    try {
      const candidate = new URL(back, MONOPOLY_ORIGIN);
      if (candidate.origin === MONOPOLY_ORIGIN) url = candidate;
    } catch {
      // Not a path; the lobby it is.
    }
  }
  url.hash = `seyirlik=${encodeURIComponent(username)}`;
  if (displayName?.trim()) url.hash += `&ad=${encodeURIComponent(displayName)}`;
  // The account’s id, which never changes and no two accounts share: the game keeps each player’s settings under it.
  if (userId) url.hash += `&id=${encodeURIComponent(userId)}`;
  return url.href;
}
