import { describe, expect, it } from "vitest";
import { fitDeck, type DeckFitInput } from "./sahneDeckFit";

const base: DeckFitInput = {
  width: 1364,
  current: "36:14",
  total: " / 1:03:14",
  salonWidth: 104,
  hasQueue: true,
  canPip: true,
  canNative: true,
  canFullscreen: true,
};

describe("fitDeck", () => {
  it("keeps everything on a wide deck", () => {
    const fit = fitDeck(base);
    expect([...fit.hidden]).toEqual([]);
    expect(fit.more).toBe(false);
  });

  it("gives up the end time and the slider's room before any control", () => {
    const fit = fitDeck({ ...base, width: 760 });
    expect(fit.hidden.has("ends")).toBe(true);
    expect(fit.hidden.has("seek")).toBe(false);
  });

  it("moves controls into the more menu as the deck narrows", () => {
    const fit = fitDeck({ ...base, width: 520 });
    expect(fit.more).toBe(true);
    expect(fit.hidden.has("native")).toBe(true);
    expect(fit.hidden.has("pip")).toBe(true);
  });

  it("never hides play, the time, the lobby, settings or full screen", () => {
    const fit = fitDeck({ ...base, width: 200 });
    const all = ["ends", "volumeSlider", "native", "pip", "seek", "queue", "volume", "salonLabel", "duration"];
    expect([...fit.hidden].sort()).toEqual(all.sort());
  });

  it("only hides what a deck has", () => {
    const fit = fitDeck({ ...base, width: 520, hasQueue: false, canPip: false, canNative: false });
    expect(fit.hidden.has("queue")).toBe(false);
    expect(fit.hidden.has("pip")).toBe(false);
  });

  it("drops one thing at a time: a little narrower never shows more", () => {
    let previous = -1;
    for (let width = 1400; width >= 200; width -= 10) {
      const count = fitDeck({ ...base, width }).hidden.size;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });
});
