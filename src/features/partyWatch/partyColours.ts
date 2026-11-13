/**
 * Each person's colour in a party, the same on every screen.
 *
 * A colour is a user's, not a viewer's idea of them: it comes from the user id,
 * which every member of the party knows, so everyone sees everyone (themselves
 * included) in the same colour, and a user keeps theirs from party to party.
 * The six colours are the six bars of the Seyirlik mark. When two users in one
 * party would share a colour, the one who joined first keeps it and the other
 * takes the next one free; join order is the order of the server's participant
 * list, which every member receives alike. Someone arriving never changes
 * anyone's colour; someone leaving can only hand a colour back to the person
 * who had to take another because of them. That is the price of every screen
 * agreeing: a screen that remembered colours would disagree with one that
 * joined later.
 */
export interface PartyColour {
  color: string;
  /** The ink that reads on it. */
  ink: string;
}

export const PARTY_COLOURS: readonly PartyColour[] = [
  { color: "#bd3f28", ink: "#ffffff" },
  { color: "#fa9b1d", ink: "#0a0b0c" },
  { color: "#d3ca22", ink: "#0a0b0c" },
  { color: "#bacb7d", ink: "#0a0b0c" },
  { color: "#67a478", ink: "#0a0b0c" },
  { color: "#337b6c", ink: "#ffffff" },
];

/** FNV-1a: small, stable, and the same in every browser. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** The colour a user would have alone. */
export function preferredPartyColour(userId: string): number {
  return hash(userId) % PARTY_COLOURS.length;
}

/**
 * Every user's colour in this party, from its participants in join order.
 * A user on two devices is one user, with one colour.
 */
export function partyColours(
  participants: ReadonlyArray<{ userId: string }>,
): Map<string, PartyColour> {
  const taken = new Set<number>();
  const byUser = new Map<string, PartyColour>();
  for (const { userId } of participants) {
    if (byUser.has(userId)) continue;
    const preferred = preferredPartyColour(userId);
    let chosen = preferred;
    // With more users than colours, colours repeat from the preferred one.
    for (let step = 0; step < PARTY_COLOURS.length; step += 1) {
      const candidate = (preferred + step) % PARTY_COLOURS.length;
      if (!taken.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    taken.add(chosen);
    byUser.set(userId, PARTY_COLOURS[chosen]);
  }
  return byUser;
}
