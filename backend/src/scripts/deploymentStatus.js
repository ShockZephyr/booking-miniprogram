const env = require("../config/env");
const db = require("../config/db");
const fs = require("node:fs/promises");
const path = require("node:path");
const { verifyBackup } = require("../services/backupService");
const { scheduleCounts } = require("../services/scheduleCounts");

async function main() {
  const counts = await db.query(`SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM users WHERE role='admin') AS admins,
    (SELECT count(*)::int FROM users WHERE openid LIKE 'mock_%' OR openid LIKE 'dev_mock_%') AS mock_accounts,
    (SELECT count(*)::int FROM appointments) AS appointments,
    (SELECT count(*)::int FROM therapists WHERE status='active') AS active_therapists,
    (SELECT count(*)::int FROM service_items WHERE status='active') AS active_projects`);
  const directory = require("../services/therapistImageService").directory;
  const storage = await fs.statfs(directory);
  const result = { environment: env.nodeEnv, counts: { ...counts.rows[0], ...await scheduleCounts(db) },
    storage: { directory, freeBytes: storage.bavail * storage.bsize, totalBytes: storage.blocks * storage.bsize }, latestBackup: null };
  if (process.env.BACKUP_DIR) {
    const names = await fs.readdir(process.env.BACKUP_DIR).catch(() => []);
    for (const name of names.filter((name) => name.startsWith("booking-")).sort().reverse()) {
      const manifest = await verifyBackup(path.join(process.env.BACKUP_DIR, name)).catch(() => null);
      if (manifest) { result.latestBackup = { createdAt: manifest.createdAt, images: manifest.images.length }; break; }
    }
  }
  return result;
}
main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => db.close());
