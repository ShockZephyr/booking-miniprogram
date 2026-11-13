const db = require("../config/db");
const { addCatalogFilter } = require("./appointmentRepository");

async function now(client) {
  const { rows } = await db.query("SELECT clock_timestamp() AS now", [], client);
  return rows[0].now;
}

async function candidates(filters, therapistId, checkedInAt, client) {
  const params = [checkedInAt];
  const where = ["a.status IN ('booked','no_show')",
    "(a.date + a.start_time) AT TIME ZONE 'Asia/Shanghai' - interval '1 hour' <= $1::timestamptz"];
  if (therapistId) {
    params.push(therapistId);
    where.push(`a.therapist_id = $${params.length}`);
  }
  addCatalogFilter(where, params, { ids: filters.serviceItemIds, includeInactive: filters.includeInactiveServiceItems,
    column: "a.service_item_id", table: "service_items", alias: "filter_si" });
  if (!therapistId) addCatalogFilter(where, params, { ids: filters.therapistIds, includeInactive: filters.includeInactiveTherapists,
    column: "a.therapist_id", table: "therapists", alias: "filter_t" });
  for (const [field, expression] of [["fromDate", "a.date >="], ["toDate", "a.date <="],
    ["startTime", "a.start_time >="], ["endTime", "a.end_time <="]]) {
    if (filters[field]) { params.push(filters[field]); where.push(`${expression} $${params.length}`); }
  }
  // No LIMIT/OFFSET: the operation covers all matching pages. The shared
  // identity lock is held before these row locks and all writes below.
  const { rows } = await db.query(`SELECT a.id, a.version FROM appointments a
    WHERE ${where.join(" AND ")} ORDER BY a.id FOR UPDATE OF a`, params, client);
  return rows;
}

module.exports = { now, candidates };
