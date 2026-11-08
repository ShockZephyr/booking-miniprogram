const { auditLogger } = require("../config/logger");
const auditLogRepository = require("../repositories/auditLogRepository");
const metrics = require("./metricsService");
const { sanitizeLogPayload } = require("../utils/privacy");
const { afterCommit } = require("../config/db");

async function record(entry, client) {
  entry = sanitizeLogPayload(entry);
  const result = await auditLogRepository.create(entry, client);
  afterCommit(client, () => {
    auditLogger.info(entry, "audit");
    metrics.incrementAdminOperation(entry.action);
  });
  return result;
}

module.exports = {
  record
};

