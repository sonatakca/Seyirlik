import {
  argon2id,
  hash as argon2Hash,
  verify as argon2Verify,
  type HashOptions,
} from "argon2";

export const ARGON2ID_OPTIONS = Object.freeze({
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} satisfies HashOptions & {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
});

// No naming or strength rule: the administrator decides what an account is
// called and whether it has a password at all ("" is a passwordless account,
// still stored as an argon2id hash of the empty string). What remains are the
// bounds the schema and the hasher need: a username that exists, fits
// `normalized_username varchar(64)` and carries no control characters, and a
// password short enough that hashing it is cheap.
const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_BYTES = 128;
const CONTROL_CHARACTER = /\p{Cc}/u;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export function normalizeUsername(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function validateUsername(value: string): string {
  const normalized = normalizeUsername(value);

  if (
    normalized.length === 0 ||
    Array.from(normalized).length > MAX_USERNAME_LENGTH ||
    CONTROL_CHARACTER.test(normalized)
  ) {
    throw new Error(
      `Username must not be empty, must be at most ${MAX_USERNAME_LENGTH} characters, and must not contain control characters.`,
    );
  }

  return normalized;
}

export function validatePassword(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error(
      `Password must be at most ${MAX_PASSWORD_BYTES} UTF-8 bytes.`,
    );
  }

  return value;
}

export function createArgon2PasswordHasher(): PasswordHasher {
  return {
    hash: (password) =>
      argon2Hash(validatePassword(password), ARGON2ID_OPTIONS),
    verify: async (passwordHash, password) => {
      try {
        return await argon2Verify(passwordHash, password);
      } catch {
        return false;
      }
    },
  };
}
