ALTER TABLE therapists
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS linked_at timestamptz;

ALTER TABLE therapists
  DROP CONSTRAINT IF EXISTS therapists_phone_format;

ALTER TABLE therapists
  ADD CONSTRAINT therapists_phone_format
  CHECK (phone IS NULL OR phone ~ '^1[3-9][0-9]{9}$');

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_therapist_phone
  ON therapists(phone)
  WHERE status = 'active' AND phone IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_therapist_user
  ON therapists(user_id)
  WHERE status = 'active' AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_therapists_user_id ON therapists(user_id);
