// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  applyChange,
  entriesOf,
  EnvValueError,
  formatValue,
  parseEnv,
  serializeEnv,
} from "../lib/envFile.mjs";

const SAMPLE = [
  "# Seyirlik settings",
  "",
  "SEYIRLIK_MEDIA_ROOT=D:\\media",
  "export SEYIRLIK_PORT=43111   # inline comment",
  'SEYIRLIK_LIBRARIES=\'[{"slug":"films","roots":["movies"]}]\'',
  'MULTI="line one',
  'line two"',
  "SEYIRLIK_PORT=43112",
  "",
].join("\n");

describe("parseEnv", () => {
  it("reads values the way Node's --env-file does", () => {
    const entries = entriesOf(parseEnv(SAMPLE));
    expect(entries.get("SEYIRLIK_MEDIA_ROOT")?.value).toBe("D:\\media");
    expect(entries.get("SEYIRLIK_LIBRARIES")?.value).toBe(
      '[{"slug":"films","roots":["movies"]}]',
    );
    expect(entries.get("MULTI")?.value).toBe("line one\nline two");
    // the last occurrence wins, and is counted
    expect(entries.get("SEYIRLIK_PORT")).toMatchObject({
      value: "43112",
      occurrences: 2,
    });
  });

  it("round-trips byte for byte, including CRLF and a BOM", () => {
    expect(serializeEnv(parseEnv(SAMPLE))).toBe(SAMPLE);
    const windows = "\uFEFF" + SAMPLE.replace(/\n/g, "\r\n");
    expect(serializeEnv(parseEnv(windows))).toBe(windows);
  });

  it("flags a quote that is never closed instead of swallowing the file", () => {
    const doc = parseEnv("A='open\nB=2\n");
    const entries = entriesOf(doc);
    expect(entries.get("A")?.warning).toMatch(/never closes/);
    expect(entries.get("B")?.value).toBe("2");
  });
});

describe("applyChange", () => {
  it("rewrites only the lines it names", () => {
    const next = serializeEnv(
      applyChange(parseEnv(SAMPLE), {
        set: { SEYIRLIK_MEDIA_ROOT: "E:\\media" },
      }),
    );
    expect(next).toBe(SAMPLE.replace("D:\\media", "E:\\media"));
  });

  it("collapses duplicates onto the first line, so what you see is what loads", () => {
    const next = applyChange(parseEnv(SAMPLE), {
      set: { SEYIRLIK_PORT: "8080" },
    });
    expect(entriesOf(next).get("SEYIRLIK_PORT")).toMatchObject({
      value: "8080",
      occurrences: 1,
    });
    expect(serializeEnv(next)).toContain(
      "SEYIRLIK_PORT=8080\nSEYIRLIK_LIBRARIES",
    );
  });

  it("appends new keys before the final newline and removes unset ones", () => {
    const next = serializeEnv(
      applyChange(parseEnv("A=1\nB=2\n"), { set: { C: "3" }, unset: ["A"] }),
    );
    expect(next).toBe("B=2\nC=3\n");
    expect(serializeEnv(applyChange(parseEnv(""), { set: { A: "1" } }))).toBe(
      "A=1\n",
    );
  });

  it("keeps CRLF files CRLF", () => {
    const next = serializeEnv(
      applyChange(parseEnv("A=1\r\nB=2\r\n"), { set: { C: "x y" } }),
    );
    expect(next).toBe("A=1\r\nB=2\r\nC=x y\r\n");
  });

  it("refuses new names that are not shouting snake case", () => {
    expect(() =>
      applyChange(parseEnv(""), { set: { "bad-name": "1" } }),
    ).toThrow(EnvValueError);
  });
});

describe("formatValue", () => {
  const cases = [
    "D:\\media",
    "C:\\Program Files\\Seyirlik\\ffmpeg\\bin\\ffmpeg.exe",
    "has # hash",
    " padded ",
    '{"a":"b"}',
    "it's",
    "both ' and \"",
    "postgresql://u:p@127.0.0.1:5432/db?sslmode=disable",
    "'leading quote",
    "",
  ];
  it.each(cases)("writes %j so that it reads back unchanged", (value) => {
    const doc = parseEnv(`K=${formatValue(value)}\n`);
    expect(entriesOf(doc).get("K")?.value).toBe(value);
  });

  it("leaves plain values unquoted", () => {
    expect(formatValue("D:\\media")).toBe("D:\\media");
  });

  it("rejects line breaks and values no quote can hold", () => {
    expect(() => formatValue("a\nb")).toThrow(EnvValueError);
    expect(() => formatValue("' \" `")).toThrow(EnvValueError);
  });
});
