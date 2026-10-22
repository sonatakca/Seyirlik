import type { OwnApiRouteHandler } from "../ownApiHandler";
import {
  checkDatabaseReadiness,
  createDatabasePool,
  validateDatabaseConnection,
  validateNativeIdentitySchema,
  type DatabasePool,
} from "../database/databasePool";
import { parseDatabaseConfig } from "../database/databaseConfig";
import { validateMigrationsApplied } from "../database/migrationRunner";
import { createUserRepository } from "../users/userRepository";
import { createNativeAuthService, type NativeAuthService } from "./authService";
import { parseNativeAuthConfig } from "./authConfig";
import { createNativeAuthHttpHandler } from "./authHttpHandler";
import { createArgon2PasswordHasher } from "./passwords";
import { createSessionRepository } from "./sessionRepository";

const EXPIRED_SESSION_CLEANUP_INTERVAL_MS = 15 * 60_000;

type Environment = Record<string, string | undefined>;

export interface NativeIdentityRuntime {
  auth: NativeAuthService;
  routeHandler: OwnApiRouteHandler;
  databaseCheck(): Promise<"available" | "unavailable">;
  close(): Promise<void>;
}

export interface CreateNativeIdentityRuntimeOptions {
  environment?: Environment;
  publicOrigin?: string;
  cleanupIntervalMs?: number;
}

export async function createNativeIdentityRuntime({
  environment = process.env,
  publicOrigin,
  cleanupIntervalMs = EXPIRED_SESSION_CLEANUP_INTERVAL_MS,
}: CreateNativeIdentityRuntimeOptions = {}): Promise<NativeIdentityRuntime> {
  const databaseConfig = parseDatabaseConfig(environment);
  const authConfig = parseNativeAuthConfig(environment);

  const pool: DatabasePool = createDatabasePool(databaseConfig);
  try {
    await validateDatabaseConnection(pool);
  } catch {
    await pool.end().catch(() => undefined);
    throw new Error("Native identity database is unavailable.");
  }
  try {
    await validateNativeIdentitySchema(pool);
    await validateMigrationsApplied(pool);
  } catch {
    await pool.end().catch(() => undefined);
    throw new Error("Native identity database migrations are not current.");
  }

  const auth = await createNativeAuthService({
    users: createUserRepository(pool),
    sessions: createSessionRepository(pool),
    passwords: createArgon2PasswordHasher(),
    sessionHashSecret: authConfig.sessionHashSecret,
  });
  const routeHandler = createNativeAuthHttpHandler({
    auth,
    csrfSecret: authConfig.csrfSecret,
    secureCookies: authConfig.secureCookies,
    sessionCookieName: authConfig.sessionCookieName,
    csrfCookieName: authConfig.csrfCookieName,
    publicOrigin,
  });
  let closed = false;
  const cleanupTimer = setInterval(() => {
    void auth.cleanupExpiredSessions().catch(() => undefined);
  }, cleanupIntervalMs);
  cleanupTimer.unref();

  return {
    auth,
    routeHandler,
    databaseCheck: () => checkDatabaseReadiness(pool),
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(cleanupTimer);
      await pool.end();
    },
  };
}
