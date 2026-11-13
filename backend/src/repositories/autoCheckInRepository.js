const db = require("../config/db");

async function windowForRun(client, now = null) {
  // Read the database clock AFTER acquiring the identity lock. The optional
  // clock is only injected by local tests; it is not exposed by an API.
  const { rows } = await db.query(`
    WITH clock AS (SELECT COALESCE($1::timestamptz, clock_timestamp()) AS instant)
    SELECT instant AS "executedAt",
      (instant AT TIME ZONE 'Asia/Shanghai')::date::text AS "runDate",
      ((instant AT TIME ZONE 'Asia/Shanghai')::date - 2)::text AS "cutoffDate",
      (instant AT TIME ZONE 'Asia/Shanghai')::time >= time '00:05' AS due
    FROM clock`, [now], client);
  return rows[0];
}

async function completed(runDate, client) {
  const { rowCount } = await db.query(
    "SELECT 1 FROM appointment_auto_check_in_runs WHERE run_date = $1", [runDate], client);
  return rowCount > 0;
}

async function candidates(cutoffDate, client) {
  const { rows } = await db.query(`
    SELECT id, status FROM appointments
    WHERE date <= $1::date AND status IN ('booked', 'no_show')
    ORDER BY date, start_time, created_at, id
    FOR UPDATE`, [cutoffDate], client);
  return rows;
}

async function conflicts(id, client) {
  // no_show does not participate in the overlap constraints. Old/imported
  // history can conflict when reactivated; preserve the constraints and skip it.
  const { rows } = await db.query(`
    SELECT EXISTS (
      SELECT 1 FROM appointments target JOIN appointments other
        ON other.id <> target.id AND other.date = target.date
        AND (other.user_id = target.user_id OR other.therapist_id = target.therapist_id)
        AND other.start_time < target.end_time AND other.end_time > target.start_time
      WHERE target.id = $1 AND other.status IN ('booked', 'checked_in')
    ) AS conflict`, [id], client);
  return rows[0].conflict;
}

async function checkIn(id, executedAt, client) {
  await db.query(`
    UPDATE appointments SET status = 'checked_in', checked_in_at = $2,
      no_show_at = NULL, version = version + 1, updated_at = $2
    WHERE id = $1 AND status IN ('booked', 'no_show')`, [id, executedAt], client);
}

async function complete(result, client) {
  await db.query(`
    INSERT INTO appointment_auto_check_in_runs
      (run_date, cutoff_date, executed_at, checked_in_count, conflict_count)
    VALUES ($1, $2, $3, $4, $5)`,
  [result.runDate, result.cutoffDate, result.executedAt, result.checkedIn, result.conflicts], client);
}

module.exports = { windowForRun, completed, candidates, conflicts, checkIn, complete };
