const db = require("../config/db");
const env = require("../config/env");

async function cleanupLogs(database = db, retentionDays = env.logRetentionDays, options = {}) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("Invalid log retention period.");
  const result = {};
  const budgetMs = options.budgetMs ?? 2000;
  if (!Number.isInteger(budgetMs) || budgetMs < 1) throw new Error("Invalid cleanup budget.");
  // Commit each bounded batch separately. Hourly/startup runs catch up if a
  // large backlog reaches the per-table execution budget.
  for (const table of ["http_request_logs", "client_errors", "business_logs", "audit_logs", "alerts"]) {
    const start = Date.now();
    result[table] = 0;
    for (let batch = 0; batch < 100; batch += 1) {
      const deleted = await database.query(`DELETE FROM ${table} WHERE id IN (
        SELECT id FROM ${table} WHERE created_at < now() - ($1 * interval '1 day')
        ORDER BY created_at LIMIT 10000 FOR UPDATE SKIP LOCKED
      )`, [retentionDays]);
      result[table] += deleted.rowCount;
      if (deleted.rowCount < 10000 || Date.now() - start >= budgetMs) break;
    }
  }
  return result;
}

module.exports = { cleanupLogs };
