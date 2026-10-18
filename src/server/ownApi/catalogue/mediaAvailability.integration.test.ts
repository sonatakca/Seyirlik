// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createCatalogueRepository } from "./catalogueRepository";
import { createHomeRepository } from "./homeRepository";
import { createWantedRoutes } from "./wantedRoutes";
import type { TmdbClient } from "../metadata/tmdbClient";
import type { RouteContext, RouteDefinition } from "../api/router";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  "wanted identity and real catalogue availability",
  () => {
    const pool = createDatabasePool({
      connectionString: databaseUrl!,
      maxConnections: 4,
    });
    const user = randomUUID(),
      library = randomUUID();
    let movie: string,
      series: string,
      episode: string,
      missing: string,
      wanted: string;
    const catalogue = createCatalogueRepository(pool);
    const home = createHomeRepository(pool);
    async function item(title: string, kind = "movie", seriesId?: string) {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO items (id, library_id, kind, source_key, title, sort_title, series_id) VALUES ($1,$2,$3,$4::text,$4::text,$4::text,$5)",
        [id, library, kind, title, seriesId ?? null],
      );
      return id;
    }
    async function file(id: string, absent = false) {
      const fileId = randomUUID();
      await pool.query(
        "INSERT INTO media_files (id,item_id,relative_path,size_bytes,mtime_ms,fingerprint,missing_since) VALUES ($1,$2,$3,1024,1,'test',$4)",
        [fileId, id, `${id}.mkv`, absent ? new Date() : null],
      );
      return fileId;
    }
    async function invoke(route: RouteDefinition, body?: unknown, params = {}) {
      let payload: {
        data: {
          item: { id: string };
          items: Array<{ id: string; status: string; desired: boolean }>;
        };
      };
      await route.handle({
        response: {
          setHeader() {},
          writeHead() {},
          end(value: string) {
            payload = JSON.parse(value);
          },
        },
        requestId: "test",
        params,
        requirePrincipal: () => ({ userId: user, isAdministrator: true }),
        readJson: async () => body,
      } as unknown as RouteContext);
      return payload!.data;
    }
    beforeAll(async () => {
      // This suite runs only against a explicitly supplied disposable test database.
      await pool.query("DROP SCHEMA public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await runMigrations(pool);
      await pool.query(
        "INSERT INTO native_users (id,normalized_username,display_name,password_hash) VALUES ($1,'viewer','Viewer','$argon2id$test')",
        [user],
      );
      await pool.query(
        "INSERT INTO libraries (id,slug,name,kind) VALUES ($1,'movies','Movies','movies')",
        [library],
      );
      await pool.query(
        "INSERT INTO library_roots (id,library_id,relative_path) VALUES ($1,$2,'Movies')",
        [randomUUID(), library],
      );
      movie = await item("Playable");
      await file(movie);
      missing = await item("Missing");
      await file(missing, true);
      wanted = await item("Wanted");
      await pool.query("UPDATE items SET desired = true WHERE id=$1", [wanted]);
      series = await item("Series", "series");
      episode = await item("Episode", "episode", series);
      await file(episode);
      await item("Empty series", "series");
    });
    afterAll(async () => {
      await pool.end();
    });
    it("excludes metadata-only and missing titles from library, feed, and search", async () => {
      const listed = await catalogue.listItems({ userId: user, limit: 100 });
      expect(listed.map((row) => row.id).sort()).toEqual(
        [movie, series, episode].sort(),
      );
      expect(await home.listLatestItemIds(user, 100)).not.toContain(wanted);
      expect(await catalogue.searchItems(user, "Wanted", 10)).toEqual([]);
      expect(await catalogue.getItemsByIds(user, [wanted, missing])).toEqual(
        [],
      );
    });
    it("does not let a succeeded processing job stand in for files that are gone", async () => {
      const fileId = (
        await pool.query("SELECT id FROM media_files WHERE item_id=$1", [
          missing,
        ])
      ).rows[0].id;
      await pool.query(
        "INSERT INTO processing_jobs (id,item_id,media_file_id,source_fingerprint,profile,state,published_version) VALUES ($1,$2,$3,'test','test','succeeded','v1')",
        [randomUUID(), missing, fileId],
      );
      expect(await catalogue.getItemsByIds(user, [missing])).toEqual([]);
    });
    it("keeps a title whose source was replaced by its complete package", async () => {
      const packaged = await item("Packaged");
      await file(packaged);
      await pool.query(
        "UPDATE media_files SET probe_state='packaged' WHERE item_id=$1",
        [packaged],
      );
      expect(
        (await catalogue.getItemsByIds(user, [packaged])).map((row) => row.id),
      ).toEqual([packaged]);
    });
    it("adds one TMDB identity transactionally and supports removing wanted intent without deleting media", async () => {
      const client = {
        getMovie: async () => ({
          title: "Fight Club",
          releaseDate: "1999-10-15",
          overview: "A movie.",
        }),
      } as unknown as TmdbClient;
      const routes = createWantedRoutes(pool, client);
      const add = routes.find((route) => route.method === "POST")!;
      const body = { kind: "movie", providerId: "550", libraryId: library };
      const [a, b] = await Promise.all([invoke(add, body), invoke(add, body)]);
      expect(a.item.id).toBe(b.item.id);
      const status = await invoke(
        routes.find(
          (route) => route.path === "/wanted" && route.method === "GET",
        )!,
      );
      expect(status.items.find((row) => row.id === a.item.id)).toMatchObject({
        status: "wanted",
        desired: true,
      });
      expect(await catalogue.getItemsByIds(user, [a.item.id])).toEqual([]);
      await invoke(
        routes.find((route) => route.method === "PUT")!,
        { desired: false },
        { itemId: a.item.id },
      );
      const record = (
        await pool.query("SELECT desired FROM items WHERE id=$1", [a.item.id])
      ).rows[0];
      expect(record.desired).toBe(false);
      expect(
        (
          await pool.query(
            "SELECT monitored FROM monitored_items WHERE item_id=$1",
            [a.item.id],
          )
        ).rows[0].monitored,
      ).toBe(false);
    });
    it("rolls back wanted changes on conflicting provider identity", async () => {
      const client = {
        getMovie: async () => ({
          title: "Fight Club",
          releaseDate: "1999-10-15",
        }),
      } as unknown as TmdbClient;
      const route = createWantedRoutes(pool, client).find(
        (entry) => entry.method === "POST",
      )!;
      await expect(
        invoke(route, { kind: "movie", providerId: "999", libraryId: library }),
      ).rejects.toMatchObject({ statusCode: 422 });
      expect(
        (
          await pool.query(
            "SELECT desired FROM items WHERE provider_ids->>'tmdb'='550'",
          )
        ).rows[0].desired,
      ).toBe(false);
    });
  },
);
