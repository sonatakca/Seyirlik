// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceSubtitleFile } from "./subtitleCommit";
let brokenRename = false;
let failWrite = false;
let target = "";
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (!brokenRename) return fs.rename(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] === target && args[1] === "r+" && failWrite) {
        failWrite = false;
        handle.writeFile = async () => {
          throw new Error("disk error");
        };
      }
      return handle;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  brokenRename = false;
  failWrite = false;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "subtitle-commit-"));
  roots.push(root);
  target = path.join(root, "film.tr.srt");
  const temporary = path.join(root, "new.tmp");
  const previous = Buffer.from("original"),
    bytes = Buffer.from("corrected");
  await writeFile(target, previous);
  await writeFile(temporary, bytes);
  return { root, target, temporary, previous, bytes };
}
describe("verified subtitle replacement", () => {
  it("writes the corrected bytes on Windows even if rename would silently do nothing", async () => {
    const input = await fixture();
    brokenRename = true;
    await replaceSubtitleFile({ ...input, platform: "win32" });
    expect(await readFile(target, "utf8")).toBe("corrected");
    const parent = path.join(input.root, ".seyirlik/state/subtitle-rewrites");
    const [folder] = await readdir(parent);
    expect(await readFile(path.join(parent, folder!, "before"), "utf8")).toBe(
      "original",
    );
    expect(await readFile(path.join(parent, folder!, "after"), "utf8")).toBe(
      "corrected",
    );
  });
  it("detects a rename that reports success without replacing the destination", async () => {
    const input = await fixture();
    brokenRename = true;
    await expect(
      replaceSubtitleFile({ ...input, platform: "darwin" }),
    ).rejects.toThrow("did not match");
    expect(await readFile(target, "utf8")).toBe("original");
  });
  it("restores the old bytes if an in-place write fails, and retains recovery copies", async () => {
    const input = await fixture();
    failWrite = true;
    await expect(
      replaceSubtitleFile({ ...input, platform: "win32" }),
    ).rejects.toThrow("recovery copies");
    expect(await readFile(target, "utf8")).toBe("original");
  });
});
