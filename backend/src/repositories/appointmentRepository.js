const { appointmentOrder } = require("../utils/appointmentSort");
const { projectItems } = require("../utils/appointmentProjects");
const db = require("../config/db");
const { todayString, formatShanghaiDateTime } = require("../utils/date");

function formatTime(value) {
  return String(value || "").slice(0, 5);
}

function formatDate(value) {
  if (!value) return "";
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  return todayString(value);
}

function mapAppointment(row) {
  if (!row) return null;
  const serviceItems = row.service_items || [{ id: row.service_item_id, name: row.service_item_name, imageUrl: row.service_item_image_url || "" }];
  return {
    serviceItems, serviceItemIds: serviceItems.map(item => item.id),
    id: row.id,
    userId: row.user_id,
    serviceItemId: row.service_item_id,
    therapistId: row.therapist_id || null,
    therapistName: row.therapist_name || "待分配",
    serviceItemName: serviceItems.map(item => item.name).join("、"),
    date: formatDate(row.date),
    startTime: formatTime(row.start_time),
    endTime: formatTime(row.end_time),
    note: row.note,
    status: row.status,
    version: row.version,
    createdAt: formatShanghaiDateTime(row.created_at),
    updatedAt: formatShanghaiDateTime(row.updated_at),
    cancelledAt: formatShanghaiDateTime(row.cancelled_at),
    checkedInAt: formatShanghaiDateTime(row.checked_in_at),
    noShowAt: formatShanghaiDateTime(row.no_show_at),
    userNickname: row.user_nickname,
    userAvatarUrl: row.user_avatar_url,
    userPhone: row.user_phone,
    whitelistRemarkName: row.whitelist_remark_name
  };
}

const APPOINTMENT_SELECT = `
  SELECT a.*, a.created_at::text AS cursor_created_at, COALESCE(a.service_item_name, si.name) AS service_item_name,
         (SELECT jsonb_agg(jsonb_build_object('id',ap.service_item_id,'name',ap.name_snapshot,
           'imageUrl',COALESCE(p.image_url,'')) ORDER BY ap.position)
          FROM appointment_service_items ap JOIN service_items p ON p.id=ap.service_item_id
          WHERE ap.appointment_id=a.id) AS service_items,
         u.nickname AS user_nickname, u.avatar_url AS user_avatar_url, u.phone AS user_phone,
         mw.remark_name AS whitelist_remark_name
  FROM appointments a
  JOIN service_items si ON si.id = a.service_item_id
  JOIN users u ON u.id = a.user_id
  LEFT JOIN member_whitelist mw ON mw.phone = u.phone
`;

async function create(payload, client) {
  const { rows } = await db.query(
    `
      INSERT INTO appointments (
        user_id, service_item_id, date, start_time, end_time, note,
        therapist_id, therapist_name
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `,
    [
      payload.userId,
      payload.serviceItemId,
      payload.date,
      payload.startTime,
      payload.endTime,
      payload.note || null,
      payload.therapistId,
      payload.therapistName
    ],
    client
  );
  await replaceProjects(rows[0].id, payload, client);
  return findById(rows[0].id, client);
}

async function edit(id, patch, client) {
  const { rows } = await db.query(
    `UPDATE appointments SET start_time=$2, end_time=$3, service_item_id=$4,
       service_item_name=$5, note=$6, version=version+1, updated_at=clock_timestamp()
     WHERE id=$1 RETURNING *`,
    [id, patch.startTime, patch.endTime, patch.serviceItemId, patch.serviceItemName, patch.note || null], client
  );
  await replaceProjects(id, patch, client);
  return findById(id, client);
}

async function replaceProjects(id, value, client) {
  const items = projectItems(value);
  await db.query("DELETE FROM appointment_service_items WHERE appointment_id=$1", [id], client);
  for (const [position, item] of items.entries()) {
    await db.query(`INSERT INTO appointment_service_items(appointment_id,service_item_id,name_snapshot,position)
      VALUES($1,$2,$3,$4)`, [id,item.id,item.name,position], client);
  }
}

function revisionSnapshot({ serviceItems, version, date, startTime, endTime, therapistId, therapistName, serviceItemId, serviceItemName, note, status, checkedInAt }) {
  return { serviceItems: (serviceItems || []).map(({ id, name }) => ({ id, name })), version, date, startTime, endTime, therapistId, therapistName, serviceItemId, serviceItemName, note, status, checkedInAt };
}

async function recordRevision(original, edited, actorUserId, client) {
  await db.query(
    `INSERT INTO appointment_revisions(appointment_id,actor_user_id,before_data,after_data)
     VALUES($1,$2,$3,$4)`,
    [original.id, actorUserId, revisionSnapshot(original), revisionSnapshot(edited)], client
  );
}

async function listRevisions(id, client) {
  const { rows } = await db.query(
    `SELECT id, before_data, after_data, created_at FROM appointment_revisions
     WHERE appointment_id=$1 ORDER BY id DESC`, [id], client
  );
  return rows.map((row) => ({
    id: row.id, before: { ...row.before_data, serviceItemName: projectItems(row.before_data).map(item => item.name).join("、") }, after: row.after_data, createdAt: formatShanghaiDateTime(row.created_at)
  }));
}

async function findById(id, client, scope = {}, lock = false) {
  const params = [id];
  let where = "a.id = $1";
  if (Object.hasOwn(scope, "userId")) {
    params.push(scope.userId);
    where += " AND a.user_id = $2";
  } else if (Object.hasOwn(scope, "therapistId")) {
    params.push(scope.therapistId);
    where += " AND a.therapist_id = $2";
  }
  const { rows } = await db.query(`${APPOINTMENT_SELECT} WHERE ${where}${lock ? " FOR UPDATE OF a" : ""}`, params, client);
  return mapAppointment(rows[0]);
}

const findByIdForUpdate = (id, client, scope) => findById(id, client, scope, true);

async function listFutureEffectiveByUser(userId, client) {
  const { rows } = await db.query(
    `${APPOINTMENT_SELECT}
     WHERE a.user_id = $1
       AND a.status IN ('booked', 'checked_in')
       AND (a.date + a.start_time) AT TIME ZONE 'Asia/Shanghai' > clock_timestamp()
     ORDER BY a.date, a.start_time, a.id
     FOR UPDATE OF a`,
    [userId],
    client
  );
  return rows.map(mapAppointment);
}

function userStatusList(status) {
  if (status === "pending") return ["booked", "no_show"];
  if (status === "checked_in") return ["checked_in"];
  if (status === "cancelled") return ["cancelled"];
  return ["booked", "no_show", "checked_in", "cancelled"];
}

function adminStatusList(status) {
  if (status === "pending") return ["booked", "no_show"];
  if (status === "checked_in") return ["checked_in"];
  if (status === "cancelled") return ["cancelled"];
  return ["booked", "no_show", "checked_in", "cancelled"];
}

function normalizePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function normalizePageSize(value) {
  const pageSize = Number.parseInt(value, 10);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return 20;
  return Math.min(pageSize, 20);
}

function addCatalogFilter(where, params, { ids, includeInactive, column, table, alias }) {
  if (column === "a.service_item_id") {
    const checks = [];
    if (ids.length) { params.push(ids); checks.push(`ap.service_item_id = ANY($${params.length}::uuid[])`); }
    if (includeInactive) checks.push(`NOT EXISTS (SELECT 1 FROM service_items p WHERE p.id=ap.service_item_id AND p.status='active')`);
    if (checks.length) where.push(`EXISTS (SELECT 1 FROM appointment_service_items ap WHERE ap.appointment_id=a.id AND (${checks.join(" OR ")}))`);
    return;
  }
  const conditions = [];
  if (ids.length) {
    params.push(ids);
    conditions.push(`${column} = ANY($${params.length}::uuid[])`);
  }
  if (includeInactive) {
    conditions.push(`(${column} IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ${table} ${alias}
      WHERE ${alias}.id = ${column} AND ${alias}.status = 'active'
    ))`);
  }
  if (conditions.length) where.push(`(${conditions.join(" OR ")})`);
}

async function listByUser(userId, {
  status = "all", page = 1, pageSize = 20, cursor, sort,
  serviceItemIds = [], therapistIds = [], includeInactiveServiceItems = false,
  includeInactiveTherapists = false, fromDate, toDate, startTime, endTime
} = {}, client) {
  const order = appointmentOrder(sort, cursor);
  const statuses = userStatusList(status);
  const safePage = normalizePage(page);
  const safePageSize = normalizePageSize(pageSize);
  const offset = (safePage - 1) * safePageSize;
  const params = [userId, statuses];
  const where = ["a.user_id = $1", "a.status = ANY($2::appointment_status[])"];
  addCatalogFilter(where, params, {
    ids: serviceItemIds, includeInactive: includeInactiveServiceItems,
    column: "a.service_item_id", table: "service_items", alias: "filter_si"
  });
  addCatalogFilter(where, params, {
    ids: therapistIds, includeInactive: includeInactiveTherapists,
    column: "a.therapist_id", table: "therapists", alias: "filter_t"
  });
  if (fromDate) {
    params.push(fromDate);
    where.push(`a.date >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`a.date <= $${params.length}`);
  }
  if (startTime) {
    params.push(startTime);
    where.push(`a.start_time >= $${params.length}`);
  }
  if (endTime) {
    params.push(endTime);
    where.push(`a.end_time <= $${params.length}`);
  }
  let clause = where.join(" AND ");
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count FROM appointments a WHERE ${clause}`,
    params,
    client
  );
  const { position } = order;
  clause += order.after(params);
  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;
  const { rows } = await db.query(
    `
      ${APPOINTMENT_SELECT}
      WHERE ${clause}
      ORDER BY ${order.sql}
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `,
    [...params, safePageSize + (position ? 1 : 0), position ? 0 : offset],
    client
  );
  const total = countResult.rows[0] ? countResult.rows[0].count : 0;
  const visible = rows.slice(0, safePageSize);
  const last = visible.at(-1);
  const hasMore = position ? rows.length > safePageSize : offset + rows.length < total;
  const nextCursor = hasMore && last && last.cursor_created_at
    ? order.cursor([formatDate(last.date), String(last.start_time), last.cursor_created_at, last.id]) : "";
  return {
    appointments: visible.map(mapAppointment),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
      hasMore, nextCursor
    }
  };
}

async function listForStaff(owner, {
  status = "all", page = 1, pageSize = 20, cursor, sort, serviceItemIds = [], therapistIds = [],
  includeInactiveServiceItems = false, includeInactiveTherapists = false,
  fromDate, toDate, startTime, endTime
} = {}, client) {
  const order = appointmentOrder(sort, cursor);
  const statuses = adminStatusList(status);
  const safePage = normalizePage(page);
  const safePageSize = normalizePageSize(pageSize);
  const offset = (safePage - 1) * safePageSize;
  const params = [statuses];
  const where = ["a.status = ANY($1::appointment_status[])"];
  if (owner && owner.therapistId) {
    params.push(owner.therapistId);
    where.push(`a.therapist_id = $${params.length}`);
  }
  addCatalogFilter(where, params, {
    ids: serviceItemIds, includeInactive: includeInactiveServiceItems,
    column: "a.service_item_id", table: "service_items", alias: "filter_si"
  });
  if (!owner) {
    addCatalogFilter(where, params, {
      ids: therapistIds, includeInactive: includeInactiveTherapists,
      column: "a.therapist_id", table: "therapists", alias: "filter_t"
    });
  }
  if (fromDate) {
    params.push(fromDate);
    where.push(`a.date >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    where.push(`a.date <= $${params.length}`);
  }
  if (startTime) {
    params.push(startTime);
    where.push(`a.start_time >= $${params.length}`);
  }
  if (endTime) {
    params.push(endTime);
    where.push(`a.end_time <= $${params.length}`);
  }
  let clause = where.join(" AND ");
  const countResult = await db.query(
    `SELECT COUNT(*)::int AS count FROM appointments a WHERE ${clause}`,
    params,
    client
  );
  const { position } = order;
  clause += order.after(params);
  const limitIndex = params.length + 1;
  const offsetIndex = params.length + 2;
  const { rows } = await db.query(
    `
      ${APPOINTMENT_SELECT}
      WHERE ${clause}
      ORDER BY ${order.sql}
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `,
    [...params, safePageSize + (position ? 1 : 0), position ? 0 : offset],
    client
  );
  const total = countResult.rows[0] ? countResult.rows[0].count : 0;
  const visible = rows.slice(0, safePageSize);
  const last = visible.at(-1);
  const hasMore = position ? rows.length > safePageSize : offset + rows.length < total;
  const nextCursor = hasMore && last && last.cursor_created_at
    ? order.cursor([formatDate(last.date), String(last.start_time), last.cursor_created_at, last.id]) : "";
  return {
    appointments: visible.map(mapAppointment),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
      hasMore, nextCursor
    }
  };
}

async function listForAdmin(query = {}, client) {
  return listForStaff(null, query, client);
}

async function listForTherapist(therapistId, query = {}, client) {
  return listForStaff({ therapistId }, query, client);
}

function filterOptionScope(user) {
  if (user && user.role === "admin") return { clause: "TRUE", params: [], includeTherapists: true };
  if (user && user.therapistId) {
    return { clause: "a.therapist_id = $1", params: [user.therapistId], includeTherapists: false };
  }
  return { clause: "a.user_id = $1", params: [user.id], includeTherapists: true };
}

async function listFilterOptions(user, client) {
  const scope = filterOptionScope(user);
  const projectResult = await db.query(
    `WITH historical AS (
       SELECT DISTINCT ON (ap.service_item_id)
              ap.service_item_id AS id, ap.name_snapshot AS snapshot_name
       FROM appointments a JOIN appointment_service_items ap ON ap.appointment_id=a.id
       WHERE ${scope.clause}
       ORDER BY ap.service_item_id, a.created_at DESC
     )
     SELECT si.id, si.name, false AS inactive
     FROM service_items si
     WHERE si.status='active'
     UNION ALL
     SELECT h.id,
            CASE WHEN si.purged_at IS NULL THEN COALESCE(si.name,h.snapshot_name,'已停用项目')
                 ELSE COALESCE(h.snapshot_name,'已停用项目') END AS name,
            true AS inactive
     FROM historical h
     LEFT JOIN service_items si ON si.id=h.id
     WHERE si.id IS NULL OR si.status<>'active'
     ORDER BY inactive, name, id`,
    scope.params,
    client
  );

  let therapistRows = [];
  if (scope.includeTherapists) {
    const therapistResult = await db.query(
      `WITH historical AS (
         SELECT DISTINCT ON (a.therapist_id)
                a.therapist_id AS id, a.therapist_name AS snapshot_name
         FROM appointments a
         WHERE ${scope.clause} AND a.therapist_id IS NOT NULL
         ORDER BY a.therapist_id, a.created_at DESC
       )
       SELECT t.id, t.name, false AS inactive
       FROM therapists t
       WHERE t.status='active'
       UNION ALL
       SELECT h.id,
              CASE WHEN t.purged_at IS NULL THEN COALESCE(t.name,h.snapshot_name,'已停用芳疗师')
                   ELSE COALESCE(h.snapshot_name,'已停用芳疗师') END AS name,
              true AS inactive
       FROM historical h
       LEFT JOIN therapists t ON t.id=h.id
       WHERE t.id IS NULL OR t.status<>'active'
       ORDER BY inactive, name, id`,
      scope.params,
      client
    );
    therapistRows = therapistResult.rows;
  }

  const mapOption = (row) => ({ id: row.id, name: row.name, inactive: !!row.inactive });
  return {
    supportsInactiveFilters: true,
    serviceItems: projectResult.rows.map(mapOption),
    therapists: therapistRows.map(mapOption)
  };
}

async function countByTherapistGrouped(therapistId, client) {
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM appointments
     WHERE therapist_id=$1 AND status IN ('booked','no_show','checked_in','cancelled')
     GROUP BY status`,
    [therapistId], client
  );
  return rows.reduce((acc, row) => {
    acc[row.status] = row.count;
    acc.all = (acc.all || 0) + row.count;
    return acc;
  }, {});
}

async function countByUserGrouped(userId, client) {
  const { rows } = await db.query(
    `
      SELECT status, COUNT(*)::int AS count
      FROM appointments
      WHERE user_id = $1 AND status IN ('booked', 'no_show', 'checked_in', 'cancelled')
      GROUP BY status
    `,
    [userId], client
  );
  return rows.reduce((acc, row) => {
    acc[row.status] = row.count;
    acc.all = (acc.all || 0) + row.count;
    return acc;
  }, {});
}

async function calendarStatusByUser(userId, from, to, client) {
  const { rows } = await db.query(
    `
      SELECT date, status
      FROM appointments
      WHERE user_id = $1
        AND status IN ('booked', 'no_show', 'checked_in', 'cancelled')
        AND date BETWEEN $2 AND $3
    `,
    [userId, from, to], client
  );
  return rows.map((row) => ({
    date: formatDate(row.date),
    status: row.status
  }));
}

async function updateStatus(id, status, fields = {}, client) {
  const { rows } = await db.query(
    `
      UPDATE appointments
      SET status = $2::appointment_status,
          cancelled_at = CASE
            WHEN $2::appointment_status = 'cancelled' THEN COALESCE($3, cancelled_at, now())
            ELSE NULL
          END,
          checked_in_at = CASE
            WHEN $2::appointment_status = 'checked_in' THEN COALESCE($4, checked_in_at, now())
            ELSE NULL
          END,
          no_show_at = CASE
            WHEN $2::appointment_status = 'no_show' THEN COALESCE($5, no_show_at, now())
            ELSE NULL
          END,
          version = version + 1, updated_at = clock_timestamp()
      WHERE id = $1
      RETURNING *
    `,
    [
      id,
      status,
      fields.cancelledAt || null,
      fields.checkedInAt || null,
      fields.noShowAt || null
    ],
    client
  );
  if (rows[0] && status === 'cancelled' && fields.readByUserId) {
    await db.query(`INSERT INTO appointment_reads(user_id,appointment_id,version)
      SELECT $1,id,inbox_version FROM appointments WHERE id=$2
      ON CONFLICT(user_id,appointment_id) DO UPDATE SET version=GREATEST(appointment_reads.version,EXCLUDED.version)`,
    [fields.readByUserId, id], client);
  }
  return rows[0] ? findById(id, client) : null;
}

async function uncheckIn(id, status, fields = {}, client) {
  const { rows } = await db.query(
    `
      UPDATE appointments
      SET status = $2::appointment_status,
          cancelled_at = NULL,
          checked_in_at = NULL,
          no_show_at = $3,
          version = version + 1, updated_at = clock_timestamp()
      WHERE id = $1
      RETURNING *
    `,
    [id, status, fields.noShowAt || null],
    client
  );
  return rows[0] ? findById(id, client) : null;
}

async function markNoShows(client) {
  const { rowCount } = await db.query(
    `
      UPDATE appointments a
      SET status = 'no_show', no_show_at = statement_timestamp(), version = version + 1, updated_at = statement_timestamp()
      WHERE a.status = 'booked'
        AND (a.date + a.end_time) AT TIME ZONE 'Asia/Shanghai' <= statement_timestamp()
    `,
    [],
    client
  );
  return rowCount;
}

module.exports = {
  APPOINTMENT_SELECT,
  addCatalogFilter,
  normalizePage,
  normalizePageSize,
  mapAppointment,
  create,
  edit,
  recordRevision,
  listRevisions,
  findById,
  findByIdForUpdate,
  listFutureEffectiveByUser,
  listByUser,
  listForAdmin,
  listForTherapist,
  listFilterOptions,
  countByTherapistGrouped,
  countByUserGrouped,
  calendarStatusByUser,
  updateStatus,
  uncheckIn,
  markNoShows
};
