const db = require("../config/db");

function jsonParam(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

async function create(entry, client) {
  const { rows } = await db.query(
    `
      INSERT INTO audit_logs (
        admin_user_id, action, resource_type, resource_id, target_user_id,
        before, after, request_id, ip
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
      RETURNING *
    `,
    [
      entry.adminUserId,
      entry.action,
      entry.resourceType,
      entry.resourceId || null,
      entry.targetUserId || null,
      jsonParam(entry.before),
      jsonParam(entry.after),
      entry.requestId,
      entry.ip || null
    ],
    client
  );
  return rows[0];
}

async function recent(limit = 20) {
  const { rows } = await db.query(
    `
      SELECT a.*, u.nickname AS admin_nickname
      FROM audit_logs a
      JOIN users u ON u.id = a.admin_user_id
      ORDER BY a.created_at DESC
      LIMIT $1
    `,
    [limit]
  );
  return rows;
}

module.exports = {
  create,
  recent
};
