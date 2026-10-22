/**
 * Where a provider's browser session is kept, and the session manager that
 * hands it to the pipeline.
 *
 * The material arrives from a person — a Cookie header copied out of their own
 * browser after they passed the provider's challenge and signed in — and goes
 * straight into `seal`. It is never logged, never returned over HTTP, and never
 * stored in the clear: the database holds AES-256-GCM ciphertext under a key
 * derived from a secret that lives only in the secrets file. See migration 027.
 *
 * A provider that answers anonymous requests is asked anonymously until it
 * refuses one. That refusal is recorded (`rejected`), and from then on the
 * pipeline pauses in `needs-authentication` until somebody signs in again.
 */
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { DatabaseExecutor } from "../database/databaseTypes";
import {
  createProviderSession,
  type ProviderSessionManager,
  type SessionLookup,
} from "./subtitleProvider";

/** What a person pastes. Both halves, always together. */
export interface BrowserSessionMaterial {
  readonly cookie: string;
  readonly userAgent: string;
}

export type ProviderSessionState =
  | "anonymous"
  | "active"
  | "rejected"
  | "signed-out";

export interface ProviderSessionStatus {
  readonly providerId: string;
  readonly state: ProviderSessionState;
  readonly updatedAt: string | null;
  /** Our own words about why a session was refused. Never the provider's. */
  readonly reason: string | null;
}

const KEY_INFO = "seyirlik provider-session vault v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function deriveVaultKey(secret: string): Buffer {
  if (Buffer.byteLength(secret, "utf8") < 32)
    throw new Error("The provider session key needs a 32-byte secret.");
  return Buffer.from(
    hkdfSync("sha256", secret, "seyirlik", KEY_INFO, 32) as ArrayBuffer,
  );
}

/**
 * iv ‖ tag ‖ ciphertext of any JSON value, bound to the row id it was sealed
 * for. The row id is the associated data, so ciphertext moved between rows
 * does not open.
 */
export function sealJson(key: Buffer, rowId: string, value: unknown): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(rowId, "utf8"));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** The value, or null when the bytes were not sealed by this key for this row. */
export function unsealJson(
  key: Buffer,
  rowId: string,
  sealed: Buffer,
): unknown {
  if (sealed.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      sealed.subarray(0, IV_BYTES),
    );
    decipher.setAAD(Buffer.from(rowId, "utf8"));
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return JSON.parse(
      Buffer.concat([
        decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8"),
    ) as unknown;
  } catch {
    return null;
  }
}

/** iv ‖ tag ‖ ciphertext, bound to the provider id it was sealed for. */
export function seal(
  key: Buffer,
  providerId: string,
  material: BrowserSessionMaterial,
): Buffer {
  return sealJson(key, providerId, {
    cookie: material.cookie,
    userAgent: material.userAgent,
  });
}

/** The material, or null when the bytes were not sealed by this key for this provider. */
export function unseal(
  key: Buffer,
  providerId: string,
  sealed: Buffer,
): BrowserSessionMaterial | null {
  const value = unsealJson(
    key,
    providerId,
    sealed,
  ) as Partial<BrowserSessionMaterial> | null;
  return value &&
    typeof value.cookie === "string" &&
    typeof value.userAgent === "string"
    ? { cookie: value.cookie, userAgent: value.userAgent }
    : null;
}

/**
 * Refuses anything that is not plausibly a Cookie header and a user agent.
 *
 * Header injection is the concrete risk: a newline in either value would let a
 * paste add headers of its own to every request this server makes. Length
 * bounds keep a mistaken paste of a whole HAR file out of the vault.
 */
export function parseSessionMaterial(input: {
  cookie: unknown;
  userAgent: unknown;
}): BrowserSessionMaterial {
  const cookie =
    typeof input.cookie === "string"
      ? input.cookie.trim().replace(/^cookie:\s*/i, "")
      : "";
  const userAgent =
    typeof input.userAgent === "string"
      ? input.userAgent.trim().replace(/^user-agent:\s*/i, "")
      : "";
  // Visible ASCII and spaces only: no CR, LF or other control bytes.
  const printable = /^[\x20-\x7E]+$/;
  if (!cookie || cookie.length > 8192 || !printable.test(cookie))
    throw new Error("Paste the Cookie header as a single line.");
  if (
    !cookie
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .every((pair) => /^[^=\s;,]+=[^;]*$/.test(pair))
  )
    throw new Error("The Cookie header should be name=value pairs.");
  if (!userAgent || userAgent.length > 512 || !printable.test(userAgent))
    throw new Error("A user agent is required, as a single line.");
  return { cookie, userAgent };
}

export function createProviderSessionVault(options: {
  db: DatabaseExecutor;
  secret: string;
  /**
   * Providers that answer without a session, and the user agent to identify
   * this server by when they do. Honest: anonymous requests say what they are.
   */
  anonymous?: Readonly<Record<string, { userAgent: string }>>;
}) {
  const key = deriveVaultKey(options.secret);
  const read = async (providerId: string) =>
    (
      await options.db.query<{
        state: "active" | "rejected";
        sealed: Buffer | null;
        reason: string | null;
        updated_at: Date;
      }>(
        "SELECT state, sealed, reason, updated_at FROM provider_sessions WHERE provider_id = $1",
        [providerId],
      )
    ).rows[0];

  /*
   * Which version of the row this process last handed out. A refusal reported
   * for an old session must not wipe one somebody pasted in the meantime.
   */
  const issued = new Map<string, Date | null>();

  const manager: ProviderSessionManager = {
    async acquire(providerId): Promise<SessionLookup> {
      const row = await read(providerId);
      issued.set(providerId, row?.updated_at ?? null);
      const needsSignIn = (reason: string): SessionLookup => ({
        outcome: "needs-authentication",
        providerId,
        reason,
        authenticateAt: null,
      });
      if (!row) {
        const anonymous = options.anonymous?.[providerId];
        return anonymous
          ? {
              outcome: "ready",
              session: createProviderSession({
                providerId,
                cookie: "",
                userAgent: anonymous.userAgent,
              }),
            }
          : needsSignIn("Nobody has signed in to this provider yet.");
      }
      if (row.state === "rejected" || !row.sealed)
        return needsSignIn(row.reason ?? "The provider refused the session.");
      const material = unseal(key, providerId, row.sealed);
      if (!material)
        return needsSignIn(
          "The saved session cannot be read with this server's key. Sign in again.",
        );
      return {
        outcome: "ready",
        session: createProviderSession({ providerId, ...material }),
      };
    },
    async invalidate(providerId, reason) {
      const version = issued.get(providerId);
      if (version === undefined) return;
      if (version === null) {
        // An anonymous request was refused; a session stored since stands.
        await options.db.query(
          `INSERT INTO provider_sessions (provider_id, state, sealed, reason, updated_at)
           VALUES ($1, 'rejected', NULL, $2, now()) ON CONFLICT (provider_id) DO NOTHING`,
          [providerId, reason.slice(0, 300)],
        );
        return;
      }
      await options.db.query(
        `UPDATE provider_sessions SET state = 'rejected', sealed = NULL, reason = $2, updated_at = now()
         WHERE provider_id = $1 AND updated_at <= $3`,
        [providerId, reason.slice(0, 300), version],
      );
    },
  };

  return {
    manager,
    async store(providerId: string, material: BrowserSessionMaterial) {
      await options.db.query(
        `INSERT INTO provider_sessions (provider_id, state, sealed, reason, updated_at)
         VALUES ($1, 'active', $2, NULL, now())
         ON CONFLICT (provider_id) DO UPDATE SET state = 'active', sealed = $2, reason = NULL, updated_at = now()`,
        [providerId, seal(key, providerId, material)],
      );
    },
    /** Forget the session; an anonymous-capable provider is asked anonymously again. */
    async clear(providerId: string) {
      await options.db.query(
        "DELETE FROM provider_sessions WHERE provider_id = $1",
        [providerId],
      );
    },
    async status(providerId: string): Promise<ProviderSessionStatus> {
      const row = await read(providerId);
      if (!row)
        return {
          providerId,
          state: options.anonymous?.[providerId] ? "anonymous" : "signed-out",
          updatedAt: null,
          reason: null,
        };
      return {
        providerId,
        state: row.state,
        updatedAt: row.updated_at.toISOString(),
        reason: row.reason,
      };
    },
  };
}

export type ProviderSessionVault = ReturnType<
  typeof createProviderSessionVault
>;
