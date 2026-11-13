import { describe, expect, it } from "vitest";
import {
  partyColours,
  PARTY_COLOURS,
  preferredPartyColour,
} from "../../../features/partyWatch/partyColours";
import type { PartyParticipant } from "../../../features/partyWatch/partyWatchTypes";
import { initialOf, partyDiscs } from "./sahneParty";

const person = (
  userId: string,
  client: string,
  displayName: string,
): PartyParticipant => ({
  id: `${userId}:${client}`,
  userId,
  displayName,
  isOwner: false,
  presence: "connected",
  status: "ready",
});

const qa = person("user-qa", "1", "QA");
const sonat = person("user-sonat", "1", "Sonat");
const ece = person("user-ece", "1", "Ece");

describe("party colours", () => {
  it("gives every member the same colours, whoever is looking", () => {
    const party = [sonat, qa, ece];
    const onSonat = partyDiscs(party, sonat.id, "tr");
    const onQa = partyDiscs(party, qa.id, "tr");
    const colourOf = (discs: ReturnType<typeof partyDiscs>, id: string) =>
      discs.find((disc) => disc.id === id)?.color;
    for (const member of party) {
      expect(colourOf(onSonat, member.id)).toBe(colourOf(onQa, member.id));
    }
  });

  it("keeps a user's colour from party to party when nobody clashes", () => {
    const alone = partyColours([qa]).get("user-qa");
    expect(alone).toBe(PARTY_COLOURS[preferredPartyColour("user-qa")]);
  });

  it("never gives two users the same colour while there are colours left", () => {
    const party = Array.from({ length: 6 }, (_, index) =>
      person(`u${index}`, "1", `P${index}`),
    );
    const colours = new Set(
      [...partyColours(party).values()].map((colour) => colour.color),
    );
    expect(colours.size).toBe(6);
  });

  it("does not change anyone's colour when someone arrives", () => {
    const before = partyColours([sonat, qa, ece]);
    const afterJoin = partyColours([
      sonat,
      qa,
      ece,
      person("user-new", "1", "Yeni"),
    ]);
    for (const userId of ["user-sonat", "user-qa", "user-ece"]) {
      expect(afterJoin.get(userId)).toBe(before.get(userId));
    }
  });

  it("hands a colour back only to whoever had to give way for it", () => {
    // Find two users who want the same colour.
    const ids = Array.from({ length: 40 }, (_, index) => `clash-${index}`);
    const first = ids[0];
    const second = ids.find(
      (id) =>
        id !== first &&
        preferredPartyColour(id) === preferredPartyColour(first),
    )!;
    const a = person(first, "1", "A");
    const b = person(second, "1", "B");
    const together = partyColours([a, b]);
    expect(together.get(second)).not.toBe(together.get(first));
    expect(partyColours([b]).get(second)).toBe(
      PARTY_COLOURS[preferredPartyColour(second)],
    );
  });

  it("gives one user on two devices one colour", () => {
    const phone = person("user-sonat", "2", "Sonat");
    const colours = partyColours([sonat, phone, qa]);
    const discs = partyDiscs([sonat, phone, qa], qa.id, "tr");
    expect(discs.find((d) => d.id === sonat.id)?.color).toBe(
      discs.find((d) => d.id === phone.id)?.color,
    );
    expect(colours.size).toBe(2);
  });

  it("puts the viewer first, then the others in join order", () => {
    const discs = partyDiscs([sonat, qa, ece], ece.id, "tr");
    expect(discs.map((disc) => disc.name)).toEqual(["Ece", "Sonat", "QA"]);
    expect(discs[0].self).toBe(true);
  });

  it("capitalises the initial the Turkish way", () => {
    expect(initialOf("ilker", "tr")).toBe("İ");
    expect(initialOf("ilker", "en")).toBe("I");
  });
});
