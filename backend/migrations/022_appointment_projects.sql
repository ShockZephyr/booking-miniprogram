-- One appointment retains one interval; its projects have independent name snapshots.
CREATE TABLE appointment_service_items (
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_item_id uuid NOT NULL REFERENCES service_items(id),
  name_snapshot text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (appointment_id, service_item_id),
  UNIQUE (appointment_id, position)
);
CREATE INDEX appointment_service_items_project_idx ON appointment_service_items(service_item_id, appointment_id);
INSERT INTO appointment_service_items(appointment_id,service_item_id,name_snapshot,position)
SELECT a.id,a.service_item_id,COALESCE(a.service_item_name,s.name),0
FROM appointments a JOIN service_items s ON s.id=a.service_item_id;

-- Keep legacy inserts (including fixtures) readable during a coordinated rollout.
CREATE FUNCTION initialize_appointment_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO appointment_service_items(appointment_id,service_item_id,name_snapshot,position)
  SELECT NEW.id,NEW.service_item_id,COALESCE(NEW.service_item_name,s.name),0
  FROM service_items s WHERE s.id=NEW.service_item_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appointment_project_initial AFTER INSERT ON appointments
FOR EACH ROW EXECUTE FUNCTION initialize_appointment_project();
