// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ARGON2ID_OPTIONS,
  createArgon2PasswordHasher,
  normalizeUsername,
  validatePassword,
  validateUsername,
} from "./passwords";

describe("native password handling", () => {
  it("normalizes usernames with NFKC, trimming, and locale-stable lowercase", () => {
    expect(normalizeUsername("  AdMiN  ")).toBe("admin");
    expect(normalizeUsername("ＳＥＹＩＲＬＩＫ")).toBe("seyirlik");
  });

  it("accepts any username the administrator chooses, within the schema's bounds", () => {
    expect(validateUsername("ab")).toBe("ab");
    expect(validateUsername("Ali Veli")).toBe("ali veli");
    expect(validateUsername("Ayşe")).toBe("ayşe");
    expect(validateUsername("Çağla")).toBe("çağla");
    expect(validateUsername("q")).toBe("q");

    expect(() => validateUsername("")).toThrow();
    expect(() => validateUsername("   ")).toThrow();
    expect(() => validateUsername("a\nb")).toThrow();
    expect(validateUsername("ş".repeat(64))).toBe("ş".repeat(64));
    expect(() => validateUsername("ş".repeat(65))).toThrow();
  });

  it("accepts any password, including none, up to the hashing bound", () => {
    expect(validatePassword("")).toBe("");
    expect(validatePassword("qa-motion")).toBe("qa-motion");
    expect(validatePassword("🔐".repeat(32))).toBe("🔐".repeat(32));
    expect(() => validatePassword("🔐".repeat(33))).toThrow();
    expect(() => validatePassword("x".repeat(129))).toThrow();
  });

  it("verifies a passwordless account only with the empty password", async () => {
    const hasher = createArgon2PasswordHasher();
    const hash = await hasher.hash("");

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(hasher.verify(hash, "")).resolves.toBe(true);
    await expect(hasher.verify(hash, "anything")).resolves.toBe(false);
  });

  it("stores and verifies intentional Argon2id hashes", async () => {
    const hasher = createArgon2PasswordHasher();
    const password = "correct horse battery staple";
    const hash = await hasher.hash(password);

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain(
      `m=${ARGON2ID_OPTIONS.memoryCost},p=${ARGON2ID_OPTIONS.parallelism},t=${ARGON2ID_OPTIONS.timeCost}`,
    );
    expect(hash).not.toContain(password);
    await expect(hasher.verify(hash, password)).resolves.toBe(true);
    await expect(hasher.verify(hash, "incorrect password")).resolves.toBe(
      false,
    );
  });
});
