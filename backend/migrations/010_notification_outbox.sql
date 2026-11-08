ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS recipient_role text,
  ADD COLUMN IF NOT EXISTS template_id text,
  ADD COLUMN IF NOT EXISTS template_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS page text,
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS dedup_key text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE notifications
SET delivery_status = 'skipped',
    last_error = COALESCE(last_error, 'legacy_notification_without_template'),
    updated_at = now()
WHERE template_id IS NULL AND delivery_status = 'pending';

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_delivery_status_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sending', 'sent', 'failed', 'skipped'));

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_attempt_count_nonnegative;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_attempt_count_nonnegative
  CHECK (attempt_count >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_notifications_dedup_key
  ON notifications(dedup_key)
  WHERE dedup_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_delivery_due
  ON notifications(delivery_status, next_attempt_at, created_at)
  WHERE delivery_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
  ON notifications(recipient_user_id, created_at DESC);
