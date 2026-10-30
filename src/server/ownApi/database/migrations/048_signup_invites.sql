-- Invite codes for creating your own account. A code is a secret handed to a
-- person, so only its keyed hash is kept; the code itself is shown once, to
-- the administrator who made it. A code may admit more than one person, and
-- stops admitting anyone when it is used up, expires or is revoked.
CREATE TABLE native_invites (
  id uuid PRIMARY KEY,
  code_hash bytea NOT NULL UNIQUE,
  -- Who the code is for, in the administrator's words. Never shown to the
  -- person redeeming it.
  label varchar(100),
  max_uses integer NOT NULL DEFAULT 1,
  use_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES native_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT native_invites_max_uses_range CHECK (max_uses BETWEEN 1 AND 100),
  CONSTRAINT native_invites_use_count_range
    CHECK (use_count >= 0 AND use_count <= max_uses)
);

-- Which invite admitted an account, so the people page can say how someone
-- came in. Null for every account an administrator created.
ALTER TABLE native_users
  ADD COLUMN invite_id uuid REFERENCES native_invites(id) ON DELETE SET NULL;
