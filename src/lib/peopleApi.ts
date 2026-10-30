import { ownApiClient, type OwnApiSignupConfig } from "../api/ownApi/client";

/**
 * The people page speaks Seyirlik's own user API directly, in its own shapes.
 * The older `MediaUser` mapping in mediaApi carried Jellyfin's fields, several
 * of which (hidden from login, remote access) the server never stored.
 */
export interface Person {
  id: string;
  /** Signs in with this. Never shown as the person's name. */
  username: string;
  /** Shown everywhere a name is shown. */
  displayName: string;
  isAdministrator: boolean;
  isDisabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  maxContentAge: number | null;
  allowUnratedContent: boolean;
  allowPlayback: boolean;
  allowDownloads: boolean;
  allowAllLibraries: boolean;
  libraryIds: string[];
  joinedByInvite: boolean;
}

export interface PersonChanges {
  displayName?: string;
  isAdministrator?: boolean;
  isDisabled?: boolean;
  allowPlayback?: boolean;
  allowDownloads?: boolean;
  allowAllLibraries?: boolean;
  libraryIds?: string[];
  maxContentAge?: number | null;
  allowUnratedContent?: boolean;
}

export type InviteState = "open" | "used" | "expired" | "revoked";

export interface Invite {
  id: string;
  label: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: InviteState;
}

export interface LibraryChoice {
  id: string;
  name: string;
}

export async function listPeople(): Promise<Person[]> {
  const people = await ownApiClient.request<Person[]>("/admin/users");
  return people.map((person) => ({
    ...person,
    libraryIds: person.libraryIds ?? [],
    joinedByInvite: person.joinedByInvite === true,
  }));
}

export function createPerson(input: {
  username: string;
  displayName: string;
  password: string;
  isAdministrator: boolean;
}): Promise<Person> {
  return ownApiClient.request<Person>("/admin/users", {
    method: "POST",
    body: input,
  });
}

export function updatePerson(
  id: string,
  changes: PersonChanges,
): Promise<Person> {
  return ownApiClient.request<Person>(
    `/admin/users/${encodeURIComponent(id)}`,
    { method: "PATCH", body: changes },
  );
}

/** "" makes the account passwordless. Signs the person out everywhere. */
export async function setPassword(id: string, password: string): Promise<void> {
  await ownApiClient.request<void>(
    `/admin/users/${encodeURIComponent(id)}/password`,
    { method: "PUT", body: { password } },
  );
}

export async function deletePerson(id: string): Promise<void> {
  await ownApiClient.request<void>(`/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function listInvites(): Promise<Invite[]> {
  return ownApiClient.request<Invite[]>("/admin/invites");
}

export function createInvite(input: {
  label?: string;
  maxUses: number;
  expiresInDays: number | null;
}): Promise<Invite & { code: string }> {
  return ownApiClient.request<Invite & { code: string }>("/admin/invites", {
    method: "POST",
    body: input,
  });
}

export function revokeInvite(id: string): Promise<Invite> {
  return ownApiClient.request<Invite>(
    `/admin/invites/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function listLibraryChoices(): Promise<LibraryChoice[]> {
  const libraries =
    await ownApiClient.request<Array<{ id: string; name: string }>>(
      "/libraries",
    );
  return libraries.map(({ id, name }) => ({ id, name }));
}

export function getSignupConfig(): Promise<OwnApiSignupConfig> {
  return ownApiClient.getSignupConfig();
}
