// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkValue,
  maskUrlCredentials,
  presentValue,
  specFor,
} from "../lib/catalog.mjs";

describe("visibility", () => {
  it("shows paths, hides credentials, masks database URLs", () => {
    expect(
      presentValue(specFor("SEYIRLIK_MEDIA_ROOT", "settings"), "D:\\media")
        .display,
    ).toBe("D:\\media");
    expect(
      presentValue(specFor("SEYIRLIK_TMDB_API_KEY", "secrets"), "abc").display,
    ).toBeNull();
    const db = presentValue(
      specFor("DATABASE_URL", "secrets"),
      "postgresql://seyirlik:hunter2hunter2@127.0.0.1:5432/seyirlik",
    ).display;
    expect(db).not.toContain("hunter2");
    expect(db).toContain("127.0.0.1:5432/seyirlik");
  });

  it("treats anything unknown in secrets.env as a secret", () => {
    expect(specFor("SOMETHING_HARMLESS", "secrets").visibility).toBe("secret");
  });

  it("treats credential-looking names as secrets wherever they are", () => {
    for (const key of [
      "MY_TOKEN",
      "SEYIRLIK_INDEXER_APIKEY_NZBGEEK",
      "X_PASSWORD",
      "FOO_KEY",
      "PRIVATE_THING",
    ]) {
      expect(specFor(key, "settings").visibility, key).toBe("secret");
    }
    expect(specFor("SEYIRLIK_FOO_PATH", "settings").visibility).toBe("visible");
  });

  it("masks keys in URLs typed into visible settings, including inside JSON", () => {
    const value =
      '{"baseUrl":"https://indexer.example/api?apikey=s3cr3t&t=search"}';
    const masked = maskUrlCredentials(value);
    expect(masked).not.toContain("s3cr3t");
    expect(masked).toContain("t=search");
    expect(
      presentValue(specFor("SEYIRLIK_SABNZBD", "settings"), value).masked,
    ).toBe(true);
    expect(maskUrlCredentials("https://example.org/path")).toBe(
      "https://example.org/path",
    );
  });
});

describe("checkValue", () => {
  const spec = (key) => specFor(key, "settings");

  it("accepts a missing drive as a warning-free path but rejects relative paths", () => {
    expect(checkValue(spec("SEYIRLIK_MEDIA_ROOT"), "E:\\media").errors).toEqual(
      [],
    );
    expect(
      checkValue(spec("SEYIRLIK_MEDIA_ROOT"), "\\\\nas\\share\\media").errors,
    ).toEqual([]);
    expect(
      checkValue(spec("SEYIRLIK_MEDIA_ROOT"), "media").errors,
    ).toHaveLength(1);
  });

  it("checks numbers, enums, JSON and URLs", () => {
    expect(checkValue(spec("SEYIRLIK_PORT"), "70000").errors).toHaveLength(1);
    expect(checkValue(spec("SEYIRLIK_PORT"), "43111").errors).toEqual([]);
    expect(
      checkValue(spec("SEYIRLIK_RESTART_MODE"), "sometimes").errors,
    ).toHaveLength(1);
    expect(checkValue(spec("SEYIRLIK_LIBRARIES"), "{}").errors).toHaveLength(1);
    expect(checkValue(spec("SEYIRLIK_LIBRARIES"), "[]").errors).toEqual([]);
    expect(
      checkValue(spec("SEYIRLIK_ALERTS_URL"), "not a url").errors,
    ).toHaveLength(1);
  });

  it("enforces the 32-byte floor on the session and CSRF secrets", () => {
    expect(
      checkValue(specFor("SEYIRLIK_CSRF_SECRET", "secrets"), "short").errors,
    ).toHaveLength(1);
    expect(
      checkValue(specFor("SEYIRLIK_CSRF_SECRET", "secrets"), "x".repeat(32))
        .errors,
    ).toEqual([]);
  });

  it("refuses to save the mask itself back", () => {
    expect(
      checkValue(specFor("DATABASE_URL", "secrets"), "postgresql://u:••••@h/db")
        .errors,
    ).toHaveLength(1);
  });

  it("warns when a required setting is emptied", () => {
    expect(checkValue(spec("SEYIRLIK_MEDIA_ROOT"), "").warnings).toHaveLength(
      1,
    );
  });
});
