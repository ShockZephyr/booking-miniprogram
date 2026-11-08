const db = require("../config/db");

function mapServiceItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    imageUrl: row.image_url || '',
    effect: row.effect || '',
    priceFen: row.price_fen == null ? null : row.price_fen,
    durationMinutes: row.duration_minutes,
    status: row.status,
    sortOrder: row.sort_order
  };
}

async function listActive(client) {
  const { rows } = await db.query(
    "SELECT * FROM service_items WHERE status = 'active' ORDER BY sort_order ASC, name ASC, id ASC", [], client
  );
  return rows.map(mapServiceItem);
}

async function listInactive(client) {
  const { rows } = await db.query(
    "SELECT * FROM service_items WHERE status = 'inactive' AND purged_at IS NULL ORDER BY updated_at DESC, name ASC, id ASC", [], client
  );
  return rows.map(mapServiceItem);
}

async function listInactiveByIdsForUpdate(ids, client) {
  const { rows } = await db.query(
    "SELECT * FROM service_items WHERE id = ANY($1::uuid[]) AND status = 'inactive' AND purged_at IS NULL ORDER BY id FOR UPDATE",
    [ids], client
  );
  return rows.map(mapServiceItem);
}

async function listInactiveDueForPurge(cutoff, client) {
  const { rows } = await db.query(
    "SELECT * FROM service_items WHERE status='inactive' AND purged_at IS NULL AND updated_at <= $1 ORDER BY id FOR UPDATE",
    [cutoff], client
  );
  return rows.map(mapServiceItem);
}

async function maxActiveSortOrder(client) {
  const { rows } = await db.query(
    "SELECT COALESCE(MAX(sort_order), 0)::int AS value FROM service_items WHERE status = 'active'", [], client
  );
  return Number(rows[0] && rows[0].value || 0);
}

async function restore(id, sortOrder, client) {
  const { rows } = await db.query(
    "UPDATE service_items SET status='active', sort_order=$2, updated_at=now() WHERE id=$1 AND status='inactive' AND purged_at IS NULL RETURNING *",
    [id, sortOrder], client
  );
  return mapServiceItem(rows[0]);
}

async function purge(id, client) {
  // Deleted projects remain linked to therapists while recoverable so that a
  // restore brings the original specialties back. Once purged, the link can
  // never become valid again and must be removed as part of the same transaction.
  await db.query(
    "UPDATE therapists SET service_item_ids=array_remove(service_item_ids,$1::uuid) WHERE $1=ANY(service_item_ids)",
    [id], client
  );
  const { rows } = await db.query(
    `UPDATE service_items
     SET name='已永久删除项目-' || id::text,
         description='', image_url='', effect='', price_fen=NULL,
         purged_at=now(), updated_at=now()
     WHERE id=$1 AND status='inactive' AND purged_at IS NULL
     RETURNING *`,
    [id], client
  );
  return mapServiceItem(rows[0]);
}

async function findById(id, client) {
  const { rows } = await db.query("SELECT * FROM service_items WHERE id = $1", [id], client);
  return mapServiceItem(rows[0]);
}

module.exports = {
  mapServiceItem,
  listActive,
  listInactive,
  listInactiveByIdsForUpdate,
  listInactiveDueForPurge,
  maxActiveSortOrder,
  restore,
  purge,
  findById
};
