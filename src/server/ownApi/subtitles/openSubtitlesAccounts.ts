/**
 * Where the OpenSubtitles API key and account sign-ins are kept.
 *
 * OpenSubtitles meters downloads per account per day, so a person may sign in
 * more than one account and the provider spends them in slot order. Unlike
 * TürkçeAltyazı's cookie, a sign-in here is a username and password: the token
 * it buys lasts a day, and only the password can buy the next one unattended.
 *
 * Everything lives in `provider_sessions` beside TürkçeAltyazı's session, one
 * row per secret (`opensubtitles-key`, `opensubtitles-1`, `opensubtitles-2`),
 * sealed exactly as that session is: AES-256-GCM under a key derived from the
 * secrets file, with the row id as associated data. Nothing sealed here is
 * ever returned over HTTP; a status names the account and nothing more.
 *
 * A password the far end refuses is dropped rather than kept (`rejected`), for
 * the reason a dead cookie is: it is still somebody's password.
 */
import type { DatabaseExecutor } from "../database/databaseTypes";
import { deriveVaultKey, sealJson, unsealJson } from "./providerSessionVault";
import type {
  OpenSubtitlesAccount,
  OpenSubtitlesCredentials,
} from "./openSubtitlesProvider";

/** How many accounts a person may sign in. */
export const OPENSUBTITLES_ACCOUNT_SLOTS = [1, 2] as const;
export type OpenSubtitlesSlot = (typeof OPENSUBTITLES_ACCOUNT_SLOTS)[number];

const KEY_ROW = "opensubtitles-key";
const accountRow = (slot: number) => `opensubtitles-${slot}`;

export function isOpenSubtitlesSlot(value: number): value is OpenSubtitlesSlot {
  return (OPENSUBTITLES_ACCOUNT_SLOTS as readonly number[]).includes(value);
}

/**
 * Refuses anything that could not be a username, password or API key.
 *
 * All three go into request headers or a JSON body, so control bytes are the
 * concrete risk; the bounds keep a mistaken paste out of the vault.
 */
export function parseAccountInput(input: {
  username: unknown;
  password: unknown;
}): { username: string; password: string } {
  const username =
    typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!username || username.length > 100 || !/^[\x20-\x7E]+$/.test(username))
    throw new Error("A username is required, on one line.");
  const control = [...password].some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (!password || password.length > 200 || control)
    throw new Error("A password is required, on one line.");
  return { username, password };
}

export function parseApiKey(input: unknown): string {
  const key = typeof input === "string" ? input.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key))
    throw new Error("Paste the API key as it is shown on OpenSubtitles.");
  return key;
}

export type OpenSubtitlesAccountState = "active" | "rejected" | "signed-out";

export interface OpenSubtitlesAccountStatus {
  readonly slot: number;
  readonly state: OpenSubtitlesAccountState;
  /** Which account this is. Never the password. */
  readonly username: string | null;
  /** Our own words: why it was refused, or that its downloads are spent. */
  readonly reason: string | null;
  readonly updatedAt: string | null;
}

export interface OpenSubtitlesStatus {
  readonly apiKey: {
    readonly state: "active" | "signed-out";
    readonly updatedAt: string | null;
  };
  readonly accounts: readonly OpenSubtitlesAccountStatus[];
}

const REDACTED = "[opensubtitles account withheld]";

export function createOpenSubtitlesAccounts(options: {
  db: DatabaseExecutor;
  secret: string;
}) {
  const key = deriveVaultKey(options.secret);
  const read = async (rowId: string) =>
    (
      await options.db.query<{
        state: "active" | "rejected";
        sealed: Buffer | null;
        reason: string | null;
        updated_at: Date;
      }>(
        "SELECT state, sealed, reason, updated_at FROM provider_sessions WHERE provider_id = $1",
        [rowId],
      )
    ).rows[0];
  const store = (rowId: string, value: unknown) =>
    options.db.query(
      `INSERT INTO provider_sessions (provider_id, state, sealed, reason, updated_at)
       VALUES ($1, 'active', $2, NULL, now())
       ON CONFLICT (provider_id) DO UPDATE SET state = 'active', sealed = $2, reason = NULL, updated_at = now()`,
      [rowId, sealJson(key, rowId, value)],
    );
  const openAccount = (
    rowId: string,
    sealed: Buffer | null,
  ): { username: string; password: string } | null => {
    const value = sealed
      ? (unsealJson(key, rowId, sealed) as {
          username?: unknown;
          password?: unknown;
        } | null)
      : null;
    return value &&
      typeof value.username === "string" &&
      typeof value.password === "string"
      ? { username: value.username, password: value.password }
      : null;
  };

  const credentials: OpenSubtitlesCredentials = {
    async apiKey() {
      const row = await read(KEY_ROW);
      if (!row?.sealed || row.state !== "active") return null;
      const value = unsealJson(key, KEY_ROW, row.sealed) as {
        apiKey?: unknown;
      } | null;
      return typeof value?.apiKey === "string" ? value.apiKey : null;
    },
    async accounts() {
      const accounts: OpenSubtitlesAccount[] = [];
      for (const slot of OPENSUBTITLES_ACCOUNT_SLOTS) {
        const row = await read(accountRow(slot));
        if (!row || row.state !== "active") continue;
        const material = openAccount(accountRow(slot), row.sealed);
        if (!material) continue;
        accounts.push({
          slot,
          version: row.updated_at.toISOString(),
          username: material.username,
          revealPassword: () => material.password,
          toJSON: () => REDACTED,
          toString: () => REDACTED,
        });
      }
      return accounts;
    },
    async reject(slot, version, reason) {
      /*
       * Only the sign-in that was refused: one saved since then stands. The
       * version is a JavaScript date, so the column is compared at the
       * millisecond precision the version was read at.
       */
      await options.db.query(
        `UPDATE provider_sessions SET state = 'rejected', sealed = NULL, reason = $2, updated_at = now()
         WHERE provider_id = $1 AND date_trunc('milliseconds', updated_at) <= $3`,
        [accountRow(slot), reason.slice(0, 300), new Date(version)],
      );
    },
    async noteQuota(slot, until) {
      // A note, not a state: the account is still signed in, and still first.
      await options.db.query(
        `UPDATE provider_sessions SET reason = $2
         WHERE provider_id = $1 AND state = 'active'`,
        [
          accountRow(slot),
          until
            ? `Today's downloads are used up; they renew at ${until.toISOString()}.`
            : null,
        ],
      );
    },
  };

  return {
    credentials,
    async storeApiKey(apiKey: string) {
      await store(KEY_ROW, { apiKey });
    },
    async clearApiKey() {
      await options.db.query(
        "DELETE FROM provider_sessions WHERE provider_id = $1",
        [KEY_ROW],
      );
    },
    async storeAccount(
      slot: OpenSubtitlesSlot,
      account: { username: string; password: string },
    ) {
      await store(accountRow(slot), {
        username: account.username,
        password: account.password,
      });
    },
    async clearAccount(slot: OpenSubtitlesSlot) {
      await options.db.query(
        "DELETE FROM provider_sessions WHERE provider_id = $1",
        [accountRow(slot)],
      );
    },
    async status(): Promise<OpenSubtitlesStatus> {
      const keyRow = await read(KEY_ROW);
      const accounts: OpenSubtitlesAccountStatus[] = [];
      for (const slot of OPENSUBTITLES_ACCOUNT_SLOTS) {
        const row = await read(accountRow(slot));
        accounts.push({
          slot,
          state: row ? row.state : "signed-out",
          username:
            row?.state === "active"
              ? (openAccount(accountRow(slot), row.sealed)?.username ?? null)
              : null,
          reason: row?.reason ?? null,
          updatedAt: row?.updated_at.toISOString() ?? null,
        });
      }
      return {
        apiKey: {
          state: keyRow?.state === "active" ? "active" : "signed-out",
          updatedAt: keyRow?.updated_at.toISOString() ?? null,
        },
        accounts,
      };
    },
  };
}

export type OpenSubtitlesAccountStore = ReturnType<
  typeof createOpenSubtitlesAccounts
>;
