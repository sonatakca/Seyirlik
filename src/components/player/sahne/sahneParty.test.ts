import { describe, expect, it } from "vitest";
import type { PartyParticipant } from "../../../features/partyWatch/partyWatchTypes";
import {
  assignColours,
  DISC_COLOURS,
  initialOf,
  partyDiscs,
  SELF_DISC,
} from "./sahneParty";

const person = (id: string, displayName: string): PartyParticipant => ({
  id,
  userId: id.split(":")[0],
  displayName,
  isOwner: false,
  presence: "connected",
  status: "ready",
});

describe("party discs", () => {
  it("puts the viewer first, light, then everyone else in a colour each", () => {
    const people = [person("b:1", "Ece"), person("me:1", "Sonat"), person("c:1", "Mert")];
    const assigned = assignColours(people, "me:1", new Map());
    const discs = partyDiscs(people, "me:1", assigned, "Sen", "tr");
    expect(discs.map((disc) => disc.name)).toEqual(["Sen", "Ece", "Mert"]);
    expect(discs[0]).toMatchObject({ self: true, color: SELF_DISC.color });
    expect(discs[1].color).toBe(DISC_COLOURS[0].color);
    expect(discs[2].color).toBe(DISC_COLOURS[1].color);
  });

  it("keeps a person's colour when someone before them leaves", () => {
    const all = [person("me:1", "Sonat"), person("b:1", "Ece"), person("c:1", "Mert")];
    const assigned = assignColours(all, "me:1", new Map());
    const after = all.filter((p) => p.id !== "b:1");
    const discs = partyDiscs(after, "me:1", assignColours(after, "me:1", assigned), "Sen", "tr");
    expect(discs.find((disc) => disc.name === "Mert")?.color).toBe(DISC_COLOURS[1].color);
  });

  it("returns the same map when nobody new arrived", () => {
    const people = [person("me:1", "Sonat"), person("b:1", "Ece")];
    const assigned = assignColours(people, "me:1", new Map());
    expect(assignColours(people, "me:1", assigned)).toBe(assigned);
  });

  it("capitalises the initial the Turkish way", () => {
    expect(initialOf("ilker", "tr")).toBe("İ");
    expect(initialOf("ilker", "en")).toBe("I");
  });
});
