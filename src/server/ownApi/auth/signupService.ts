import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { OwnApiError } from "../ownApiHandler";
import { withTransaction } from "../database/transaction";
import { createUserRepository } from "../users/userRepository";
import {
  canonicalInviteCode,
  createInviteRepository,
  hashInviteCode,
} from "./invites";
import {
  validateDisplayName,
  validateSignupPassword,
  validateSignupUsername,
  type PasswordHasher,
} from "./passwords";

const UNIQUE_VIOLATION = "23505";

export interface SignupInput {
  username: string;
  displayName: string;
  password: string;
  inviteCode: string;
}

export interface SignupService {
  /** Creates the account, or throws an OwnApiError a person can act on. */
  signUp(input: SignupInput): Promise<{ userId: string; username: string }>;
}

function invalid(field: string, error: unknown): OwnApiError {
  return new OwnApiError(
    "VALIDATION_FAILED",
    error instanceof Error ? error.message : `${field} is invalid.`,
    422,
  );
}

function inviteRejected(): OwnApiError {
  // One answer for a code that never existed and one that is spent, expired
  // or revoked: which it is tells a guesser nothing a person needs.
  return new OwnApiError(
    "INVITE_INVALID",
    "That invite code is not valid, or it has already been used.",
    403,
  );
}

export function createSignupService({
  pool,
  passwords,
  inviteHashSecret,
  now = () => new Date(),
  idFactory = randomUUID,
}: {
  pool: Pick<Pool, "connect">;
  passwords: PasswordHasher;
  inviteHashSecret: string;
  now?: () => Date;
  idFactory?: () => string;
}): SignupService {
  return {
    async signUp(input) {
      let username: string;
      let displayName: string;
      let password: string;
      try {
        username = validateSignupUsername(input.username);
      } catch (error) {
        throw invalid("username", error);
      }
      try {
        displayName = validateDisplayName(input.displayName);
      } catch (error) {
        throw invalid("displayName", error);
      }
      try {
        password = validateSignupPassword(input.password);
      } catch (error) {
        throw invalid("password", error);
      }
      const code = canonicalInviteCode(input.inviteCode);
      if (!code) throw inviteRejected();

      // Hashed before the transaction: argon2 takes a while, and a row lock
      // on the invite should not be held for it.
      const passwordHash = await passwords.hash(password);
      const codeHash = hashInviteCode(code, inviteHashSecret);

      try {
        return await withTransaction(pool, async (client) => {
          const inviteId = await createInviteRepository(client).redeem(
            codeHash,
            now(),
          );
          if (!inviteId) throw inviteRejected();

          const user = await createUserRepository(client).create({
            id: idFactory(),
            normalizedUsername: username,
            displayName,
            passwordHash,
            isAdministrator: false,
            inviteId,
          });
          return { userId: user.id, username: user.normalizedUsername };
        });
      } catch (error) {
        // The unique index is the arbiter, not an earlier lookup: two people
        // choosing one name at once both pass a lookup. The rollback has
        // already given the invite's use back.
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === UNIQUE_VIOLATION
        ) {
          throw new OwnApiError(
            "USERNAME_TAKEN",
            "That username is already in use.",
            409,
          );
        }
        throw error;
      }
    },
  };
}
