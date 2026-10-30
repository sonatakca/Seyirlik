import type { DatabaseExecutor } from "../database/databaseTypes";

interface UserRow {
  id: string;
  normalized_username: string;
  display_name: string;
  password_hash: string;
  is_administrator: boolean;
  is_disabled: boolean;
  password_changed_at: Date;
  created_at: Date;
  updated_at: Date;
  last_successful_login_at: Date | null;
  max_content_age: number | null;
  allow_unrated_content: boolean;
  allow_playback: boolean;
  allow_downloads: boolean;
  allow_all_libraries: boolean;
  invite_id: string | null;
}

export interface NativeUserRecord {
  id: string;
  normalizedUsername: string;
  displayName: string;
  passwordHash: string;
  isAdministrator: boolean;
  isDisabled: boolean;
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastSuccessfulLoginAt: Date | null;
  /** Oldest rating age this viewer may see; null is no limit. */
  maxContentAge: number | null;
  /** Whether a viewer with a limit may see titles no board has rated. */
  allowUnratedContent: boolean;
  allowPlayback: boolean;
  allowDownloads: boolean;
  allowAllLibraries: boolean;
  /** The invite that admitted a self-made account; null when made for them. */
  inviteId: string | null;
}

export interface CreateNativeUserInput {
  id: string;
  normalizedUsername: string;
  displayName: string;
  passwordHash: string;
  isAdministrator: boolean;
  inviteId?: string;
}

function mapUser(row: UserRow): NativeUserRecord {
  return {
    id: row.id,
    normalizedUsername: row.normalized_username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    isAdministrator: row.is_administrator,
    isDisabled: row.is_disabled,
    passwordChangedAt: row.password_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSuccessfulLoginAt: row.last_successful_login_at,
    maxContentAge: row.max_content_age ?? null,
    allowUnratedContent: row.allow_unrated_content ?? false,
    allowPlayback: row.allow_playback ?? true,
    allowDownloads: row.allow_downloads ?? false,
    allowAllLibraries: row.allow_all_libraries ?? true,
    inviteId: row.invite_id ?? null,
  };
}

export interface UpdateNativeUserInput {
  displayName?: string;
  isAdministrator?: boolean;
  isDisabled?: boolean;
  allowPlayback?: boolean;
  allowDownloads?: boolean;
  allowAllLibraries?: boolean;
  /** A number sets the limit, null removes it, absent leaves it alone. */
  maxContentAge?: number | null;
  allowUnratedContent?: boolean;
}

export interface UserRepository {
  create(input: CreateNativeUserInput): Promise<NativeUserRecord>;
  findById(id: string): Promise<NativeUserRecord | null>;
  findByNormalizedUsername(username: string): Promise<NativeUserRecord | null>;
  countEligibleAdministrators(): Promise<number>;
  recordSuccessfulLogin(id: string, at: Date): Promise<void>;
  list(): Promise<NativeUserRecord[]>;
  update(
    id: string,
    input: UpdateNativeUserInput,
  ): Promise<NativeUserRecord | null>;
  setPasswordHash(id: string, passwordHash: string): Promise<void>;
  delete(id: string): Promise<boolean>;
  listLibraryPermissions(userId: string): Promise<string[]>;
  replaceLibraryPermissions(
    userId: string,
    libraryIds: string[],
  ): Promise<void>;
}

export function createUserRepository(
  database: DatabaseExecutor,
): UserRepository {
  return {
    async create(input) {
      const result = await database.query<UserRow>(
        `INSERT INTO native_users (
          id, normalized_username, display_name, password_hash,
          is_administrator, invite_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [
          input.id,
          input.normalizedUsername,
          input.displayName,
          input.passwordHash,
          input.isAdministrator,
          input.inviteId ?? null,
        ],
      );
      return mapUser(result.rows[0] as UserRow);
    },

    async findById(id) {
      const result = await database.query<UserRow>(
        "SELECT * FROM native_users WHERE id = $1",
        [id],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async findByNormalizedUsername(username) {
      const result = await database.query<UserRow>(
        "SELECT * FROM native_users WHERE normalized_username = $1",
        [username],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async countEligibleAdministrators() {
      const result = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM native_users
         WHERE is_administrator = true AND is_disabled = false`,
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    async recordSuccessfulLogin(id, at) {
      await database.query(
        `UPDATE native_users
         SET last_successful_login_at = $2, updated_at = $2
         WHERE id = $1`,
        [id, at],
      );
    },

    async list() {
      const result = await database.query<UserRow>(
        "SELECT * FROM native_users ORDER BY normalized_username",
      );
      return result.rows.map(mapUser);
    },

    async update(id, input) {
      // COALESCE per column so a partial update leaves untouched fields alone
      // without a read-modify-write that could race a concurrent change.
      const result = await database.query<UserRow>(
        `UPDATE native_users SET
           display_name = COALESCE($2, display_name),
           is_administrator = COALESCE($3, is_administrator),
           is_disabled = COALESCE($4, is_disabled),
           allow_playback = COALESCE($5, allow_playback),
           allow_downloads = COALESCE($6, allow_downloads),
           allow_all_libraries = COALESCE($7, allow_all_libraries),
           max_content_age = CASE WHEN $8::boolean THEN $9::integer
                                  ELSE max_content_age END,
           allow_unrated_content = COALESCE($10, allow_unrated_content),
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          input.displayName ?? null,
          input.isAdministrator ?? null,
          input.isDisabled ?? null,
          input.allowPlayback ?? null,
          input.allowDownloads ?? null,
          input.allowAllLibraries ?? null,
          input.maxContentAge !== undefined,
          input.maxContentAge ?? null,
          input.allowUnratedContent ?? null,
        ],
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async setPasswordHash(id, passwordHash) {
      await database.query(
        `UPDATE native_users
         SET password_hash = $2, password_changed_at = now(), updated_at = now()
         WHERE id = $1`,
        [id, passwordHash],
      );
    },

    async delete(id) {
      const result = await database.query(
        "DELETE FROM native_users WHERE id = $1",
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async listLibraryPermissions(userId) {
      const result = await database.query<{ library_id: string }>(
        "SELECT library_id FROM user_library_permissions WHERE user_id = $1",
        [userId],
      );
      return result.rows.map((row) => row.library_id);
    },

    async replaceLibraryPermissions(userId, libraryIds) {
      await database.query(
        "DELETE FROM user_library_permissions WHERE user_id = $1",
        [userId],
      );
      for (const libraryId of libraryIds) {
        await database.query(
          `INSERT INTO user_library_permissions (user_id, library_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [userId, libraryId],
        );
      }
    },
  };
}
