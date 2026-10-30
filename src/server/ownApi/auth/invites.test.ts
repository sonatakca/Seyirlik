import { describe, expect, it } from "vitest";
import { canonicalInviteCode, hashInviteCode, newInviteCode } from "./invites";
import { validateSignupPassword, validateSignupUsername } from "./passwords";

describe("invite codes", () => {
  it("are twelve unambiguous characters in three groups", () => {
    for (let index = 0; index < 50; index += 1) {
      expect(newInviteCode()).toMatch(
        /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/,
      );
    }
  });

  it("read the way a person types them", () => {
    expect(canonicalInviteCode(" 7kq2 m9xd-4twb ")).toBe("7KQ2M9XD4TWB");
    // O for zero and I or L for one are the slips the alphabet forgives.
    expect(canonicalInviteCode("OIL2-M9XD-4TWB")).toBe("0112M9XD4TWB");
    expect(canonicalInviteCode("7KQ2-M9XD")).toBeNull();
    expect(canonicalInviteCode("UUUU-M9XD-4TWB")).toBeNull();
  });

  it("hash to the same key however they were typed", () => {
    const secret = "s".repeat(32);
    expect(
      hashInviteCode(canonicalInviteCode("7kq2-m9xd-4twb") as string, secret),
    ).toEqual(hashInviteCode("7KQ2M9XD4TWB", secret));
  });
});

describe("a username and password chosen at sign-up", () => {
  it("allows plain sign-in names and normalizes case", () => {
    expect(validateSignupUsername("Ayse.Yilmaz")).toBe("ayse.yilmaz");
    expect(validateSignupUsername("m_k-9")).toBe("m_k-9");
  });

  it("refuses spaces, lookalikes, edges and short names", () => {
    for (const name of [
      "ay",
      "ayşe",
      "ay se",
      ".ayse",
      "ayse-",
      "a".repeat(33),
    ]) {
      expect(() => validateSignupUsername(name)).toThrow();
    }
  });

  it("requires at least eight characters of password", () => {
    expect(() => validateSignupPassword("")).toThrow();
    expect(() => validateSignupPassword("seven77")).toThrow();
    expect(validateSignupPassword("eight888")).toBe("eight888");
  });
});
