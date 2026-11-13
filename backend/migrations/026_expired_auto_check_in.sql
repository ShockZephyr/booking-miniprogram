-- A committed daily run prevents restarts/multiple workers from checking in
-- appointments an administrator has deliberately unchecked later that day.
CREATE TABLE appointment_auto_check_in_runs (
  run_date date PRIMARY KEY,
  cutoff_date date NOT NULL,
  executed_at timestamptz NOT NULL,
  checked_in_count integer NOT NULL CHECK (checked_in_count >= 0),
  conflict_count integer NOT NULL CHECK (conflict_count >= 0),
  CHECK (cutoff_date = run_date - 2)
);
