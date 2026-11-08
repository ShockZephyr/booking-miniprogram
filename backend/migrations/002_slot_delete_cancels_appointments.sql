ALTER TABLE appointments
  DROP CONSTRAINT IF EXISTS appointments_slot_id_fkey;

ALTER TABLE appointments
  ALTER COLUMN slot_id DROP NOT NULL;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_slot_id_fkey
  FOREIGN KEY (slot_id) REFERENCES appointment_slots(id) ON DELETE SET NULL;
