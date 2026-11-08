ALTER TABLE appointment_slots ADD COLUMN IF NOT EXISTS service_item_ids uuid[];
UPDATE appointment_slots
SET service_item_ids = ARRAY(SELECT id FROM service_items WHERE status = 'active')
WHERE service_item_ids IS NULL;
ALTER TABLE appointment_slots ALTER COLUMN service_item_ids SET NOT NULL;
