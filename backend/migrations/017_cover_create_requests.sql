-- A delayed retry must not recreate a cover that an administrator has since deleted.
CREATE TABLE cover_create_requests (
  admin_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creation_key text NOT NULL,
  cover_id uuid NOT NULL,
  image_url text NOT NULL,
  PRIMARY KEY (admin_user_id, creation_key)
);
