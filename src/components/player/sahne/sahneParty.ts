import { useState } from "react";
import { partyColours } from "../../../features/partyWatch/partyColours";
import type {
  PartyNotice,
  PartySessionState,
} from "../../../features/partyWatch/partySession";
import type { PartyConnection } from "../../../features/partyWatch/partySession";
import type { PartyParticipant } from "../../../features/partyWatch/partyWatchTypes";

/**
 * The people in a party as Sahne draws them: one coloured disc each, beside
 * the top buttons. A person's colour is theirs on every screen, the viewer's
 * own screen included (see `partyColours`), and their initial is the first
 * letter of the name everyone else sees.
 */
export interface PartyDisc {
  id: string;
  name: string;
  initial: string;
  color: string;
  ink: string;
  self: boolean;
}

export function initialOf(name: string, language: string): string {
  const first = Array.from(name.trim())[0] ?? "?";
  return first.toLocaleUpperCase(language === "tr" ? "tr-TR" : language);
}

/**
 * The viewer first, then everyone else in the order they joined, each in their
 * user's colour.
 */
export function partyDiscs(
  participants: readonly PartyParticipant[],
  selfId: string,
  language: string,
): PartyDisc[] {
  const colours = partyColours(participants);
  const ordered = [
    ...participants.filter((person) => person.id === selfId),
    ...participants.filter((person) => person.id !== selfId),
  ];
  return ordered.map((person) => {
    const colour = colours.get(person.userId);
    return {
      id: person.id,
      name: person.displayName,
      initial: initialOf(person.displayName, language),
      color: colour?.color ?? "#e8ecef",
      ink: colour?.ink ?? "#0a0b0c",
      self: person.id === selfId,
    };
  });
}

export interface SahneParty {
  connection: PartyConnection | null;
  discs: PartyDisc[];
  /** Everyone the group is holding for, the viewer excluded. */
  waitingFor: string[];
  notice: PartyNotice | null;
  /** The disc of whoever caused the current notice, if they are still here. */
  actor: PartyDisc | null;
  commandFailed: boolean;
}

/** What Sahne needs from a party, recomputed on every change of its state. */
export function useSahneParty(
  state: PartySessionState | null,
  language: string,
): SahneParty {
  const snapshot = state?.snapshot ?? null;
  const live =
    state && snapshot && state.connection !== "ended" ? snapshot : null;
  const discs = live
    ? partyDiscs(live.participants, state!.selfId, language)
    : [];
  // People who have left keep their disc for their own leaving note.
  const [known, setKnown] = useState<ReadonlyMap<string, PartyDisc>>(new Map());
  const unknown = discs.filter((disc) => !known.has(disc.id));
  let nextKnown = known;
  if (unknown.length > 0) {
    const map = new Map(known);
    for (const disc of discs) map.set(disc.id, disc);
    nextKnown = map;
    setKnown(map);
  }
  const notice = state?.notice ?? null;
  const actorId = notice?.cause.participantId ?? null;
  const actor = actorId ? (nextKnown.get(actorId) ?? null) : null;
  return {
    connection: state?.connection ?? null,
    discs,
    waitingFor:
      snapshot?.hold?.waitingFor.filter((id) => id !== state?.selfId) ?? [],
    notice,
    actor,
    commandFailed: state?.commandFailed ?? false,
  };
}
