const { logger } = require("../config/logger");
const logRepository = require("../repositories/logRepository");
const { sanitizeLogPayload } = require("../utils/privacy");
const { afterCommit } = require("../config/db");

async function business(entry, client) {
  entry = sanitizeLogPayload(entry);
  const emit = () => logger.info(entry, "business_activity");
  if (!entry.requestId) { afterCommit(client, emit); return null; }
  // A failed statement aborts a PostgreSQL transaction. Propagate that failure
  // so the caller rolls back and never reports the unwritten operation as saved.
  if (client) {
    const result = await logRepository.createBusiness(entry, client);
    afterCommit(client, emit);
    return result;
  }
  try {
    const result = await logRepository.createBusiness(entry, client);
    emit();
    return result;
  } catch (error) {
    logger.warn({ error: error.message, action: entry.action }, "failed_to_persist_business_log");
    return null;
  }
}

module.exports = {
  business
};

