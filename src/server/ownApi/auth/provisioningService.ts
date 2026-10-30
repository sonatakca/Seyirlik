import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../database/transaction";
import {
  validateDisplayName,
  validatePassword,
  validateUsername,
  type PasswordHasher,
} from "./passwords";

const INITIAL_ADMIN_LOCK_KEY = "7610294835702";

export class InitialAdministratorExistsError extends Error {
  constructor() {
    super("An eligible native administrator already exists.");
    this.name = "InitialAdministratorExistsError";
  }
}

export interface ProvisionedAdministrator {
  id: string;
  username: string;
  displayName: string;
  isAdministrator: true;
}

export interface ProvisionInitialAdministratorOptions {
  pool: Pick<Pool, "connect">;
  passwords: PasswordHasher;
  username: string;
  displayName: string;
  password: string;
  idFactory?: () => string;
}

export async function provisionInitialAdministrator({
  pool,
  passwords,
  username,
  displayName,
  password,
  idFactory = randomUUID,
}: ProvisionInitialAdministratorOptions): Promise<ProvisionedAdministrator> {
  const normalizedUsername = validateUsername(username);
  const safeDisplayName = validateDisplayName(displayName);
  const passwordHash = await passwords.hash(validatePassword(password));
  const id = idFactory();

  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      INITIAL_ADMIN_LOCK_KEY,
    ]);
    const existing = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM native_users
       WHERE is_administrator = true AND is_disabled = false`,
    );

    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      throw new InitialAdministratorExistsError();
    }

    await client.query(
      `INSERT INTO native_users (
        id, normalized_username, display_name, password_hash, is_administrator
      ) VALUES ($1, $2, $3, $4, true)`,
      [id, normalizedUsername, safeDisplayName, passwordHash],
    );

    return {
      id,
      username: normalizedUsername,
      displayName: safeDisplayName,
      isAdministrator: true,
    };
  });
}
