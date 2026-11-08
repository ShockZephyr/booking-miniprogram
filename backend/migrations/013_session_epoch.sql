-- A restored counter can collide with a token issued after the backup.
-- Rotate this random generation on restore, independently of session_version.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch uuid NOT NULL DEFAULT gen_random_uuid();
