import { describe, expect, it } from "vitest";
import { otherSearchNames } from "./searchNames";

describe("otherSearchNames", () => {
  it("lists the original, translated and added names once, without the shown title", () => {
    expect(
      otherSearchNames(
        "Ejderhanı Nasıl Eğitirsin",
        "How to Train Your Dragon",
        { tr: "Ejderhanı Nasıl Eğitirsin", en: "How to Train Your Dragon" },
        ["Dragon 1", "how to train your dragon"],
      ),
    ).toEqual(["How to Train Your Dragon", "Dragon 1"]);
  });

  it("is empty for a title known by one name", () => {
    expect(otherSearchNames("Dune", null, null, null)).toEqual([]);
    expect(otherSearchNames("Dune", "Dune", {}, [" "])).toEqual([]);
  });
});
