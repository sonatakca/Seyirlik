// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabasePool } from "../database/databasePool";
import { runMigrations } from "../database/migrationRunner";
import {
  canonicalInviteCode,
  createInviteRepository,
  hashInviteCode,
} from "./invites";
import type { PasswordHasher } from "./passwords";
import { createSignupService } from "./signupService";

const databaseUrl = process.env.SEYIRLIK_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const secret = "invite-secret-at-least-thirty-two-bytes";

integration("creating your own account with an invite", () => {
  const pool = createDatabasePool({
    connectionString: databaseUrl as string,
    maxConnections: 4,
  });
  const passwords: PasswordHasher = {
    hash: async (password) => `$argon2id$test$${password.length}`,
    verify: async () => false,
  };
  const service = createSignupService({
    pool,
    passwords,
    inviteHashSecret: secret,
  });
  const invites = createInviteRepository(pool);

  async function invite(
    code: string,
    { maxUses = 1, expiresAt = null as Date | null } = {},
  ) {
    return invites.create({
      id: crypto.randomUUID(),
      codeHash: hashInviteCode(canonicalInviteCode(code) as string, secret),
      label: null,
      maxUses,
      expiresAt,
      createdBy: null,
    });
  }

  const person = (username: string, inviteCode: string) => ({
    username,
    displayName: `Name of ${username}`,
    password: "long enough",
    inviteCode,
  });

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE native_invites, native_users CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("admits one person per use, and records which invite let them in", async () => {
    const created = await invite("AAAA-BBBB-CCCC");
    const result = await service.signUp(person("ayse", "aaaa bbbb cccc"));
    const row = await pool.query(
      "SELECT display_name, invite_id, is_administrator FROM native_users WHERE id = $1",
      [result.userId],
    );
    expect(row.rows[0]).toEqual({
      display_name: "Name of ayse",
      invite_id: created.id,
      is_administrator: false,
    });
    await expect(
      service.signUp(person("mert", "AAAA-BBBB-CCCC")),
    ).rejects.toMatchObject({ code: "INVITE_INVALID" });
  });

  it("gives the use back when the username is taken", async () => {
    await invite("AAAA-BBBB-CCCC", { maxUses: 2 });
    await service.signUp(person("ayse", "AAAA-BBBB-CCCC"));
    await expect(
      service.signUp(person("ayse", "AAAA-BBBB-CCCC")),
    ).rejects.toMatchObject({ code: "USERNAME_TAKEN" });
    const uses = await pool.query("SELECT use_count FROM native_invites");
    expect(uses.rows[0]?.use_count).toBe(1);
    await service.signUp(person("mert", "AAAA-BBBB-CCCC"));
  });

  it("lets only one of two racing people take the last use", async () => {
    await invite("AAAA-BBBB-CCCC");
    const outcomes = await Promise.allSettled([
      service.signUp(person("ayse", "AAAA-BBBB-CCCC")),
      service.signUp(person("mert", "AAAA-BBBB-CCCC")),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  });

  it("refuses an expired or revoked code", async () => {
    await invite("AAAA-BBBB-CCCC", { expiresAt: new Date(Date.now() - 1_000) });
    const revoked = await invite("DDDD-EEEE-FFFF");
    await invites.revoke(revoked.id, new Date());
    for (const code of ["AAAA-BBBB-CCCC", "DDDD-EEEE-FFFF"]) {
      await expect(service.signUp(person("ayse", code))).rejects.toMatchObject({
        code: "INVITE_INVALID",
      });
    }
  });

  it("keeps the person when their invite is deleted", async () => {
    await invite("AAAA-BBBB-CCCC");
    const result = await service.signUp(person("ayse", "AAAA-BBBB-CCCC"));
    await pool.query("DELETE FROM native_invites");
    const row = await pool.query(
      "SELECT invite_id FROM native_users WHERE id = $1",
      [result.userId],
    );
    expect(row.rows[0]?.invite_id).toBeNull();
  });
});
