// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import { createOpenSubtitlesAccounts } from "./openSubtitlesAccounts";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("OpenSubtitles accounts", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl!,
    maxConnections: 2,
  });
  const store = () =>
    createOpenSubtitlesAccounts({ db: pool, secret: "s".repeat(40) });

  beforeAll(async () => {
    // Only ever an explicitly supplied, disposable test database.
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("keeps the key and both accounts sealed, and hands them back in slot order", async () => {
    const accounts = store();
    await accounts.storeApiKey("key-abcdef123");
    await accounts.storeAccount(2, { username: "second", password: "pw-two" });
    await accounts.storeAccount(1, { username: "first", password: "pw-one" });
    const raw = await pool.query<{ sealed: Buffer }>(
      "SELECT sealed FROM provider_sessions WHERE provider_id LIKE 'opensubtitles-%'",
    );
    expect(raw.rows).toHaveLength(3);
    for (const row of raw.rows)
      for (const secret of ["key-abcdef123", "pw-one", "pw-two", "first"])
        expect(row.sealed.includes(Buffer.from(secret))).toBe(false);

    expect(await accounts.credentials.apiKey()).toBe("key-abcdef123");
    const signedIn = await accounts.credentials.accounts();
    expect(
      signedIn.map((a) => [a.slot, a.username, a.revealPassword()]),
    ).toEqual([
      [1, "first", "pw-one"],
      [2, "second", "pw-two"],
    ]);
    const status = await accounts.status();
    expect(status.apiKey.state).toBe("active");
    expect(status.accounts).toMatchObject([
      { slot: 1, state: "active", username: "first" },
      { slot: 2, state: "active", username: "second" },
    ]);
    expect(JSON.stringify(status)).not.toContain("pw-");
  });

  it("notes a spent day without signing the account out", async () => {
    const accounts = store();
    await accounts.credentials.noteQuota(
      1,
      new Date("2026-10-23T03:00:00.000Z"),
    );
    expect((await accounts.status()).accounts[0]).toMatchObject({
      state: "active",
      reason: expect.stringContaining("2026-10-23T03:00:00.000Z"),
    });
    expect((await accounts.credentials.accounts()).map((a) => a.slot)).toEqual([
      1, 2,
    ]);
    await accounts.credentials.noteQuota(1, null);
    expect((await accounts.status()).accounts[0]!.reason).toBeNull();
  });

  it("drops a refused password, but not one saved since", async () => {
    const accounts = store();
    const [first, second] = await accounts.credentials.accounts();
    await accounts.storeAccount(2, { username: "second", password: "pw-new" });
    await accounts.credentials.reject(2, second!.version, "Refused.");
    await accounts.credentials.reject(1, first!.version, "Refused.");
    const status = await accounts.status();
    expect(status.accounts).toMatchObject([
      { slot: 1, state: "rejected", username: null, reason: "Refused." },
      { slot: 2, state: "active", username: "second" },
    ]);
    const raw = await pool.query<{ sealed: Buffer | null }>(
      "SELECT sealed FROM provider_sessions WHERE provider_id = 'opensubtitles-1'",
    );
    expect(raw.rows[0]!.sealed).toBeNull();
    expect((await accounts.credentials.accounts()).map((a) => a.slot)).toEqual([
      2,
    ]);
  });

  it("does not open another server's seal", async () => {
    const other = createOpenSubtitlesAccounts({
      db: pool,
      secret: "t".repeat(40),
    });
    expect(await other.credentials.apiKey()).toBeNull();
    expect(await other.credentials.accounts()).toEqual([]);
  });
});
