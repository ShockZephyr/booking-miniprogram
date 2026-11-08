const db = require('../config/db');
const appointments = require('./appointmentRepository');
const { appointmentOrder } = require('../utils/appointmentSort');
const { summaryFromRows, queryKey, scopeKey, encodePosition, decodePosition } = require('../utils/appointmentInbox');
const { AppError } = require('../utils/errors');

const UNREAD = 'a.inbox_version > COALESCE(ar.version,0) AND a.inbox_kind IS NOT NULL';
const READ_JOIN = 'LEFT JOIN appointment_reads ar ON ar.appointment_id=a.id AND ar.user_id=$1';
function conditions(actor, filters, { status = true } = {}) {
  const params = [actor.id];
  const where = ["a.status IN ('booked','no_show','checked_in','cancelled')"];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (actor.role !== 'admin') add('a.therapist_id=?', actor.therapistId);
  if (status && filters.status !== 'all') add('a.status = ANY(?::appointment_status[])',
    filters.status === 'pending' ? ['booked','no_show'] : [filters.status]);
  appointments.addCatalogFilter(where, params, { ids: filters.serviceItemIds || [],
    includeInactive: filters.includeInactiveServiceItems, column: 'a.service_item_id', table: 'service_items', alias: 'filter_si' });
  if (actor.role === 'admin') appointments.addCatalogFilter(where, params, { ids: filters.therapistIds || [],
    includeInactive: filters.includeInactiveTherapists, column: 'a.therapist_id', table: 'therapists', alias: 'filter_t' });
  if (filters.fromDate) add('a.date >= ?', filters.fromDate);
  if (filters.toDate) add('a.date <= ?', filters.toDate);
  if (filters.startTime) add('a.start_time >= ?', filters.startTime);
  if (filters.endTime) add('a.end_time <= ?', filters.endTime);
  return { params, where: where.join(' AND ') };
}
async function summary(actor, filters, client) {
  const { params, where } = conditions(actor, filters, { status: false });
  const { rows } = await db.query(`SELECT a.status, a.inbox_kind AS kind, COUNT(*)::int AS count
    FROM appointments a ${READ_JOIN} WHERE ${where} AND ${UNREAD}
    GROUP BY a.status,a.inbox_kind`, params, client);
  return summaryFromRows(rows);
}

async function list(actor, filters, client) {
  const position = decodePosition(filters.cursor);
  const key = queryKey(filters), scope = scopeKey(actor);
  let view;
  if (position) {
    const result = await db.query(`SELECT * FROM appointment_inbox_views
      WHERE id=$1 AND user_id=$2 AND scope_key=$3 AND query_key=$4 AND expires_at>clock_timestamp()`,
    [position.viewId, actor.id, scope, key], client);
    view = result.rows[0];
    if (!view) throw new AppError('INBOX_VIEW_EXPIRED', '列表已更新，请刷新后继续查看', 409);
  } else {
    // Bounded maintenance of ephemeral lists only; never deletes business data.
    await db.query(`DELETE FROM appointment_inbox_views WHERE id IN
      (SELECT id FROM appointment_inbox_views WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100)`, [], client);
    const counts = await summary(actor, filters, client);
    const result = await db.query(`INSERT INTO appointment_inbox_views(user_id,scope_key,query_key,summary)
      VALUES($1,$2,$3,$4) RETURNING *`, [actor.id, scope, key, counts], client);
    view = result.rows[0];
    const { params, where } = conditions(actor, filters);
    params.push(view.id);
    const order = appointmentOrder(filters.sort);
    await db.query(`INSERT INTO appointment_inbox_view_items(view_id,position,appointment_id,version,kind,appointment_version)
      SELECT $${params.length},row_number() OVER (ORDER BY (${UNREAD}) DESC,${order.sql}),
        a.id,a.inbox_version,CASE WHEN ${UNREAD} THEN a.inbox_kind ELSE NULL END,a.version
      FROM appointments a ${READ_JOIN} WHERE ${where}`, params, client);
  }
  // Reads and new insertions do not move this browsing snapshot. A changed
  // existing record must start a new list instead of mixing old markers/order
  // with live content. Keep the snapshot for exact-version late read receipts.
  const effective = conditions(actor, filters);
  effective.params.push(view.id);
  const changed = await db.query(`SELECT 1 FROM appointment_inbox_view_items iv
    JOIN appointments a ON a.id=iv.appointment_id ${READ_JOIN}
    WHERE iv.view_id=$${effective.params.length} AND (
      iv.appointment_version IS DISTINCT FROM a.version OR iv.version<>a.inbox_version
      OR NOT COALESCE((${effective.where}),false)) LIMIT 1`, effective.params, client);
  if (changed.rows.length) throw new AppError('INBOX_VIEW_EXPIRED', '列表已更新，请刷新后继续查看', 409);
  const pageSize = appointments.normalizePageSize(filters.pageSize);
  const page = appointments.normalizePage(filters.page);
  const offset = position ? position.position : (page - 1) * pageSize;
  const params = [view.id, offset, pageSize + 1];
  // Identity lock keeps the validated business versions stable for this read.
  // Snapshot freezes positions, never authorization.
  const scopeSql = actor.role === 'admin' ? '' : ' AND a.therapist_id=$4';
  if (actor.role !== 'admin') params.push(actor.therapistId);
  const result = await db.query(`${appointments.APPOINTMENT_SELECT}
    JOIN appointment_inbox_view_items iv ON iv.appointment_id=a.id
    WHERE iv.view_id=$1 AND iv.position>$2${scopeSql}
    ORDER BY iv.position LIMIT $3`, params, client);
  // Fetch positions separately to avoid changing the shared public DTO SELECT.
  const meta = await db.query('SELECT appointment_id,position,version,kind FROM appointment_inbox_view_items WHERE view_id=$1 AND appointment_id=ANY($2::uuid[])',
    [view.id, result.rows.map(row => row.id)], client);
  const metadata = new Map(meta.rows.map(row => [row.appointment_id, row]));
  const visible = result.rows.slice(0, pageSize);
  const last = visible.at(-1);
  const hasMore = result.rows.length > pageSize;
  const count = await db.query('SELECT count(*)::int AS total FROM appointment_inbox_view_items WHERE view_id=$1', [view.id], client);
  return {
    appointments: visible.map(row => ({ ...appointments.mapAppointment(row), unreadKind: metadata.get(row.id).kind || '',
      unreadVersion: String(metadata.get(row.id).version) })),
    unread: view.summary, inboxViewId: view.id,
    pagination: { page, pageSize, total: count.rows[0].total, hasMore,
      nextCursor: hasMore && last ? encodePosition(view.id, Number(metadata.get(last.id).position)) : '' }
  };
}

async function acknowledge(actor, viewId, entries, client) {
  const ids = entries.map(item => item.id), versions = entries.map(item => item.version);
  const result = await db.query(`INSERT INTO appointment_reads(user_id,appointment_id,version)
    SELECT $1,a.id,iv.version FROM appointment_inbox_views v
    JOIN appointment_inbox_view_items iv ON iv.view_id=v.id
    JOIN appointments a ON a.id=iv.appointment_id
    JOIN unnest($4::uuid[],$5::bigint[]) AS seen(id,version) ON seen.id=a.id AND seen.version=iv.version
    WHERE v.id=$2 AND v.user_id=$1 AND v.scope_key=$3 AND v.expires_at>clock_timestamp()
      AND iv.kind IS NOT NULL AND ($6::boolean OR a.therapist_id=$7::uuid)
    ON CONFLICT(user_id,appointment_id) DO UPDATE SET version=GREATEST(appointment_reads.version,EXCLUDED.version)
    RETURNING appointment_id`, [actor.id, viewId, scopeKey(actor), ids, versions, actor.role === 'admin', actor.therapistId || null], client);
  return { acknowledged: result.rows.map(row => row.appointment_id) };
}

module.exports = { summary, list, acknowledge };
