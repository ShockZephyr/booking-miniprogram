const projectFields = `ARRAY(SELECT s.name FROM service_items s WHERE s.id=ANY(t.service_item_ids) AND s.status='active' ORDER BY s.sort_order,s.name,s.id) AS current_tags,
  ARRAY(SELECT s.id FROM service_items s WHERE s.id=ANY(t.service_item_ids) AND s.status='active' ORDER BY s.sort_order,s.name,s.id) AS active_ids`;
const db = require("../config/db");

function map(row) {
  return row ? {
    id: row.id,
    name: row.name,
    bio: row.bio,
    tags: row.current_tags || [],
    serviceItemIds: row.active_ids || [],
    imageUrl: row.image_url,
    status: row.status,
    phone: row.phone || "",
    userId: row.user_id || null,
    linkedAt: row.linked_at || null,
    bindingVersion: row.binding_version,
    accountLinked: !!row.user_id,
    sortOrder: Number(row.sort_order || 0)
  } : null;
}

async function list(client) {
  const { rows } = await db.query(`SELECT t.*, ${projectFields} FROM therapists t WHERE status = 'active' ORDER BY sort_order, created_at, id`, [], client);
  return rows.map(map);
}

async function listDeleted(client) {
  const { rows } = await db.query(`SELECT t.*, ${projectFields} FROM therapists t WHERE status = 'deleted' AND purged_at IS NULL ORDER BY updated_at DESC, name, id`, [], client);
  return rows.map(map);
}

async function listDeletedByIdsForUpdate(ids, client) {
  const { rows } = await db.query(
    `SELECT t.*, ${projectFields} FROM therapists t WHERE t.id = ANY($1::uuid[]) AND status = 'deleted' AND purged_at IS NULL ORDER BY t.id FOR UPDATE OF t`,
    [ids], client
  );
  return rows.map(map);
}

async function listDeletedDueForPurge(cutoff, client) {
  const { rows } = await db.query(
    `SELECT t.*, ${projectFields} FROM therapists t
     WHERE status='deleted' AND purged_at IS NULL AND updated_at <= $1
     ORDER BY t.id FOR UPDATE OF t`,
    [cutoff], client
  );
  return rows.map(map);
}

async function maxActiveSortOrder(client) {
  const { rows } = await db.query(
    "SELECT COALESCE(MAX(sort_order), 0)::int AS value FROM therapists WHERE status='active'", [], client
  );
  return Number(rows[0] && rows[0].value || 0);
}

async function findById(id, client, lock = false) {
  const { rows } = await db.query(`SELECT t.*, t.id::text || ':' || t.binding_revision::text AS binding_version,
    ${projectFields} FROM therapists t WHERE id = $1${lock ? " FOR UPDATE OF t" : ""}`, [id], client);
  return map(rows[0]);
}

async function findActiveByPhone(phone, client, lock = false) {
  const { rows } = await db.query(
    `SELECT t.*, ${projectFields} FROM therapists t WHERE t.phone = $1 AND t.status = 'active'${lock ? " FOR UPDATE OF t" : ""}`,
    [phone], client
  );
  return map(rows[0]);
}

async function findActiveByUserId(userId, client, lock = false) {
  if (!userId) return null;
  const { rows } = await db.query(
    `SELECT t.*, ${projectFields} FROM therapists t WHERE t.user_id = $1 AND t.status = 'active' LIMIT 1${lock ? " FOR UPDATE OF t" : ""}`,
    [userId], client
  );
  return map(rows[0]);
}

async function recoverableServiceItemIds(id, client) {
  const { rows } = await db.query(
    `SELECT s.id FROM therapists t
     JOIN service_items s ON s.id = ANY(t.service_item_ids)
     WHERE t.id=$1 AND s.status='inactive' AND s.purged_at IS NULL
     ORDER BY s.id`,
    [id], client
  );
  return rows.map((row) => row.id);
}

async function save(id, input, client) {
  const values = [input.name, input.bio, input.serviceItemIds, input.imageUrl, input.phone, input.userId || null];
  const { rows } = id
    ? await db.query(
      `UPDATE therapists
       SET name=$1, bio=$2, service_item_ids=$3, tags='{}', image_url=$4,
           phone=$5, user_id=$6,
           linked_at=CASE WHEN $6::uuid IS NULL THEN NULL WHEN user_id IS DISTINCT FROM $6::uuid THEN now() ELSE linked_at END,
           updated_at=now()
       WHERE id=$7 RETURNING *`,
      [...values, id], client
    )
    : await db.query(
      `INSERT INTO therapists(name,bio,service_item_ids,image_url,phone,user_id,linked_at,sort_order)
       SELECT $1,$2,$3,$4,$5,$6,CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END,
              COALESCE(MAX(sort_order),0)+1 FROM therapists
       RETURNING *`,
      values, client
    );
  return findById(rows[0].id, client);
}

async function bindUser(id, userId, client) {
  const { rows } = await db.query(
    `UPDATE therapists
     SET user_id=$2, linked_at=CASE WHEN user_id IS DISTINCT FROM $2 THEN now() ELSE linked_at END, updated_at=now()
     WHERE id=$1 AND status='active' RETURNING id`,
    [id, userId], client
  );
  return rows[0] ? findById(rows[0].id, client) : null;
}

async function unbindUser(id, client) {
  const { rows } = await db.query(
    `UPDATE therapists SET user_id=NULL, linked_at=NULL, updated_at=now()
     WHERE id=$1 AND status='active' RETURNING id`,
    [id], client
  );
  return rows[0] ? findById(rows[0].id, client) : null;
}

async function restore(id, input, client) {
  const { rows } = await db.query(
    `UPDATE therapists
     SET status='active', sort_order=$2, user_id=$3,
         linked_at=CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END,
         updated_at=now()
     WHERE id=$1 AND status='deleted' AND purged_at IS NULL
     RETURNING id`,
    [id, input.sortOrder, input.userId || null], client
  );
  return rows[0] ? findById(rows[0].id, client) : null;
}

async function purge(id, client) {
  const { rows } = await db.query(
    `UPDATE therapists
     SET name='已永久删除芳疗师', bio='', tags='{}', service_item_ids='{}',
         image_url='', phone=NULL, user_id=NULL, linked_at=NULL,
         purged_at=now(), updated_at=now()
     WHERE id=$1 AND status='deleted' AND purged_at IS NULL
     RETURNING id`,
    [id], client
  );
  return rows[0] ? findById(rows[0].id, client) : null;
}

module.exports = {
  map, list, listDeleted, listDeletedByIdsForUpdate, listDeletedDueForPurge, maxActiveSortOrder,
  findById, findActiveByPhone, findActiveByUserId, recoverableServiceItemIds,
  save, bindUser, unbindUser, restore, purge
};
