CREATE TABLE home_covers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_url text NOT NULL CHECK (image_url <> ''),
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 5),
  UNIQUE (position) DEFERRABLE INITIALLY DEFERRED
);
