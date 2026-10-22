import { describe, expect, it } from "vitest";
import { heroRoundCount, heroRowParts } from "./HeroActions";

const resumed = { canStartOver: true, hasOverview: true, isFilm: false };

describe("the hero's action row", () => {
  it("preserves start over alongside the three labelled dock actions", () => {
    const parts = heroRowParts({
      ...resumed,
      compact: true,
      onTitlePage: false,
    });
    expect(parts.startOver).toBe(true);
    expect(heroRoundCount(parts)).toBe(3);
  });

  it("keeps starting over on a phone's title page, where details are below", () => {
    const parts = heroRowParts({
      ...resumed,
      compact: true,
      onTitlePage: true,
    });
    expect(parts.startOver).toBe(true);
    expect(parts.details).toBe("pill");
    expect(parts.overview).toBe(true);
  });

  it("gives a full row start over beside the Details pill", () => {
    const parts = heroRowParts({
      ...resumed,
      compact: false,
      onTitlePage: false,
    });
    expect(parts).toMatchObject({
      startOver: true,
      details: "pill",
      overview: true,
    });
    expect(heroRoundCount(parts)).toBe(3);
  });
});
