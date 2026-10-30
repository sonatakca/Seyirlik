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
const MAX_DISPLAY_NAME_LENGTH = 100;
const MIN_SIGNUP_PASSWORD_LENGTH = 8;
const SIGNUP_USERNAME = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;

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

/**
 * The name other people see. It is shown, never signed in with, so it may be
 * anything a person is called (spaces, Turkish letters) within the column.
 */
export function validateDisplayName(value: string): string {
  const normalized = value.normalize("NFKC").trim();

  if (
    !normalized ||
    Array.from(normalized).length > MAX_DISPLAY_NAME_LENGTH ||
    CONTROL_CHARACTER.test(normalized)
  ) {
    throw new Error(
      `Display name must contain between 1 and ${MAX_DISPLAY_NAME_LENGTH} characters and no control characters.`,
    );
  }

  return normalized;
}

/**
 * The stricter rule for a username a person picks for themself. An
 * administrator may still name an account anything `validateUsername` allows;
 * a stranger signing up may not register a lookalike, a name with spaces, or
 * one too short to tell apart.
 */
export function validateSignupUsername(value: string): string {
  const normalized = validateUsername(value);

  if (!SIGNUP_USERNAME.test(normalized)) {
    throw new Error(
      "Username must be 3 to 32 characters: letters a-z, digits, dot, underscore or hyphen, starting and ending with a letter or digit.",
    );
  }

  return normalized;
}

/** A self-made account always has a password, and not a trivial one. */
export function validateSignupPassword(value: string): string {
  if (Array.from(value).length < MIN_SIGNUP_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_SIGNUP_PASSWORD_LENGTH} characters.`,
    );
  }

  return validatePassword(value);
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
