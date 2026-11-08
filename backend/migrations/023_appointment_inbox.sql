-- In-app unread state only. Existing appointments remain read (version 0).
ALTER TABLE appointments ADD COLUMN inbox_version bigint NOT NULL DEFAULT 0;
ALTER TABLE appointments ADD COLUMN inbox_kind text CHECK (inbox_kind IN ('created','modified','cancelled'));

CREATE TABLE appointment_reads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version >= 0),
  PRIMARY KEY (user_id, appointment_id)
);

CREATE FUNCTION appointment_inbox_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('booked','checked_in','no_show') THEN
      NEW.inbox_version := 1;
      NEW.inbox_kind := 'created';
    END IF;
  ELSIF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.inbox_version := OLD.inbox_version + 1;
    NEW.inbox_kind := 'cancelled';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appointment_inbox_event BEFORE INSERT OR UPDATE ON appointments
FOR EACH ROW EXECUTE FUNCTION appointment_inbox_event();

-- A revision is written only for an effective customer edit, after the complete
-- project set has been saved. This includes non-first project and note changes.
CREATE FUNCTION appointment_inbox_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE appointments SET inbox_version = inbox_version + 1, inbox_kind = 'modified'
  WHERE id = NEW.appointment_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appointment_inbox_revision AFTER INSERT ON appointment_revisions
FOR EACH ROW EXECUTE FUNCTION appointment_inbox_revision();

-- Short-lived, identity-bound list positions. No copied customer details.
CREATE TABLE appointment_inbox_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  query_key text NOT NULL,
  summary jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '1 hour')
);
CREATE INDEX appointment_inbox_views_expiry ON appointment_inbox_views(expires_at);
CREATE TABLE appointment_inbox_view_items (
  view_id uuid NOT NULL REFERENCES appointment_inbox_views(id) ON DELETE CASCADE,
  position bigint NOT NULL,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  version bigint NOT NULL,
  kind text,
  PRIMARY KEY (view_id, position),
  UNIQUE (view_id, appointment_id)
);
