const db = require("../config/db");
const { formatShanghaiDateTime } = require("../utils/date");

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    openid: row.openid,
    phone: row.phone,
    nickname: row.nickname,
    avatarUrl: row.avatar_url,
    role: row.role,
    reviewIdentity: row.review_identity || null,
    sessionVersion: Number(row.session_version || 0),
    sessionEpoch: row.session_epoch || null,
    createdAt: formatShanghaiDateTime(row.created_at),
    updatedAt: formatShanghaiDateTime(row.updated_at)
  };
}

async function findById(id, client, lock = false) {
  const { rows } = await db.query(`SELECT * FROM users WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id], client);
  return mapUser(rows[0]);
}

async function findByOpenid(openid, client, lock = false) {
  const { rows } = await db.query(`SELECT * FROM users WHERE openid = $1${lock ? " FOR UPDATE" : ""}`, [openid], client);
  return mapUser(rows[0]);
}

async function findByPhone(phone, client, lock = false) {
  const { rows } = await db.query(`SELECT * FROM users WHERE phone = $1${lock ? " FOR UPDATE" : ""}`, [phone], client);
  return mapUser(rows[0]);
}

async function createFromWechat(profile, client) {
  const { openid, phone, nickname, avatarUrl } = profile;
  const { rows } = await db.query(
    `
      INSERT INTO users (openid, phone, nickname, avatar_url)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    [openid, phone, nickname || null, avatarUrl || null],
    client
  );
  return mapUser(rows[0]);
}

async function updateWechatAccount(id, profile, options = {}, client) {
  const { openid, phone, nickname, avatarUrl } = profile;
  const replaceOpenid = options.replaceOpenid === true;
  const bumpSessionVersion = options.bumpSessionVersion === true;
  const { rows } = await db.query(
    `
      UPDATE users
      SET openid = CASE WHEN $6::boolean THEN $2 ELSE openid END,
          phone = $3,
          nickname = COALESCE($4, nickname),
          avatar_url = COALESCE($5, avatar_url),
          session_version = session_version + CASE WHEN $7::boolean THEN 1 ELSE 0 END,
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [id, openid, phone, nickname || null, avatarUrl || null, replaceOpenid, bumpSessionVersion],
    client
  );
  return mapUser(rows[0]);
}

async function incrementSessionVersion(id, client) {
  const { rows } = await db.query(
    "UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1 RETURNING *",
    [id],
    client
  );
  return mapUser(rows[0]);
}

async function setRoleByPhone(phone, role, client) {
  const { rows } = await db.query(
    `UPDATE users
     SET session_version = session_version + CASE WHEN role IS DISTINCT FROM $2::user_role THEN 1 ELSE 0 END,
         role = $2,
         updated_at = now()
     WHERE phone = $1
     RETURNING *`,
    [phone, role],
    client
  );
  return mapUser(rows[0]);
}

async function listActiveSince(since) {
  const { rows } = await db.query(
    `
      SELECT DISTINCT u.*
      FROM users u
      JOIN http_request_logs h ON h.user_id = u.id
      WHERE h.created_at >= $1
      ORDER BY u.updated_at DESC
      LIMIT 20
    `,
    [since]
  );
  return rows.map(mapUser);
}

module.exports = {
  mapUser,
  findById,
  findByOpenid,
  findByPhone,
  createFromWechat,
  updateWechatAccount,
  incrementSessionVersion,
  setRoleByPhone,
  listActiveSince
};
