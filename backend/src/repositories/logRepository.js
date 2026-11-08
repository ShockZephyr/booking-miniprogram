const db = require("../config/db");
const { formatShanghaiDateTime } = require("../utils/date");
const { parseLogQuery, SOURCES } = require("../utils/logQuery");
const { sanitizeLogPayload } = require("../utils/privacy");

function jsonParam(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function mapLogRow(row) {
  if (!row) return null;
  return {
    ...row,
    created_at: formatShanghaiDateTime(row.created_at),
    updated_at: formatShanghaiDateTime(row.updated_at)
  };
}

async function createBusiness(entry, client) {
  const { rows } = await db.query(
    `
      INSERT INTO business_logs (
        user_id, effective_role, action, resource_type, resource_id,
        result, request_id, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING *
    `,
    [
      entry.userId || null,
      entry.effectiveRole || null,
      entry.action,
      entry.resourceType || null,
      entry.resourceId || null,
      entry.result || "success",
      entry.requestId,
      jsonParam(entry.metadata)
    ],
    client
  );
  return mapLogRow(rows[0]);
}

async function createHttpRequest(entry) {
  if (!entry.path) return null;
  const { rows } = await db.query(
    `
      INSERT INTO http_request_logs (
        request_id, method, path, status_code, duration_ms,
        user_id, effective_role, ip, user_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `,
    [
      entry.requestId,
      entry.method,
      entry.route || entry.path,
      entry.statusCode,
      entry.durationMs,
      entry.userId || null,
      entry.effectiveRole || null,
      entry.ip || null,
      entry.userAgent || null
    ]
  );
  return mapLogRow(rows[0]);
}

async function createClientError(entry) {
  const { rows } = await db.query(
    `
      INSERT INTO client_errors (
        user_id, effective_role, page, message, stack,
        app_version, system_info, request_id, source_request_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
      RETURNING *
    `,
    [
      entry.userId || null,
      entry.effectiveRole || null,
      entry.page || null,
      entry.message,
      entry.stack || null,
      entry.appVersion || null,
      jsonParam(entry.systemInfo),
      entry.requestId || null,
      entry.sourceRequestId || null
    ]
  );
  return mapLogRow(rows[0]);
}

async function queryLogs(filters = {}) {
  const page = await queryLogPage(filters);
  return page.logs;
}

async function queryLogPage(input = {}) {
  const filters = parseLogQuery(input);
  const params = [];
  const where = [];
  if (filters.requestId) {
    params.push(filters.requestId);
    where.push(`(request_id = $${params.length} OR source_request_id = $${params.length})`);
  }
  if (filters.userId) {
    params.push(filters.userId);
    where.push(`user_id = $${params.length}`);
  }
  if (filters.effectiveRole) {
    params.push(filters.effectiveRole);
    where.push(`effective_role = $${params.length}`);
  }
  if (filters.action) {
    params.push(filters.action);
    where.push(`action = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`created_at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`created_at ${filters.toExclusive ? "<" : "<="} $${params.length}::timestamptz`);
  }
  if (filters.cursor) {
    params.push(...filters.cursor);
    where.push(`(created_at, source, id) < ($${params.length - 2}::timestamptz, $${params.length - 1}::text, $${params.length}::uuid)`);
  }
  const selects = {
    business: `SELECT 'business'::text AS source, id, created_at, request_id, user_id, effective_role,
      action, resource_type, resource_id, result, metadata, NULL::int AS status_code, NULL::text AS route,
      NULL::text AS source_request_id FROM business_logs`,
    audit: `SELECT 'audit', id, created_at, request_id, admin_user_id, 'admin', action, resource_type,
      resource_id, 'success', jsonb_build_object('before', before, 'after', after, 'targetUserId', target_user_id),
      NULL::int, NULL::text, NULL::text FROM audit_logs`,
    http: `SELECT 'http', id, created_at, request_id, user_id, effective_role, method, 'http', NULL::text,
      CASE WHEN status_code >= 400 THEN 'error' ELSE 'success' END,
      jsonb_build_object('durationMs', duration_ms, 'ip', ip, 'userAgent', user_agent), status_code, path,
      NULL::text FROM http_request_logs`,
    client: `SELECT 'client', id, created_at, request_id, user_id, effective_role, 'client_error', 'page', NULL::text,
      'error', jsonb_build_object('message', message, 'stack', stack, 'appVersion', app_version, 'systemInfo', system_info),
      NULL::int, page, source_request_id FROM client_errors`,
    alert: `SELECT 'alert', id, created_at, NULL::text, NULL::uuid, 'system', type, 'alert', NULL::text,
      level, jsonb_build_object('message', message, 'details', metadata, 'resolved', resolved),
      NULL::int, NULL::text, NULL::text FROM alerts`
  };
  const sources = !filters.source || filters.source === "all" ? SOURCES : [filters.source];
  // The source names and SQL fragments are server-owned. All supplied filter
  // values, including the cursor, remain bound parameters.
  const union = sources.map(source => selects[source]).join(" UNION ALL ");
  params.push(filters.limit + 1);
  const { rows } = await db.query(
    `
      SELECT *, created_at::text AS cursor_time FROM (${union}) AS logs
        (source, id, created_at, request_id, user_id, effective_role, action,
         resource_type, resource_id, result, metadata, status_code, route, source_request_id)
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, source DESC, id DESC
      LIMIT $${params.length}
    `,
    params
  );
  const hasMore = rows.length > filters.limit;
  const selected = rows.slice(0, filters.limit);
  const last = selected.at(-1);
  return {
    logs: selected.map(({ cursor_time, ...row }) => sanitizeLogPayload(mapLogRow(row))),
    hasMore,
    nextCursor: hasMore ? Buffer.from(JSON.stringify([last.cursor_time, last.source, last.id])).toString("base64url") : null
  };
}

async function recentErrors(limit = 20) {
  const { rows } = await db.query(
    `
      SELECT *
      FROM http_request_logs
      WHERE status_code >= 500
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit]
  );
  return rows.map(mapLogRow);
}

async function recentClientErrors(limit = 20) {
  const { rows } = await db.query(
    "SELECT * FROM client_errors ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return rows.map(mapLogRow);
}

module.exports = {
  createBusiness,
  createHttpRequest,
  createClientError,
  queryLogs,
  queryLogPage,
  recentErrors,
  recentClientErrors
};
