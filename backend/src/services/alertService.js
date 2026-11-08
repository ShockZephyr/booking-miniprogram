const db = require("../config/db");
const alertRepository = require("../repositories/alertRepository");
const env = require("../config/env");
const { logger } = require("../config/logger");

async function evaluate5xx() {
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS count FROM http_request_logs WHERE created_at >= now() - interval '5 minutes' AND status_code >= 500"
  );
  const count = rows[0].count;
  if (count >= env.alert5xxThreshold5m) {
    const alert = await alertRepository.create({
      type: "http_5xx_spike",
      level: "critical",
      message: `最近 5 分钟 5xx 数量达到 ${count}`,
      metadata: { count, threshold: env.alert5xxThreshold5m }
    });
    logger.error({ alert }, "alert_triggered");
    return alert;
  }
  return null;
}

async function databaseFailure(error) {
  try {
    return await alertRepository.create({
      type: "database_connection_failure",
      level: "critical",
      message: "Database connection failure",
      metadata: { error: error.message }
    });
  } catch (alertError) {
    logger.error({ error: alertError.message }, "failed_to_persist_database_alert");
    return null;
  }
}

async function processException(type, error) {
  try {
    await alertRepository.create({
      type,
      level: "critical",
      message: error.message,
      metadata: { stack: error.stack }
    });
  } catch (alertError) {
    logger.error({ error: alertError.message }, "failed_to_persist_process_alert");
  }
}

module.exports = {
  evaluate5xx,
  databaseFailure,
  processException
};

