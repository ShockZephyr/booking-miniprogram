-- Keep legacy date configurations until their next explicit weekly edit. Store
-- manual closures as intervals so removing/re-adding a template or changing its
-- precision cannot silently reopen them. No appointments or history are rewritten.
ALTER TABLE schedule_days
  ADD COLUMN fallback_step smallint CHECK (fallback_step IN (10,15,30)),
  ADD COLUMN fallback_min_duration integer,
  ADD COLUMN manual_closed_ranges jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(manual_closed_ranges) = 'array'),
  ADD CONSTRAINT schedule_day_fallback_valid CHECK (
    (fallback_step IS NULL AND fallback_min_duration IS NULL) OR
    (fallback_step IS NOT NULL AND fallback_min_duration IS NOT NULL
      AND fallback_min_duration > 0 AND fallback_min_duration % fallback_step = 0)
  );

UPDATE schedule_days d SET manual_closed_ranges = COALESCE((
  SELECT jsonb_agg(jsonb_build_object('startTime', cell,
    'endTime', to_char(cell::time + make_interval(mins => d.step), 'HH24:MI')) ORDER BY cell)
  FROM unnest(d.closed) cell
), '[]'::jsonb);
