const { encodeCursor, decodeCursor } = require("../utils/cursor");
const db = require("../config/db");
const { formatShanghaiDateTime } = require("../utils/date");
const REVIEW_MEMBER = "EXISTS (SELECT 1 FROM users u WHERE u.phone = member_whitelist.phone AND u.review_identity = 'user')";

function mapWhitelist(row) {
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone,
    remarkName: row.remark_name,
    status: row.status,
    isReviewMember: row.review_member === true,
    createdBy: row.created_by,
    createdAt: formatShanghaiDateTime(row.created_at),
    updatedAt: formatShanghaiDateTime(row.updated_at)
  };
}

async function isActive(phone, client) {
  if (!phone) return false;
  const { rows } = await db.query(
    "SELECT 1 FROM member_whitelist WHERE phone = $1 AND status = 'active'",
    [phone],
    client
  );
  return rows.length > 0;
}

async function findByPhone(phone, client) {
  const { rows } = await db.query("SELECT * FROM member_whitelist WHERE phone = $1", [phone], client);
  return mapWhitelist(rows[0]);
}

async function findById(id, client) {
  const { rows } = await db.query(`SELECT *, ${REVIEW_MEMBER} AS review_member FROM member_whitelist WHERE id = $1 FOR UPDATE`, [id], client);
  return mapWhitelist(rows[0]);
}

async function listPage({ keyword = "", status = "active", cursor, includeInactiveReview = false } = {}) {
  const params = [];
  const where = [];
  if (keyword) {
    params.push(`%${keyword}%`);
    where.push(`(phone ILIKE $${params.length} OR remark_name ILIKE $${params.length})`);
  }
  if (status && status !== "all") {
    params.push(status);
    where.push(includeInactiveReview && status === "active"
      ? `(status = $${params.length} OR (status = 'inactive' AND ${REVIEW_MEMBER}))`
      : `status = $${params.length}`);
  }
  const position = decodeCursor(cursor, "whitelist");
  if (position) {
    const first = params.length + 1;
    params.push(...position);
    where.push(`(updated_at, id) < ($${first}::timestamptz, $${first+1}::uuid)`);
  }
  const { rows } = await db.query(`
    SELECT *, ${REVIEW_MEMBER} AS review_member, updated_at::text AS cursor_updated_at FROM member_whitelist
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updated_at DESC, id DESC LIMIT 201
  `, params);
  const visible = rows.slice(0,200);
  const last = visible.at(-1);
  return { items: visible.map(mapWhitelist), pagination: {
    hasMore: rows.length > 200,
    nextCursor: rows.length > 200 ? encodeCursor("whitelist", [last.cursor_updated_at, last.id]) : ""
  } };
}

async function list(filters = {}) {
  return (await listPage(filters)).items;
}

async function upsert({ phone, remarkName, createdBy }, client) {
  const { rows } = await db.query(
    `
      INSERT INTO member_whitelist (phone, remark_name, status, created_by)
      VALUES ($1, $2, 'active', $3)
      ON CONFLICT (phone)
      DO UPDATE SET remark_name = EXCLUDED.remark_name, status = 'active', updated_at = now()
      RETURNING *
    `,
    [phone, remarkName || null, createdBy || null],
    client
  );
  return mapWhitelist(rows[0]);
}

async function update(id, patch, client) {
  const { rows } = await db.query(
    `
      UPDATE member_whitelist
      SET phone = COALESCE($2, phone),
          remark_name = CASE WHEN $5::boolean THEN $3 ELSE remark_name END,
          status = COALESCE($4, status),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [id, patch.phone ?? null, patch.remarkName ?? null, patch.status ?? null,
      Object.hasOwn(patch, "remarkName") && patch.remarkName !== undefined],
    client
  );
  return mapWhitelist(rows[0]);
}

async function softDelete(id, client) {
  const { rows } = await db.query(
    "UPDATE member_whitelist SET status = 'inactive', updated_at = now() WHERE id = $1 RETURNING *",
    [id],
    client
  );
  return mapWhitelist(rows[0]);
}

async function batchSoftDelete(ids, client) {
  const { rows } = await db.query(
    "UPDATE member_whitelist SET status = 'inactive', updated_at = now() WHERE id = ANY($1::uuid[]) RETURNING *",
    [ids],
    client
  );
  return rows.map(mapWhitelist);
}

module.exports = {
  mapWhitelist,
  isActive,
  findByPhone,
  findById,
  list,
  listPage,
  upsert,
  update,
  softDelete,
  batchSoftDelete
};
