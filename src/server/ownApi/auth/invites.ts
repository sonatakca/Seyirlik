import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
} from "node:crypto";
import type { DatabaseExecutor } from "../database/databaseTypes";

/*
 * Crockford's base32: no I, L, O or U, so a code read aloud or copied by hand
 * survives the letters people confuse. Twelve characters are 60 bits, far
 * past guessing at the rate sign-up lets anyone try.
 */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;
const CODE_GROUP = 4;
const SEAL_INFO = "seyirlik invite codes v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface InviteRecord {
  id: string;
  label: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  /** The code, sealed; null for codes made before it was kept. */
  codeSealed: Buffer | null;
}

interface InviteRow {
  id: string;
  label: string | null;
  max_uses: number;
  use_count: number;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by: string | null;
  created_at: Date;
  code_sealed: Buffer | null;
}

function mapInvite(row: InviteRow): InviteRecord {
  return {
    id: row.id,
    label: row.label,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    codeSealed: row.code_sealed ?? null,
  };
}

/** A fresh code, grouped for reading: `7KQ2-M9XD-4TWB`. */
export function newInviteCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    if (index > 0 && index % CODE_GROUP === 0) code += "-";
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * The code as typed, reduced to the characters that identify it. Case,
 * spaces and hyphens are presentation, and the letters Crockford's alphabet
 * leaves out are read as the digits they are mistaken for. Null when what is
 * left cannot be a code at all.
 */
export function canonicalInviteCode(value: string): string | null {
  const reduced = value
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (reduced.length !== CODE_LENGTH) return null;
  for (const character of reduced) {
    if (!CODE_ALPHABET.includes(character)) return null;
  }
  return reduced;
}

export function hashInviteCode(canonicalCode: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update("seyirlik-invite-code\0")
    .update(canonicalCode)
    .digest();
}

/**
 * The key invite codes are sealed under. Derived, with its own label, from a
 * secret that lives only in the secrets file, so a copy of the database alone
 * does not show the codes.
 */
export function deriveInviteSealKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, "seyirlik", SEAL_INFO, 32) as ArrayBuffer,
  );
}

/** iv ‖ tag ‖ ciphertext, bound to the invite's id. */
export function sealInviteCode(
  key: Buffer,
  inviteId: string,
  code: string,
): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(inviteId, "utf8"));
  const body = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** The code, or null when these bytes were not sealed for this invite. */
export function openInviteCode(
  key: Buffer,
  inviteId: string,
  sealed: Buffer | null,
): string | null {
  if (!sealed || sealed.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      sealed.subarray(0, IV_BYTES),
    );
    decipher.setAAD(Buffer.from(inviteId, "utf8"));
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export interface InviteRepository {
  create(input: {
    id: string;
    codeHash: Buffer;
    codeSealed: Buffer;
    label: string | null;
    maxUses: number;
    expiresAt: Date | null;
    createdBy: string | null;
  }): Promise<InviteRecord>;
  list(): Promise<InviteRecord[]>;
  revoke(id: string, at: Date): Promise<InviteRecord | null>;
  /**
   * Takes one use of a live code and answers its id, or null when the code
   * does not exist, is used up, expired or revoked. One statement, so two
   * people racing for the last use cannot both have it; run it inside the
   * transaction that creates the account, so a failed sign-up gives the use
   * back.
   */
  redeem(codeHash: Buffer, at: Date): Promise<string | null>;
}

export function createInviteRepository(
  database: DatabaseExecutor,
): InviteRepository {
  return {
    async create(input) {
      const result = await database.query<InviteRow>(
        `INSERT INTO native_invites (
           id, code_hash, label, max_uses, expires_at, created_by, code_sealed
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, label, max_uses, use_count, expires_at, revoked_at,
                   created_by, created_at, code_sealed`,
        [
          input.id,
          input.codeHash,
          input.label,
          input.maxUses,
          input.expiresAt,
          input.createdBy,
          input.codeSealed,
        ],
      );
      return mapInvite(result.rows[0] as InviteRow);
    },

    async list() {
      const result = await database.query<InviteRow>(
        `SELECT id, label, max_uses, use_count, expires_at, revoked_at,
                created_by, created_at, code_sealed
         FROM native_invites
         ORDER BY created_at DESC`,
      );
      return result.rows.map(mapInvite);
    },

    async revoke(id, at) {
      const result = await database.query<InviteRow>(
        `UPDATE native_invites
         SET revoked_at = COALESCE(revoked_at, $2)
         WHERE id = $1
         RETURNING id, label, max_uses, use_count, expires_at, revoked_at,
                   created_by, created_at, code_sealed`,
        [id, at],
      );
      const row = result.rows[0];
      return row ? mapInvite(row) : null;
    },

    async redeem(codeHash, at) {
      const result = await database.query<{ id: string }>(
        `UPDATE native_invites
         SET use_count = use_count + 1
         WHERE code_hash = $1
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > $2)
           AND use_count < max_uses
         RETURNING id`,
        [codeHash, at],
      );
      return result.rows[0]?.id ?? null;
    },
  };
}
