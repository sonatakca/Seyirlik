-- The invite code itself, so the people page can show it again after it was
-- made. Sealed with AES-256-GCM under a key derived from the secrets file, the
-- row id bound in as associated data; code_hash stays the lookup. Null for
-- codes made before this, whose text was never kept.
ALTER TABLE native_invites ADD COLUMN code_sealed bytea;
