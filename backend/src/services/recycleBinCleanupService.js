const db = require("../config/db");
const env = require("../config/env");
const projects = require("../repositories/serviceItemRepository");
const therapists = require("../repositories/therapistRepository");
const logs = require("./logService");
const { logger } = require("../config/logger");

async function purgeExpired(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const retentionDays = options.retentionDays == null
    ? env.recycleBinRetentionDays
    : Number(options.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error("retentionDays must be a positive integer");
  }
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const result = await db.transaction(async (client) => {
    await db.query("SELECT pg_advisory_xact_lock(582302)", [], client);
    const dueProjects = await projects.listInactiveDueForPurge(cutoff, client);
    const dueTherapists = await therapists.listDeletedDueForPurge(cutoff, client);
    for (const item of dueProjects) await projects.purge(item.id, client);
    for (const item of dueTherapists) await therapists.purge(item.id, client);
    const summary = {
      projects: dueProjects.length,
      therapists: dueTherapists.length,
      retentionDays,
      cutoff: cutoff.toISOString()
    };
    await logs.business({
      userId: null,
      effectiveRole: "system",
      action: "purge_expired_recycle_bin",
      resourceType: "recycle_bin",
      resourceId: null,
      result: "success",
      requestId: `recycle_cleanup_${now.toISOString()}`,
      metadata: summary
    }, client);
    return summary;
  });
  logger.info(result, "recycle_bin_cleanup_completed");
  return result;
}

module.exports = { purgeExpired };
