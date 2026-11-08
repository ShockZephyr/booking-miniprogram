CREATE TABLE therapists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  bio text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  image_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE appointment_slots ADD COLUMN therapist_id uuid REFERENCES therapists(id);
ALTER TABLE appointments ADD COLUMN therapist_id uuid REFERENCES therapists(id);
ALTER TABLE appointments ADD COLUMN therapist_name text;

-- Old slots remain unassigned. Only an administrator may assign a real therapist.
DROP TRIGGER IF EXISTS trg_prevent_overlapping_appointment_slots ON appointment_slots;
DROP FUNCTION IF EXISTS prevent_overlapping_appointment_slots();
ALTER TABLE appointment_slots DROP CONSTRAINT IF EXISTS no_overlapping_slots_per_date;
ALTER TABLE appointment_slots DROP CONSTRAINT IF EXISTS uniq_appointment_slot;
ALTER TABLE appointment_slots ADD CONSTRAINT uniq_appointment_slot
  UNIQUE (therapist_id, date, start_time, end_time);
ALTER TABLE appointment_slots ADD CONSTRAINT no_overlapping_slots_per_therapist
  EXCLUDE USING gist (
    therapist_id WITH =,
    tsrange(date + start_time, date + end_time, '[)') WITH &&
  );
CREATE INDEX idx_slots_therapist ON appointment_slots(therapist_id);

-- Deferred so a replacement can be inserted before retiring its original.
ALTER TABLE appointments ADD CONSTRAINT no_overlapping_appointments_per_user
  EXCLUDE USING gist (
    user_id WITH =,
    tsrange(date + start_time, date + end_time, '[)') WITH &&
  ) WHERE (status IN ('booked', 'checked_in')) DEFERRABLE INITIALLY DEFERRED;
