const fs = require("fs");
const path = require("path");
const db = require("../config/db");
const { logger } = require("../config/logger");

async function migrate() {
  const dir = path.join(__dirname, "../../migrations");
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();
  await db.transaction(async (client) => {
    await db.query("SELECT pg_advisory_xact_lock(582301)", [], client);
    await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())", [], client);
    const { rows } = await db.query("SELECT name FROM schema_migrations", [], client);
    const applied = new Set(rows.map((row) => row.name));
    // Legacy installations did not record migration versions. The first four are idempotent.
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      logger.info({ file }, "running_migration");
      await db.query(sql, [], client);
      await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file], client);
    }
  });
  await db.close();
  logger.info("migrations_completed");
}

migrate().catch(async (error) => {
  logger.error({ error: error.message, stack: error.stack }, "migration_failed");
  await db.close();
  process.exit(1);
});
