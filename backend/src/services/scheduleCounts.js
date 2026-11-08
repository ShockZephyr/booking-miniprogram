// Restored archives may predate weekly schedules. Identify their schema before
// querying it so a historical backup can still be rehearsed without migrating it.
async function scheduleCounts(client, { allowLegacy = false } = {}) {
  if (allowLegacy) {
    const { rows: [tables] } = await client.query("SELECT to_regclass('schedule_settings') AS settings");
    if (!tables.settings) {
      return (await client.query("SELECT count(*)::int AS slots FROM appointment_slots")).rows[0];
    }
  }
  const { rows: [counts] } = await client.query(`SELECT
    (SELECT days_visible FROM schedule_settings WHERE singleton) AS days_visible,
    (SELECT count(*)::int FROM weekly_schedules) AS weekly_schedules,
    (SELECT count(*)::int FROM schedule_days) AS frozen_schedule_days,
    (SELECT count(*)::int FROM appointment_revisions) AS appointment_revisions`);
  return counts;
}

module.exports = { scheduleCounts };
