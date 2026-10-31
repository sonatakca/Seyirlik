import { describe, expect, it } from "vitest";
import { monopolyUrlFor } from "./monopolyBridge";

describe("monopoly bridge", () => {
  it("hands the username over in the fragment, encoded", () => {
    expect(monopolyUrlFor("sonat")).toBe(
      "https://monopoly.seyirlik.org/#seyirlik=sonat",
    );
    expect(monopolyUrlFor("Ayşe & Can")).toBe(
      "https://monopoly.seyirlik.org/#seyirlik=Ay%C5%9Fe%20%26%20Can",
    );
  });

  it("includes the visible name separately from the login username", () => {
    const url = new URL(monopolyUrlFor("sonat", "/?oda=AB12", "Ayşe & Can"));
    const identity = new URLSearchParams(url.hash.slice(1));
    expect(identity.get("seyirlik")).toBe("sonat");
    expect(identity.get("ad")).toBe("Ayşe & Can");
    expect(url.searchParams.get("oda")).toBe("AB12");
    expect(url.searchParams.has("ad")).toBe(false);
  });

  it("includes the account id when provided and omits it otherwise", () => {
    const userId = "8f14e45f-ceea-467a-9575-9d7b1c3b6a21";
    const url = new URL(monopolyUrlFor("sonat", null, "Sonat", userId));
    const identity = new URLSearchParams(url.hash.slice(1));
    expect(identity.get("id")).toBe(userId);
    expect(identity.get("seyirlik")).toBe("sonat");

    const legacyUrl = new URL(monopolyUrlFor("sonat"));
    expect(new URLSearchParams(legacyUrl.hash.slice(1)).has("id")).toBe(false);
  });

  it("returns to the invite the game was opened with", () => {
    expect(monopolyUrlFor("sonat", "/?oda=AB12")).toBe(
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
      expect(new URL(monopolyUrlFor("sonat", back)).origin).toBe(
        "https://monopoly.seyirlik.org",
      );
    }
  });
});
