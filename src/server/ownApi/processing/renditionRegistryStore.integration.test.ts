// @vitest-environment node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import {
  createEmptyRenditionRegistry,
  upsertRegistrySource,
} from "../../../renditions/registry";
import {
  createDatabaseRenditionRegistryStore,
  importRenditionRegistry,
} from "./renditionRegistryStore";

/*
 * The rendition registry in PostgreSQL. Two pools stand in for the server and
 * the encoding laptop, which share the database but nothing else: neither may
 * lose the other's writes, and the old file is imported only when it reads as
 * a whole registry.
 *
 * Requires a disposable database. The schema is dropped.
 */
const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const source = (index: number) => ({
  relativePath: `Movies/Film ${index}.mkv`,
  size: index + 1,
  mtimeMs: index + 1,
  sourceFingerprint: index.toString(16).padStart(64, "0").replace(/^0/, "a"),
});

integration("rendition registry in PostgreSQL", () => {
  const server = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const laptop = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });

  const row = async () =>
    (
      await server.query<{
        revision: string;
        updated_by: string | null;
        imported_from: string | null;
        items: number;
      }>(
        `SELECT revision::text AS revision, updated_by, imported_from,
                jsonb_array_length(document->'items') AS items
           FROM rendition_registry`,
      )
    ).rows[0];

  const fileWith = async (contents: string) => {
    const root = await mkdtemp(path.join(tmpdir(), "seyirlik-registry-db-"));
    const file = path.join(root, "registry.json");
    await writeFile(file, contents);
    return file;
  };

  const registryWith = (count: number) => {
    const registry = createEmptyRenditionRegistry();
    for (let index = 0; index < count; index += 1)
      upsertRegistrySource(registry, source(index));
    return registry;
  };

  beforeAll(async () => {
    await server.query("DROP SCHEMA public CASCADE");
    await server.query("CREATE SCHEMA public");
    await runMigrations(server);
  });

  beforeEach(async () => {
    await server.query("DELETE FROM rendition_registry");
  });

  afterAll(async () => {
    await server.end();
    await laptop.end();
  });

  it("backs up and imports once during deployment, then ignores a broken mount", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "seyirlik-registry-cutover-"),
    );
    const media = path.join(root, "media");
    const state = path.join(media, ".seyirlik", "state");
    const backup = path.join(root, "backup");
    await mkdir(state, { recursive: true });
    const contents = JSON.stringify(registryWith(3));
    await writeFile(path.join(state, "registry.json"), contents);
    const run = () =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "scripts/seed-rendition-registry.ts", backup],
        {
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            SEYIRLIK_MEDIA_ROOT: media,
            SEYIRLIK_RENDITION_STATE_ROOT: state,
          },
        },
      );
    await run();
    expect(
      await readFile(path.join(backup, "rendition-registry.json"), "utf8"),
    ).toBe(contents);
    expect(await row()).toMatchObject({ items: 3, revision: "1" });
    await writeFile(path.join(state, "registry.json"), "");
    await run();
    expect(await row()).toMatchObject({ items: 3, revision: "1" });
  });

  it("leaves the database untouched when a deployment input is missing or truncated", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "seyirlik-registry-cutover-bad-"),
    );
    const state = path.join(root, "state");
    const run = (backup: string) =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "scripts/seed-rendition-registry.ts", backup],
        {
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            SEYIRLIK_MEDIA_ROOT: root,
            SEYIRLIK_RENDITION_STATE_ROOT: state,
          },
        },
      );
    await expect(run(path.join(root, "missing-backup"))).rejects.toThrow();
    expect(await row()).toBeUndefined();
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, "registry.json"), "{");
    await expect(run(path.join(root, "bad-backup"))).rejects.toThrow();
    expect(await row()).toBeUndefined();
  });

  it("allows only one registry row", async () => {
    await createDatabaseRenditionRegistryStore(server).read();
    await expect(
      server.query(
        "INSERT INTO rendition_registry (id, document) VALUES (false, '{}')",
      ),
    ).rejects.toThrow();
    await expect(
      server.query("INSERT INTO rendition_registry (document) VALUES ('{}')"),
    ).rejects.toThrow();
  });

  it("imports the old file on first use", async () => {
    const file = await fileWith(JSON.stringify(registryWith(3)));
    const store = createDatabaseRenditionRegistryStore(server, {
      seedFrom: file,
      writer: "Server",
    });

    expect((await store.read()).items).toHaveLength(3);
    expect(await row()).toMatchObject({
      items: 3,
      imported_from: file,
      updated_by: "Server",
    });
  });

  it("requires an explicit import for running services", async () => {
    const store = createDatabaseRenditionRegistryStore(server, {
      requireExisting: true,
    });
    await expect(store.read()).rejects.toThrow("has not been imported");
    expect(await row()).toBeUndefined();
  });

  it("starts empty when there is no old file", async () => {
    const store = createDatabaseRenditionRegistryStore(server, {
      seedFrom: path.join(tmpdir(), "seyirlik-no-such-dir", "registry.json"),
    });
    expect((await store.read()).items).toEqual([]);
    expect(await row()).toMatchObject({ items: 0 });
  });

  it.each([
    ["empty", ""],
    ["cut short", JSON.stringify(registryWith(2)).slice(0, 200)],
  ])(
    "refuses to import a file that reads %s, and creates no row",
    async (_label, contents) => {
      const file = await fileWith(contents);
      const store = createDatabaseRenditionRegistryStore(server, {
        seedFrom: file,
      });
      await expect(store.read()).rejects.toThrow(
        `The rendition registry at ${file} could not be read`,
      );
      await expect(
        store.update((registry) => upsertRegistrySource(registry, source(0))),
      ).rejects.toThrow(`The rendition registry at ${file} could not be read`);
      expect(await row()).toBeUndefined();
    },
  );

  it("never reads the file again once the row exists", async () => {
    const file = await fileWith(JSON.stringify(registryWith(2)));
    await createDatabaseRenditionRegistryStore(server, {
      seedFrom: file,
    }).read();
    await writeFile(file, "");

    const later = createDatabaseRenditionRegistryStore(laptop, {
      seedFrom: file,
    });
    expect((await later.read()).items).toHaveLength(2);
  });

  it("loses no write when both machines update at once", async () => {
    const onServer = createDatabaseRenditionRegistryStore(server, {
      writer: "Server",
    });
    const onLaptop = createDatabaseRenditionRegistryStore(laptop, {
      writer: "MSI",
    });
    await onServer.read();

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 ? onLaptop : onServer).update((registry) =>
          upsertRegistrySource(registry, source(index)),
        ),
      ),
    );

    const items = (await onServer.read()).items;
    expect(items).toHaveLength(40);
    expect(new Set(items.map((item) => item.id)).size).toBe(40);
    expect(await row()).toMatchObject({ revision: "41", items: 40 });
  });

  /*
   * What the job runner does across an encode: register at the start, mark
   * ready at the end. A removal on the server in between must stand, and a
   * title registered in between must survive the ready write.
   */
  it("applies each change to the registry as it is, not as it was read", async () => {
    const onServer = createDatabaseRenditionRegistryStore(server);
    const onLaptop = createDatabaseRenditionRegistryStore(laptop);
    await onServer.update((registry) => {
      upsertRegistrySource(registry, source(1));
      upsertRegistrySource(registry, source(2));
    });

    const encoding = await onLaptop.update((registry) =>
      upsertRegistrySource(registry, source(3)),
    );
    await onServer.update((registry) => {
      registry.items = registry.items.filter(
        (item) => item.relativePath !== source(1).relativePath,
      );
      upsertRegistrySource(registry, source(4));
    });
    await onLaptop.update((registry) => {
      const item = registry.items.find((entry) => entry.id === encoding.id);
      if (item) item.adaptiveStatus = "ready";
    });

    const items = (await onServer.read()).items;
    expect(items.map((item) => item.relativePath).sort()).toEqual([
      "Movies/Film 2.mkv",
      "Movies/Film 3.mkv",
      "Movies/Film 4.mkv",
    ]);
    expect(items.find((item) => item.id === encoding.id)?.adaptiveStatus).toBe(
      "ready",
    );
  });

  it("refuses to store a registry that fails validation", async () => {
    const store = createDatabaseRenditionRegistryStore(server);
    await store.update((registry) => upsertRegistrySource(registry, source(1)));
    await expect(
      store.update((registry) => {
        (registry.items[0] as { id: string }).id = "not-a-uuid";
      }),
    ).rejects.toThrow("schema is invalid");
    const items = (await store.read()).items;
    expect(items).toHaveLength(1);
    expect(await row()).toMatchObject({ revision: "2" });
  });

  it("changes its revision only when the registry changes", async () => {
    const store = createDatabaseRenditionRegistryStore(server);
    expect(await store.revision()).toBe("missing");
    await store.read();
    const first = await store.revision();
    expect(await store.revision()).toBe(first);
    await store.update((registry) => upsertRegistrySource(registry, source(1)));
    expect(await store.revision()).not.toBe(first);
  });

  it("imports explicitly, and replaces an existing row only when asked", async () => {
    const first = await importRenditionRegistry(server, registryWith(2), {
      source: "/old/registry.json",
    });
    expect(first).toEqual({
      previousItems: null,
      importedItems: 2,
      written: true,
    });

    const kept = await importRenditionRegistry(server, registryWith(5), {
      source: "/other/registry.json",
    });
    expect(kept).toEqual({
      previousItems: 2,
      importedItems: 5,
      written: false,
    });
    expect(await row()).toMatchObject({
      items: 2,
      imported_from: "/old/registry.json",
    });

    const replaced = await importRenditionRegistry(server, registryWith(5), {
      source: "/other/registry.json",
      replace: true,
    });
    expect(replaced.written).toBe(true);
    expect(await row()).toMatchObject({
      items: 5,
      revision: "2",
      imported_from: "/other/registry.json",
    });
  });
});
