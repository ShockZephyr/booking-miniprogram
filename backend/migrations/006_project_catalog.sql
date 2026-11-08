ALTER TABLE service_items ADD COLUMN image_url text NOT NULL DEFAULT '';
ALTER TABLE service_items ADD COLUMN effect text NOT NULL DEFAULT '';
ALTER TABLE service_items ADD COLUMN price_fen integer CHECK (price_fen >= 0);
ALTER TABLE therapists ADD COLUMN service_item_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE therapists t SET service_item_ids = ARRAY(SELECT s.id FROM service_items s WHERE s.name = ANY(t.tags) AND s.status='active' ORDER BY s.sort_order,s.id);
ALTER TABLE appointments ADD COLUMN service_item_name text;
UPDATE appointments a SET service_item_name=s.name FROM service_items s WHERE s.id=a.service_item_id;
CREATE FUNCTION snapshot_appointment_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT name INTO NEW.service_item_name FROM service_items WHERE id=NEW.service_item_id;
  RETURN NEW;
END $$;
CREATE TRIGGER appointment_project_snapshot BEFORE INSERT ON appointments FOR EACH ROW EXECUTE FUNCTION snapshot_appointment_project();
-- A slot created concurrently with project removal must recheck at write time.
CREATE FUNCTION validate_slot_projects() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_id uuid;
BEGIN
  FOR project_id IN SELECT DISTINCT unnest(NEW.service_item_ids) ORDER BY 1 LOOP
    PERFORM id FROM service_items WHERE id=project_id AND status='active' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Project is inactive' USING ERRCODE='23514', CONSTRAINT='slot_project_active';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER slot_projects_active BEFORE INSERT OR UPDATE OF service_item_ids ON appointment_slots FOR EACH ROW EXECUTE FUNCTION validate_slot_projects();
