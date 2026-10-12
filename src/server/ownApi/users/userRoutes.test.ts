// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RouteContext, RouteDefinition } from "../api/router";
import type { PasswordHasher } from "../auth/passwords";
import type { SessionRepository } from "../auth/sessionRepository";
import type { OwnApiError } from "../ownApiHandler";
import type {
  CreateNativeUserInput,
  NativeUserRecord,
  UserRepository,
} from "./userRepository";
import { createUserRoutes } from "./userRoutes";

const ADMIN = "11111111-1111-4111-8111-111111111111";

function setup() {
  const created: CreateNativeUserInput[] = [];
  const hashed: string[] = [];
  const users = {
    findByNormalizedUsername: async (username: string) =>
      username === "taken" ? ({ id: ADMIN } as NativeUserRecord) : null,
    create: async (input: CreateNativeUserInput) => {
      created.push(input);
      const at = new Date(Date.UTC(2026, 9, 12));
      return {
        ...input,
        isDisabled: false,
        passwordChangedAt: at,
        createdAt: at,
        updatedAt: at,
        lastSuccessfulLoginAt: null,
        maxContentAge: null,
        allowUnratedContent: false,
        allowPlayback: true,
        allowDownloads: false,
        allowAllLibraries: true,
      } satisfies NativeUserRecord;
    },
  } as unknown as UserRepository;
  const passwords: PasswordHasher = {
    hash: async (password) => {
      hashed.push(password);
      return `$argon2id$fake$${password.length}`;
    },
    verify: async () => false,
  };

  const route = createUserRoutes({
    users,
    passwords,
    sessions: {} as SessionRepository,
  }).find(
    (entry) => entry.method === "POST" && entry.path === "/admin/users",
  ) as RouteDefinition;

  async function create(body: unknown) {
    const captured = { status: 0, body: null as unknown };
    const context = {
      request: { headers: {} },
      response: {
        setHeader: () => undefined,
        end: (chunk?: string) => {
          captured.body = chunk ? JSON.parse(chunk) : null;
        },
        set statusCode(status: number) {
          captured.status = status;
        },
        get statusCode() {
          return captured.status;
        },
      },
      requestId: "req",
      url: new URL("http://localhost/ownAPI/v1/admin/users"),
      params: {},
      method: "POST",
      requirePrincipal: () => ({ userId: ADMIN, isAdministrator: true }),
      readJson: async () => body,
    } as unknown as RouteContext;

    try {
      await route.handle(context);
      return { ...captured, error: undefined as OwnApiError | undefined };
    } catch (error) {
      return { ...captured, error: error as OwnApiError };
    }
  }

  return { create, created, hashed };
}

describe("creating a user", () => {
  it.each(["Ayşe", "Ali Veli", "ab", "q"])(
    "accepts %j as a username, keeping it as the display name",
    async (name) => {
      const { create, created } = setup();
      const result = await create({
        username: name,
        password: "qa-motion",
        displayName: name,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(201);
      expect(created[0]?.normalizedUsername).toBe(
        name.toLocaleLowerCase("en-US"),
      );
      expect(created[0]?.displayName).toBe(name);
    },
  );

  it("creates a passwordless account from an empty password", async () => {
    const { create, hashed } = setup();
    const result = await create({ username: "misafir", password: "" });

    expect(result.status).toBe(201);
    expect(hashed).toEqual([""]);
  });

  // These used to escape as a plain Error and reach the browser as a 500
  // "internal error", with nothing to say what was wrong with the name.
  it.each([
    ["an empty name", "   "],
    ["a control character", "a\u0007b"],
    ["more than 64 characters", "ş".repeat(65)],
  ])("refuses %s with a validation error, not a 500", async (_, name) => {
    const { create, created } = setup();
    const result = await create({ username: name, password: "" });

    expect(result.error?.code).toBe("VALIDATION_FAILED");
    expect(result.error?.statusCode).toBe(422);
    expect(created).toEqual([]);
  });

  it("still refuses a username that is already in use", async () => {
    const { create } = setup();
    const result = await create({ username: "Taken", password: "" });

    expect(result.error?.code).toBe("USERNAME_TAKEN");
  });
});
