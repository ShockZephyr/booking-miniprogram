-- Weekly scheduling starts with an empty booking ledger. A normal startup must
-- never discard appointments or silently reinterpret fixed slots.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM appointment_slots) OR EXISTS (SELECT 1 FROM appointments) THEN
    RAISE EXCEPTION 'Legacy booking data present. Prepare an empty database or complete the explicit local cutover before migration 015.';
  END IF;
END $$;

CREATE TABLE schedule_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  days_visible integer NOT NULL DEFAULT 7 CHECK (days_visible > 0)
);
INSERT INTO schedule_settings DEFAULT VALUES;

CREATE TABLE weekly_schedules (
  therapist_id uuid NOT NULL REFERENCES therapists(id),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  step smallint NOT NULL DEFAULT 30 CHECK (step IN (10,15,30)),
  min_duration integer NOT NULL DEFAULT 90 CHECK (min_duration > 0 AND min_duration % step = 0),
  ranges jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(ranges) = 'array'),
  service_item_ids uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (therapist_id, weekday)
);

CREATE TABLE schedule_days (
  therapist_id uuid NOT NULL REFERENCES therapists(id),
  date date NOT NULL,
  step smallint NOT NULL CHECK (step IN (10,15,30)),
  min_duration integer NOT NULL CHECK (min_duration > 0 AND min_duration % step = 0),
  ranges jsonb NOT NULL CHECK (jsonb_typeof(ranges) = 'array'),
  service_item_ids uuid[] NOT NULL,
  closed text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (therapist_id, date)
);

CREATE TRIGGER weekly_schedule_projects_active BEFORE INSERT OR UPDATE OF service_item_ids
  ON weekly_schedules FOR EACH ROW EXECUTE FUNCTION validate_slot_projects();
CREATE TRIGGER daily_schedule_projects_active BEFORE INSERT OR UPDATE OF service_item_ids
  ON schedule_days FOR EACH ROW EXECUTE FUNCTION validate_slot_projects();

DROP INDEX uniq_effective_appointment_per_slot;
ALTER TABLE appointments ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE appointments ADD CONSTRAINT no_overlapping_appointments_per_therapist
  EXCLUDE USING gist (
    therapist_id WITH =,
    tsrange(date + start_time, date + end_time, '[)') WITH &&
  ) WHERE (status IN ('booked', 'checked_in')) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX idx_appointments_day_therapist ON appointments(date,therapist_id);
CREATE TABLE appointment_revisions (
  id bigserial PRIMARY KEY,
  appointment_id uuid NOT NULL REFERENCES appointments(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  before_data jsonb NOT NULL,
  after_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointment_revisions_history ON appointment_revisions(appointment_id,id DESC);
