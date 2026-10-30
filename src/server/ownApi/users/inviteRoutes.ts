import { randomUUID } from "node:crypto";
import { OwnApiError } from "../ownApiHandler";
import { sendCreated, sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyInteger,
  optionalBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import {
  canonicalInviteCode,
  deriveInviteSealKey,
  hashInviteCode,
  newInviteCode,
  openInviteCode,
  sealInviteCode,
  type InviteRecord,
  type InviteRepository,
} from "../auth/invites";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_EXPIRY_DAYS = 90;

function inviteState(
  invite: InviteRecord,
  at: Date,
): "open" | "used" | "expired" | "revoked" {
  if (invite.revokedAt) return "revoked";
  if (invite.useCount >= invite.maxUses) return "used";
  if (invite.expiresAt && invite.expiresAt <= at) return "expired";
  return "open";
}

/**
 * An administrator may read a code back for as long as it can still admit
 * someone; a spent, expired or revoked one is history and stays sealed. A code
 * made before codes were kept has no text to show (`code: null`).
 */
function toInviteDto(invite: InviteRecord, at: Date, sealKey: Buffer) {
  const state = inviteState(invite, at);
  return {
    id: invite.id,
    label: invite.label,
    maxUses: invite.maxUses,
    useCount: invite.useCount,
    expiresAt: invite.expiresAt?.toISOString() ?? null,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
    state,
    code:
      state === "open"
        ? openInviteCode(sealKey, invite.id, invite.codeSealed)
        : null,
    codeKept: invite.codeSealed !== null,
  };
}

export function createInviteRoutes({
  invites,
  inviteHashSecret,
  now = () => new Date(),
}: {
  invites: InviteRepository;
  inviteHashSecret: string;
  now?: () => Date;
}): RouteDefinition[] {
  const sealKey = deriveInviteSealKey(inviteHashSecret);

  return [
    {
      method: "GET",
      path: "/admin/invites",
      access: "admin",
      handle: async (context) => {
        const at = now();
        sendData(
          context.response,
          context.requestId,
          (await invites.list()).map((invite) =>
            toInviteDto(invite, at, sealKey),
          ),
        );
      },
    },

    {
      method: "POST",
      path: "/admin/invites",
      access: "admin",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const body = asObjectBody(await context.readJson(4 * 1_024), [
          "label",
          "maxUses",
          "expiresInDays",
        ]);
        const label =
          optionalBodyString(body, "label", { maxLength: 100 })
            ?.normalize("NFKC")
            .trim() || null;
        if (label && /\p{Cc}/u.test(label)) {
          throw validationError("label is invalid.");
        }
        const maxUses =
          optionalBodyInteger(body, "maxUses", { min: 1, max: 100 }) ?? 1;
        // null is a code that never expires; absent is a week.
        let expiresInDays: number | null = 7;
        if ("expiresInDays" in body) {
          expiresInDays =
            body.expiresInDays === null
              ? null
              : (optionalBodyInteger(body, "expiresInDays", {
                  min: 1,
                  max: MAX_EXPIRY_DAYS,
                }) ?? 7);
        }

        const at = now();
        const code = newInviteCode();
        const canonical = canonicalInviteCode(code);
        if (!canonical) throw new Error("Generated an unreadable invite code.");
        const id = randomUUID();
        const created = await invites.create({
          id,
          codeHash: hashInviteCode(canonical, inviteHashSecret),
          codeSealed: sealInviteCode(sealKey, id, code),
          label,
          maxUses,
          expiresAt:
            expiresInDays === null
              ? null
              : new Date(at.getTime() + expiresInDays * DAY_MS),
          createdBy: principal.userId,
        });

        sendCreated(
          context.response,
          context.requestId,
          toInviteDto(created, at, sealKey),
          `/ownAPI/v1/admin/invites/${created.id}`,
        );
      },
    },

    {
      method: "DELETE",
      path: "/admin/invites/:inviteId",
      access: "admin",
      handle: async (context) => {
        const inviteId = requireUuid(context.params.inviteId, "inviteId");
        const at = now();
        const revoked = await invites.revoke(inviteId, at);
        if (!revoked) {
          throw new OwnApiError(
            "INVITE_NOT_FOUND",
            "The requested invite could not be found.",
            404,
          );
        }
        // Revoking keeps the row: the accounts it admitted still point at it.
        sendData(
          context.response,
          context.requestId,
          toInviteDto(revoked, at, sealKey),
        );
      },
    },
  ];
}
