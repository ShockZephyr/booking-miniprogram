async function list(client, { allowLegacy = false } = {}) {
  // Backup and image migration may run before the application applies migration 016.
  const includeCovers = !allowLegacy || (await client.query("SELECT to_regclass('home_covers') IS NOT NULL AS present")).rows[0].present;
  return (await client.query(`
    SELECT image_url FROM therapists WHERE image_url <> ''
    UNION SELECT image_url FROM service_items WHERE image_url <> ''
    ${includeCovers ? "UNION SELECT image_url FROM home_covers" : ""}
  `)).rows;
}
module.exports = { list };
