CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION prevent_overlapping_appointment_slots()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM appointment_slots existing
    WHERE existing.id <> NEW.id
      AND existing.date = NEW.date
      AND existing.start_time < NEW.end_time
      AND existing.end_time > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'appointment slot overlaps existing slot'
      USING ERRCODE = '23P01',
            CONSTRAINT = 'no_overlapping_slots_per_date';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_overlapping_appointment_slots ON appointment_slots;

CREATE TRIGGER trg_prevent_overlapping_appointment_slots
  BEFORE INSERT OR UPDATE OF date, start_time, end_time
  ON appointment_slots
  FOR EACH ROW
  EXECUTE FUNCTION prevent_overlapping_appointment_slots();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'no_overlapping_slots_per_date'
  ) AND NOT EXISTS (
    SELECT 1
    FROM appointment_slots a
    JOIN appointment_slots b
      ON a.id < b.id
     AND a.date = b.date
     AND a.start_time < b.end_time
     AND a.end_time > b.start_time
  ) THEN
    ALTER TABLE appointment_slots
      ADD CONSTRAINT no_overlapping_slots_per_date
      EXCLUDE USING gist (
        date WITH =,
        tsrange(date + start_time, date + end_time, '[)') WITH &&
      );
  END IF;
END $$;
