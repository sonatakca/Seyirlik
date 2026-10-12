import { randomUUID } from "node:crypto";
import { OwnApiError } from "../ownApiHandler";
import { sendCreated, sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyBoolean,
  optionalBodyString,
  optionalBodyStringArray,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import type { UserRepository, NativeUserRecord } from "./userRepository";
import {
  validatePassword,
  validateUsername,
  type PasswordHasher,
} from "../auth/passwords";
import type { SessionRepository } from "../auth/sessionRepository";

export interface UserRoutesOptions {
  users: UserRepository;
  sessions: SessionRepository;
  passwords: PasswordHasher;
}

const MAX_PASSWORD_BYTES = 256;

function userNotFound(): OwnApiError {
  return new OwnApiError(
    "USER_NOT_FOUND",
    "The requested user could not be found.",
    404,
  );
}

/** Never includes the password hash, and never the raw normalized username. */
function toUserDto(
  user: NativeUserRecord,
  libraryIds: string[] | undefined = undefined,
) {
  return {
    id: user.id,
    username: user.normalizedUsername,
    displayName: user.displayName,
    isAdministrator: user.isAdministrator,
    isDisabled: user.isDisabled,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastSuccessfulLoginAt?.toISOString() ?? null,
    maxContentAge: user.maxContentAge,
    allowUnratedContent: user.allowUnratedContent,
    allowPlayback: user.allowPlayback,
    allowDownloads: user.allowDownloads,
    allowAllLibraries: user.allowAllLibraries,
    ...(libraryIds === undefined ? {} : { libraryIds }),
  };
}

function requirePassword(body: Record<string, unknown>, field: string): string {
  // An empty string is a passwordless account.
  const password = requireBodyString(body, field, {
    minLength: 0,
    maxLength: 512,
  });
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw validationError(`${field} is invalid.`);
  }

  // The rule lives with the hasher so provisioning, self-service and
  // administration cannot drift apart.
  try {
    return validatePassword(password);
  } catch {
    throw validationError(`${field} is too long.`);
  }
}

/**
 * The shared rule throws a plain Error, which the handler would report as a
 * 500 — and did, for every name with a space or a Turkish letter in it.
 */
function requireUsername(raw: string): string {
  try {
    return validateUsername(raw);
  } catch (error) {
    throw validationError(
      error instanceof Error ? error.message : "username is invalid.",
    );
  }
}

export function createUserRoutes({
  users,
  sessions,
  passwords,
}: UserRoutesOptions): RouteDefinition[] {
  /**
   * Refuses a change that would leave the deployment with no way in. Checked on
   * demotion, disabling and deletion alike, because all three have the same
   * effect on the last administrator.
   */
  async function assertNotLastAdministrator(
    user: NativeUserRecord,
    stillEligible: boolean,
  ): Promise<void> {
    if (!user.isAdministrator || user.isDisabled || stillEligible) return;

    if ((await users.countEligibleAdministrators()) <= 1) {
      throw new OwnApiError(
        "LAST_ADMINISTRATOR",
        "The last administrator cannot be removed or demoted.",
        409,
      );
    }
  }

  return [
    {
      method: "GET",
      path: "/admin/users",
      access: "admin",
      handle: async (context) => {
        const all = await users.list();
        const withPermissions = await Promise.all(
          all.map(async (user) =>
            toUserDto(user, await users.listLibraryPermissions(user.id)),
          ),
        );
        sendData(context.response, context.requestId, withPermissions);
      },
    },

    {
      method: "GET",
      path: "/admin/users/:userId",
      access: "admin",
      handle: async (context) => {
        const userId = requireUuid(context.params.userId, "userId");
        const user = await users.findById(userId);
        if (!user) throw userNotFound();

        sendData(
          context.response,
          context.requestId,
          toUserDto(user, await users.listLibraryPermissions(userId)),
        );
      },
    },

    {
      method: "POST",
      path: "/admin/users",
      access: "admin",
      handle: async (context) => {
        const body = asObjectBody(await context.readJson(8 * 1_024), [
          "username",
          "password",
          "displayName",
          "isAdministrator",
        ]);

        const rawUsername = requireBodyString(body, "username", {
          maxLength: 128,
        });
        const normalizedUsername = requireUsername(rawUsername);

        if (await users.findByNormalizedUsername(normalizedUsername)) {
          throw new OwnApiError(
            "USERNAME_TAKEN",
            "That username is already in use.",
            409,
          );
        }

        const created = await users.create({
          id: randomUUID(),
          normalizedUsername,
          displayName:
            optionalBodyString(body, "displayName", { maxLength: 100 }) ??
            rawUsername.trim(),
          passwordHash: await passwords.hash(requirePassword(body, "password")),
          isAdministrator:
            optionalBodyBoolean(body, "isAdministrator") === true,
        });

        sendCreated(
          context.response,
          context.requestId,
          toUserDto(created, []),
          `/ownAPI/v1/admin/users/${created.id}`,
        );
      },
    },

    {
      method: "PATCH",
      path: "/admin/users/:userId",
      access: "admin",
      handle: async (context) => {
        const userId = requireUuid(context.params.userId, "userId");
        const existing = await users.findById(userId);
        if (!existing) throw userNotFound();

        const body = asObjectBody(await context.readJson(8 * 1_024), [
          "displayName",
          "isAdministrator",
          "isDisabled",
          "allowPlayback",
          "allowDownloads",
          "allowAllLibraries",
          "libraryIds",
          "maxContentAge",
          "allowUnratedContent",
        ]);

        /*
         * Three states, so absent and null are different things: absent leaves
         * the limit as it is, null removes it.
         */
        let maxContentAge: number | null | undefined;
        if ("maxContentAge" in body) {
          const value = body.maxContentAge;
          if (value === null) maxContentAge = null;
          else if (
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= 0 &&
            value <= 21
          ) {
            maxContentAge = value;
          } else {
            throw validationError("maxContentAge is invalid.");
          }
        }
        const allowUnratedContent = optionalBodyBoolean(
          body,
          "allowUnratedContent",
        );

        const isAdministrator = optionalBodyBoolean(body, "isAdministrator");
        const isDisabled = optionalBodyBoolean(body, "isDisabled");
        await assertNotLastAdministrator(
          existing,
          isAdministrator !== false && isDisabled !== true,
        );

        const libraryIds = optionalBodyStringArray(body, "libraryIds", {
          maxItems: 100,
          maxLength: 64,
        });
        if (libraryIds?.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
          throw validationError("libraryIds is invalid.");
        }

        const updated = await users.update(userId, {
          ...(optionalBodyString(body, "displayName", { maxLength: 100 })
            ? {
                displayName: optionalBodyString(body, "displayName", {
                  maxLength: 100,
                }) as string,
              }
            : {}),
          ...(isAdministrator === undefined ? {} : { isAdministrator }),
          ...(isDisabled === undefined ? {} : { isDisabled }),
          ...(optionalBodyBoolean(body, "allowPlayback") === undefined
            ? {}
            : {
                allowPlayback: optionalBodyBoolean(
                  body,
                  "allowPlayback",
                ) as boolean,
              }),
          ...(optionalBodyBoolean(body, "allowDownloads") === undefined
            ? {}
            : {
                allowDownloads: optionalBodyBoolean(
                  body,
                  "allowDownloads",
                ) as boolean,
              }),
          ...(maxContentAge === undefined ? {} : { maxContentAge }),
          ...(allowUnratedContent === undefined ? {} : { allowUnratedContent }),
          ...(optionalBodyBoolean(body, "allowAllLibraries") === undefined
            ? {}
            : {
                allowAllLibraries: optionalBodyBoolean(
                  body,
                  "allowAllLibraries",
                ) as boolean,
              }),
        });
        if (!updated) throw userNotFound();

        if (libraryIds) {
          await users.replaceLibraryPermissions(userId, libraryIds);
        }

        // Disabling a user must take effect immediately, not when their session
        // happens to expire.
        if (isDisabled === true) {
          await sessions.revokeAllForUser(userId, new Date());
        }

        sendData(
          context.response,
          context.requestId,
          toUserDto(updated, await users.listLibraryPermissions(userId)),
        );
      },
    },

    {
      method: "PUT",
      path: "/admin/users/:userId/password",
      access: "admin",
      handle: async (context) => {
        const userId = requireUuid(context.params.userId, "userId");
        if (!(await users.findById(userId))) throw userNotFound();

        const body = asObjectBody(await context.readJson(4 * 1_024), [
          "password",
        ]);
        await users.setPasswordHash(
          userId,
          await passwords.hash(requirePassword(body, "password")),
        );

        // Every existing session used the old credential; a password change is
        // meaningless if they survive it.
        await sessions.revokeAllForUser(userId, new Date());
        sendNoContent(context.response);
      },
    },

    {
      method: "DELETE",
      path: "/admin/users/:userId",
      access: "admin",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const userId = requireUuid(context.params.userId, "userId");

        if (userId === principal.userId) {
          throw new OwnApiError(
            "SELF_DELETE_FORBIDDEN",
            "You cannot delete your own account.",
            409,
          );
        }

        const existing = await users.findById(userId);
        if (!existing) throw userNotFound();
        await assertNotLastAdministrator(existing, false);

        await users.delete(userId);
        sendNoContent(context.response);
      },
    },
  ];
}
