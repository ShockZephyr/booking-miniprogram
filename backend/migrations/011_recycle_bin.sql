ALTER TABLE therapists ADD COLUMN IF NOT EXISTS sort_order integer;

WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id)::integer AS position
  FROM therapists
)
UPDATE therapists t
SET sort_order = ranked.position
FROM ranked
WHERE t.id = ranked.id AND t.sort_order IS NULL;

ALTER TABLE therapists ALTER COLUMN sort_order SET DEFAULT 0;
ALTER TABLE therapists ALTER COLUMN sort_order SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_therapists_status_sort_order
  ON therapists(status, sort_order, id);
