ALTER TABLE therapists ADD COLUMN binding_revision bigint NOT NULL DEFAULT 1;

-- All binding writers (login, profile edits, recycle and restore) share the
-- same revision, including a phone change between two unregistered numbers.
CREATE FUNCTION advance_therapist_binding_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.binding_revision := OLD.binding_revision + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER therapist_binding_revision_changed
BEFORE UPDATE ON therapists FOR EACH ROW
WHEN ((OLD.phone, OLD.user_id, OLD.status, OLD.purged_at)
  IS DISTINCT FROM (NEW.phone, NEW.user_id, NEW.status, NEW.purged_at))
EXECUTE FUNCTION advance_therapist_binding_revision();
