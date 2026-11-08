const db = require("../config/db");

const emptyWeek = () => ({ step: 30, minDuration: 90, ranges: [], serviceItemIds: [] });

async function settings(client) {
  const { rows } = await db.query("SELECT days_visible FROM schedule_settings WHERE singleton", [], client);
  return { daysVisible: rows[0].days_visible };
}

async function setSettings(days, client) {
  await db.query("UPDATE schedule_settings SET days_visible=$1 WHERE singleton", [days], client);
  return { daysVisible: days };
}

async function weekly(id, weekday, client) {
  const { rows } = await db.query(
    'SELECT step,min_duration AS "minDuration",ranges,service_item_ids AS "serviceItemIds" FROM weekly_schedules WHERE therapist_id=$1 AND weekday=$2',
    [id, weekday], client
  );
  return rows[0] || emptyWeek();
}

async function saveWeekly(id, weekday, rule, client) {
  await db.query(
    `INSERT INTO weekly_schedules(therapist_id,weekday,step,min_duration,ranges,service_item_ids)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::uuid[])
     ON CONFLICT(therapist_id,weekday) DO UPDATE SET step=EXCLUDED.step,min_duration=EXCLUDED.min_duration,
       ranges=EXCLUDED.ranges,service_item_ids=EXCLUDED.service_item_ids`,
    [id, weekday, rule.step, rule.minDuration, JSON.stringify(rule.ranges), rule.serviceItemIds], client
  );
}

async function activeTherapists(ids, client, lock = false) {
  const { rows } = await db.query(
    `SELECT t.id,t.name,t.bio,t.image_url AS "imageUrl",
       ARRAY(SELECT s.name FROM service_items s
         WHERE s.id=ANY(t.service_item_ids) AND s.status='active'
         ORDER BY s.sort_order,s.name,s.id) AS tags
     FROM therapists t
     WHERE t.status='active' AND ($1::uuid[] IS NULL OR t.id=ANY($1))
     ORDER BY ${lock ? 't.id FOR UPDATE OF t' : 't.sort_order,t.created_at,t.id'}`, [ids], client
  );
  return rows;
}

async function activeProjectIds(ids, client) {
  const { rows } = await db.query(
    "SELECT id FROM service_items WHERE id=ANY($1::uuid[]) AND status='active' ORDER BY id FOR SHARE",
    [ids], client
  );
  return rows.map(row => row.id);
}

async function filterProjects(client) {
  const { rows } = await db.query("SELECT id,name FROM service_items WHERE status='active' ORDER BY sort_order,name,id", [], client);
  return rows;
}

async function rulesForDate(ids, date, client) {
  const { rows } = await db.query(
    `SELECT t.id AS "therapistId", COALESCE(d.step,w.step,30)::int AS step,
       COALESCE(d.min_duration,w.min_duration,90) AS "minDuration", COALESCE(d.ranges,w.ranges,'[]') AS ranges,
       COALESCE(d.service_item_ids,w.service_item_ids,'{}') AS "serviceItemIds",
       COALESCE(d.closed,'{}') AS closed
     FROM unnest($1::uuid[]) t(id)
     LEFT JOIN schedule_days d ON d.therapist_id=t.id AND d.date=$2::date
     LEFT JOIN weekly_schedules w ON w.therapist_id=t.id AND w.weekday=EXTRACT(ISODOW FROM $2::date)`,
    [ids, date], client
  );
  return rows;
}

async function freeze(day, client) {
  await db.query(
    `INSERT INTO schedule_days(therapist_id,date,step,min_duration,ranges,service_item_ids,closed)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::uuid[],$7::text[]) ON CONFLICT DO NOTHING`,
    [day.therapistId, day.date, day.step, day.minDuration, JSON.stringify(day.ranges), day.serviceItemIds, day.closed], client
  );
}

async function updateDay(day, client) {
  await db.query(
    "UPDATE schedule_days SET service_item_ids=$3::uuid[],closed=$4::text[] WHERE therapist_id=$1 AND date=$2",
    [day.therapistId, day.date, day.serviceItemIds, day.closed], client
  );
}

async function busy(date, ids, userId, exclude, client, includeProject = false) {
  const { rows } = await db.query(
    `SELECT therapist_id AS "therapistId", (user_id = $3::uuid) AS own
       ${includeProject ? ',service_item_id AS "serviceItemId",(SELECT array_agg(ap.service_item_id) FROM appointment_service_items ap WHERE ap.appointment_id=appointments.id) AS "serviceItemIds"' : ''},
       to_char(start_time,'HH24:MI') AS "startTime",to_char(end_time,'HH24:MI') AS "endTime"
     FROM appointments WHERE date=$1 AND status IN ('booked','checked_in')
       AND (therapist_id=ANY($2::uuid[]) OR user_id=$3::uuid) AND ($4::uuid IS NULL OR id<>$4)
     ORDER BY start_time,end_time,id`, [date, ids, userId || null, exclude || null], client
  );
  return rows;
}

async function ownOriginal(id, therapistId, date, userId, client) {
  const { rows } = await db.query(
    `SELECT id FROM appointments WHERE id=$1 AND therapist_id=$2 AND date=$3 AND user_id=$4
      AND status IN ('booked','checked_in') AND (date+end_time) AT TIME ZONE 'Asia/Shanghai'>clock_timestamp()`,
    [id, therapistId, date, userId], client
  );
  return rows.length > 0;
}

async function staffAppointments(id, date, client) {
  const { rows } = await db.query(
    `SELECT a.id,a.status,(SELECT string_agg(ap.name_snapshot,'、' ORDER BY ap.position) FROM appointment_service_items ap WHERE ap.appointment_id=a.id) AS "serviceItemName",a.note,
       to_char(a.start_time,'HH24:MI') AS "startTime",to_char(a.end_time,'HH24:MI') AS "endTime",
       u.nickname AS "userNickname",u.phone AS "userPhone",mw.remark_name AS "whitelistRemarkName"
     FROM appointments a JOIN users u ON u.id=a.user_id LEFT JOIN member_whitelist mw ON mw.phone=u.phone
     WHERE a.therapist_id=$1 AND a.date=$2 AND a.status IN ('booked','checked_in','no_show')
     ORDER BY a.start_time,a.end_time,a.id`, [id, date], client
  );
  return rows;
}

async function removeProject(id, client) {
  await db.query("UPDATE weekly_schedules SET service_item_ids=array_remove(service_item_ids,$1::uuid) WHERE $1=ANY(service_item_ids)", [id], client);
  await db.query(`UPDATE schedule_days SET service_item_ids=array_remove(service_item_ids,$1::uuid)
    WHERE date >= (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date AND $1=ANY(service_item_ids)`, [id], client);
}

async function disableTherapist(id, client) {
  await db.query("UPDATE weekly_schedules SET ranges='[]' WHERE therapist_id=$1", [id], client);
  await db.query(`UPDATE schedule_days SET ranges='[]',closed='{}' WHERE therapist_id=$1
    AND date >= (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date`, [id], client);
}

module.exports = { settings, setSettings, weekly, saveWeekly, activeTherapists, activeProjectIds, filterProjects, rulesForDate,
  freeze, updateDay, busy, ownOriginal, staffAppointments, removeProject, disableTherapist };
