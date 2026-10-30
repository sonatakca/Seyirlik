// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RouteDefinition } from "../api/router";
import {
  deriveInviteSealKey,
  sealInviteCode,
  type InviteRecord,
  type InviteRepository,
} from "../auth/invites";
import { createInviteRoutes } from "./inviteRoutes";

const SECRET = "invite-secret-at-least-thirty-two-bytes";
const NOW = new Date("2026-10-30T12:00:00.000Z");

function record(
  id: string,
  overrides: Partial<InviteRecord> = {},
): InviteRecord {
  return {
    id,
    label: null,
    maxUses: 1,
    useCount: 0,
    expiresAt: null,
    revokedAt: null,
    createdBy: null,
    createdAt: NOW,
    codeSealed: sealInviteCode(deriveInviteSealKey(SECRET), id, `CODE-${id}`),
    ...overrides,
  };
}

async function call(route: RouteDefinition, body?: unknown) {
  const captured = { status: 0, body: null as unknown };
  const context = {
    request: { headers: {} },
    response: {
      statusCode: 0,
      setHeader() {},
      end(payload: string) {
        captured.status = this.statusCode;
        captured.body = JSON.parse(payload);
      },
    },
    requestId: "request",
    params: {},
    readJson: async () => body,
    requirePrincipal: () => ({ userId: "admin" }),
  };
  await route.handle(context as never);
  return captured as { status: number; body: { data: unknown } };
}

describe("invite routes", () => {
  it("shows the code of an open invite, and only of an open one", async () => {
    const invites = {
      list: async () => [
        record("open"),
        record("revoked", { revokedAt: NOW }),
        record("used", { useCount: 1 }),
        record("legacy", { codeSealed: null }),
      ],
    } as unknown as InviteRepository;
    const route = createInviteRoutes({
      invites,
      inviteHashSecret: SECRET,
      now: () => NOW,
    }).find((entry) => entry.method === "GET") as RouteDefinition;

    const { body } = await call(route);
    const rows = body.data as Array<{
      id: string;
      code: string | null;
      codeKept: boolean;
    }>;
    expect(rows.map(({ id, code, codeKept }) => [id, code, codeKept])).toEqual([
      ["open", "CODE-open", true],
      ["revoked", null, true],
      ["used", null, true],
      ["legacy", null, false],
    ]);
  });

  it("seals a new code for its own invite and returns it", async () => {
    let stored: { id: string; codeSealed: Buffer } | null = null;
    const invites = {
      create: async (input: { id: string; codeSealed: Buffer }) => {
        stored = input;
        return record(input.id, { codeSealed: input.codeSealed });
      },
    } as unknown as InviteRepository;
    const route = createInviteRoutes({
      invites,
      inviteHashSecret: SECRET,
      now: () => NOW,
    }).find((entry) => entry.method === "POST") as RouteDefinition;

    const { status, body } = await call(route, { maxUses: 1 });
    const created = body.data as { id: string; code: string };
    expect(status).toBe(201);
    expect(created.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(stored!.id).toBe(created.id);
    expect(stored!.codeSealed.includes(Buffer.from(created.code))).toBe(false);
  });
});
