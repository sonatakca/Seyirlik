import { describe, expect, it } from "vitest";
import { tapuUrlFor } from "./tapuBridge";

describe("tapu bridge", () => {
  it("hands the username over in the fragment, encoded", () => {
    expect(tapuUrlFor("sonat")).toBe(
      "https://monopoly.seyirlik.org/#seyirlik=sonat",
    );
    expect(tapuUrlFor("Ayşe & Can")).toBe(
      "https://monopoly.seyirlik.org/#seyirlik=Ay%C5%9Fe%20%26%20Can",
    );
  });

  it("includes the visible name separately from the login username", () => {
    const url = new URL(tapuUrlFor("sonat", "/?oda=AB12", "Ayşe & Can"));
    const identity = new URLSearchParams(url.hash.slice(1));
    expect(identity.get("seyirlik")).toBe("sonat");
    expect(identity.get("ad")).toBe("Ayşe & Can");
    expect(url.searchParams.get("oda")).toBe("AB12");
    expect(url.searchParams.has("ad")).toBe(false);
  });

  it("returns to the invite the game was opened with", () => {
    expect(tapuUrlFor("sonat", "/?oda=AB12")).toBe(
      "https://monopoly.seyirlik.org/?oda=AB12#seyirlik=sonat",
    );
  });

  it("never leaves the game's origin", () => {
    for (const back of [
      "https://evil.example/",
      "//evil.example/x",
      "/\\evil.example",
      "javascript:alert(1)",
    ]) {
      expect(new URL(tapuUrlFor("sonat", back)).origin).toBe(
        "https://monopoly.seyirlik.org",
      );
    }
  });
});
