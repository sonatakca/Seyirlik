import { useState } from "react";
import type { PartyNotice, PartySessionState } from "../../../features/partyWatch/partySession";
import type { PartyConnection } from "../../../features/partyWatch/partySession";
import type { PartyParticipant } from "../../../features/partyWatch/partyWatchTypes";

/**
 * The people in a party as Sahne draws them: one coloured disc each, beside
 * the top buttons. Colours come from the six bars of the Seyirlik mark, given
 * out in the order people are first seen, so a person keeps theirs for as long
 * as they stay. The viewer's own disc is the light one.
 */
export interface PartyDisc {
  id: string;
  name: string;
  initial: string;
  color: string;
  ink: string;
  self: boolean;
}

export const SELF_DISC = { color: "#e8ecef", ink: "#0a0b0c" } as const;

/** The logo's bars, with the ink that reads on each. */
export const DISC_COLOURS: ReadonlyArray<{ color: string; ink: string }> = [
  { color: "#fa9b1d", ink: "#0a0b0c" },
  { color: "#bacb7d", ink: "#0a0b0c" },
  { color: "#bd3f28", ink: "#ffffff" },
  { color: "#67a478", ink: "#0a0b0c" },
  { color: "#d3ca22", ink: "#0a0b0c" },
  { color: "#337b6c", ink: "#ffffff" },
];

export function initialOf(name: string, language: string): string {
  const first = Array.from(name.trim())[0] ?? "?";
  return first.toLocaleUpperCase(language === "tr" ? "tr-TR" : language);
}

/** `assigned` extended with anyone not yet given a colour, in list order. */
export function assignColours(
  participants: readonly PartyParticipant[],
  selfId: string,
  assigned: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const missing = participants.filter(
    (person) => person.id !== selfId && !assigned.has(person.id),
  );
  if (missing.length === 0) return assigned;
  const next = new Map(assigned);
  for (const person of missing) next.set(person.id, next.size);
  return next;
}

/**
 * Orders the people (the viewer first, then everyone else in the order they
 * were first seen) and colours them from `assigned`.
 */
export function partyDiscs(
  participants: readonly PartyParticipant[],
  selfId: string,
  assigned: ReadonlyMap<string, number>,
  selfName: string,
  language: string,
): PartyDisc[] {
  const others = participants.filter((person) => person.id !== selfId);
  const ordered = [...others].sort(
    (left, right) => (assigned.get(left.id) ?? 0) - (assigned.get(right.id) ?? 0),
  );
  const discs: PartyDisc[] = [];
  if (participants.some((person) => person.id === selfId)) {
    discs.push({
      id: selfId,
      name: selfName,
      initial: initialOf(selfName, language),
      color: SELF_DISC.color,
      ink: SELF_DISC.ink,
      self: true,
    });
  }
  for (const person of ordered) {
    const colour = DISC_COLOURS[(assigned.get(person.id) ?? 0) % DISC_COLOURS.length];
    discs.push({
      id: person.id,
      name: person.displayName,
      initial: initialOf(person.displayName, language),
      color: colour.color,
      ink: colour.ink,
      self: false,
    });
  }
  return discs;
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
  selfName: string,
  language: string,
): SahneParty {
  const snapshot = state?.snapshot ?? null;
  const live = state && snapshot && state.connection !== "ended" ? snapshot : null;
  const [assigned, setAssigned] = useState<ReadonlyMap<string, number>>(new Map());
  const nextAssigned = live ? assignColours(live.participants, state!.selfId, assigned) : assigned;
  if (nextAssigned !== assigned) setAssigned(nextAssigned);
  const discs = live
    ? partyDiscs(live.participants, state!.selfId, nextAssigned, selfName, language)
    : [];
  // People who have left keep their colour for their own leaving note.
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
