ALTER TABLE service_items
  ADD COLUMN IF NOT EXISTS purged_at timestamptz;

ALTER TABLE therapists
  ADD COLUMN IF NOT EXISTS purged_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_service_items_recycle_due
  ON service_items(updated_at, id)
  WHERE status = 'inactive' AND purged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_therapists_recycle_due
  ON therapists(updated_at, id)
  WHERE status = 'deleted' AND purged_at IS NULL;
