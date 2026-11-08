const db = require("../config/db");

async function list(client) {
  return (await db.query('SELECT id, image_url AS "imageUrl" FROM home_covers ORDER BY position', [], client)).rows;
}

async function insert(imageUrl, position, client) {
  return (await db.query('INSERT INTO home_covers(image_url, position) VALUES ($1,$2) RETURNING id',
    [imageUrl, position], client)).rows[0].id;
}

async function creation(adminId, key, client) {
  return (await db.query('SELECT cover_id AS id, image_url AS "imageUrl" FROM cover_create_requests WHERE admin_user_id=$1 AND creation_key=$2',
    [adminId, key], client)).rows[0];
}

async function rememberCreation(adminId, key, item, client) {
  await db.query("INSERT INTO cover_create_requests(admin_user_id, creation_key, cover_id, image_url) VALUES ($1,$2,$3,$4)",
    [adminId, key, item.id, item.imageUrl], client);
}

async function replace(id, imageUrl, client) {
  await db.query("UPDATE home_covers SET image_url=$2 WHERE id=$1", [id, imageUrl], client);
}

async function remove(id, client) {
  const { rows } = await db.query("DELETE FROM home_covers WHERE id=$1 RETURNING position", [id], client);
  await db.query("UPDATE home_covers SET position=position-1 WHERE position>$1", [rows[0].position], client);
}

async function reorder(ids, client) {
  await db.query("UPDATE home_covers c SET position=o.rank::smallint FROM unnest($1::uuid[]) WITH ORDINALITY o(id,rank) WHERE c.id=o.id",
    [ids], client);
}

module.exports = { list, insert, creation, rememberCreation, replace, remove, reorder };
