CREATE TABLE IF NOT EXISTS image_cleanup_candidates (
  image_url text PRIMARY KEY,
  first_seen_orphan_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_image_cleanup_candidates_seen
  ON image_cleanup_candidates(first_seen_orphan_at);
