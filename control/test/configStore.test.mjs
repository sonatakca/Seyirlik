// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  createConfigStore,
  ValidationError,
} from "../lib/configStore.mjs";

const SECRET = "postgresql://seyirlik:hunter2hunter2@127.0.0.1:5432/seyirlik";
const TMDB = "tmdb-key-0123456789abcdef";
let dir;
let files;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "seyirlik-control-"));
  await fs.mkdir(path.join(dir, "config"));
  await fs.mkdir(path.join(dir, "secrets"));
  files = {
    settings: path.join(dir, "config", "settings.env"),
    secrets: path.join(dir, "secrets", "secrets.env"),
  };
  await fs.writeFile(
    files.settings,
    "# settings\nSEYIRLIK_MEDIA_ROOT=D:\\media\nSEYIRLIK_PORT=43111\n",
  );
  await fs.writeFile(
    files.secrets,
    `DATABASE_URL=${SECRET}\nSEYIRLIK_TMDB_API_KEY=${TMDB}\n`,
  );
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function store(extra = {}) {
  return createConfigStore({
    files,
    dataDir: path.join(dir, "control"),
    ...extra,
  });
}

const actor = { ip: "100.101.2.3" };

describe("snapshot", () => {
  it("never carries a secret value", async () => {
    const snap = await store().snapshot();
    const text = JSON.stringify(snap);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain(TMDB);
    expect(
      snap.entries.find((e) => e.key === "SEYIRLIK_MEDIA_ROOT")?.value,
    ).toBe("D:\\media");
    expect(
      snap.entries.find((e) => e.key === "SEYIRLIK_TMDB_API_KEY"),
    ).toMatchObject({ value: null, visibility: "secret" });
    expect(snap.missing).toContain("SEYIRLIK_SESSION_HASH_SECRET");
  });
});

describe("apply", () => {
  it("writes, keeps the previous version, and records keys without values", async () => {
    const s = store();
    const { files: f } = await s.snapshot();
    const result = await s.apply(
      "settings",
      {
        baseVersion: f.settings.version,
        set: { SEYIRLIK_MEDIA_ROOT: "E:\\media" },
      },
      actor,
    );
    expect(result.changed).toBe(true);
    expect(await fs.readFile(files.settings, "utf8")).toBe(
      "# settings\nSEYIRLIK_MEDIA_ROOT=E:\\media\nSEYIRLIK_PORT=43111\n",
    );

    const history = await s.history("settings");
    expect(history[0]).toMatchObject({
      action: "change",
      set: ["SEYIRLIK_MEDIA_ROOT"],
      restorable: true,
    });
    const audit = await fs.readFile(
      path.join(dir, "control", "audit.jsonl"),
      "utf8",
    );
    expect(audit).not.toContain("E:\\\\media");
  });

  it("refuses a write based on a version that has since changed on disk", async () => {
    const s = store();
    const { files: f } = await s.snapshot();
    await fs.appendFile(files.settings, "EDITED_IN_NOTEPAD=1\n");
    await expect(
      s.apply(
        "settings",
        { baseVersion: f.settings.version, set: { SEYIRLIK_PORT: "1" } },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await fs.readFile(files.settings, "utf8")).toContain(
      "EDITED_IN_NOTEPAD=1",
    );
  });

  it("refuses invalid values and writes nothing", async () => {
    const s = store();
    const { files: f } = await s.snapshot();
    const before = await fs.readFile(files.settings, "utf8");
    await expect(
      s.apply(
        "settings",
        { baseVersion: f.settings.version, set: { SEYIRLIK_PORT: "port" } },
        actor,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await fs.readFile(files.settings, "utf8")).toBe(before);
  });

  it("will not put a credential into settings.env", async () => {
    const s = store();
    const { files: f } = await s.snapshot();
    await expect(
      s.apply(
        "settings",
        {
          baseVersion: f.settings.version,
          set: { SEYIRLIK_TMDB_API_KEY: "x" },
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("replaces a secret without the old value ever appearing in the plan", async () => {
    const s = store();
    const { files: f } = await s.snapshot();
    const plan = await s.plan("secrets", {
      set: { SEYIRLIK_TMDB_API_KEY: "new-key-value" },
    });
    expect(JSON.stringify(plan)).not.toContain(TMDB);
    expect(JSON.stringify(plan)).not.toContain("new-key-value");
    await s.apply(
      "secrets",
      {
        baseVersion: f.secrets.version,
        set: { SEYIRLIK_TMDB_API_KEY: "new-key-value" },
      },
      actor,
    );
    expect(await fs.readFile(files.secrets, "utf8")).toContain(
      "SEYIRLIK_TMDB_API_KEY=new-key-value",
    );
  });

  it("copies permissions onto the new file before it replaces the old one, and aborts if it cannot", async () => {
    const calls = [];
    const ok = store({
      copyAcl: async (from, to) => calls.push([from, path.dirname(to)]),
    });
    let { files: f } = await ok.snapshot();
    await ok.apply(
      "secrets",
      { baseVersion: f.secrets.version, set: { SEYIRLIK_TMDB_API_KEY: "abc" } },
      actor,
    );
    expect(calls).toEqual([[files.secrets, path.dirname(files.secrets)]]);

    const failing = store({
      copyAcl: async () => {
        throw new Error("no permission");
      },
    });
    ({ files: f } = await failing.snapshot());
    const before = await fs.readFile(files.secrets, "utf8");
    await expect(
      failing.apply(
        "secrets",
        {
          baseVersion: f.secrets.version,
          set: { SEYIRLIK_TMDB_API_KEY: "def" },
        },
        actor,
      ),
    ).rejects.toThrow("no permission");
    expect(await fs.readFile(files.secrets, "utf8")).toBe(before);
    // and no temporary file is left behind
    expect(
      (await fs.readdir(path.dirname(files.secrets))).filter((n) =>
        n.endsWith(".control-tmp"),
      ),
    ).toEqual([]);
  });

  it("serialises concurrent writes so neither is lost or clobbered", async () => {
    const s = store();
    const { files: f } = await s.snapshot();
    const results = await Promise.allSettled([
      s.apply(
        "settings",
        { baseVersion: f.settings.version, set: { SEYIRLIK_PORT: "1" } },
        actor,
      ),
      s.apply(
        "settings",
        { baseVersion: f.settings.version, set: { SEYIRLIK_PORT: "2" } },
        actor,
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await fs.readFile(files.settings, "utf8")).toMatch(
      /SEYIRLIK_PORT=1\n/,
    );
  });
});

describe("restore", () => {
  it("puts the earlier file back, and the restore is itself undoable", async () => {
    const s = store();
    const original = await fs.readFile(files.settings, "utf8");
    let { files: f } = await s.snapshot();
    await s.apply(
      "settings",
      {
        baseVersion: f.settings.version,
        set: { SEYIRLIK_MEDIA_ROOT: "E:\\media" },
      },
      actor,
    );
    const [change] = await s.history("settings");
    ({ files: f } = await s.snapshot());
    await s.restore("settings", change.historyId, f.settings.version, actor);
    expect(await fs.readFile(files.settings, "utf8")).toBe(original);
    const history = await s.history("settings");
    expect(history[0]).toMatchObject({
      action: "restore",
      set: ["SEYIRLIK_MEDIA_ROOT"],
      restorable: true,
    });
  });

  it("rejects history ids that try to leave the history folder", async () => {
    const s = store();
    const { files: f } = await s.snapshot();
    await expect(
      s.restore("settings", "../../secrets/secrets", f.settings.version, actor),
    ).rejects.toThrow("No such version");
  });
});

it("removes temporary files a crash left behind", async () => {
  const leftover = path.join(dir, "secrets", ".secrets.env.abcdef.control-tmp");
  await fs.writeFile(leftover, "half");
  await store().cleanup();
  await expect(fs.stat(leftover)).rejects.toMatchObject({ code: "ENOENT" });
});
