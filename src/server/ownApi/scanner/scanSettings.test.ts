import { describe, expect, it } from "vitest";
import { parseDeleteMissing, parseRescanMinutes } from "./scanSettings";

describe("scan settings", () => {
  it("deletes missing titles unless told not to", () => {
    expect(parseDeleteMissing(undefined)).toBe(true);
    expect(parseDeleteMissing("")).toBe(true);
    expect(parseDeleteMissing("FALSE")).toBe(false);
    expect(() => parseDeleteMissing("no")).toThrow(
      /SEYIRLIK_CATALOGUE_DELETE_MISSING/,
    );
  });

  it("scans on a timer only when an interval is set", () => {
    expect(parseRescanMinutes(undefined)).toBeNull();
    expect(parseRescanMinutes("10")).toBe(600_000);
    expect(() => parseRescanMinutes("0")).toThrow();
    expect(() => parseRescanMinutes("2.5")).toThrow();
  });
});
