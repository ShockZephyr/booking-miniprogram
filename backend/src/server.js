const cron = require("node-cron");
const createApp = require("./app");
const env = require("./config/env");
const db = require("./config/db");
const { logger } = require("./config/logger");
const noShowService = require("./services/noShowService");
const autoCheckInService = require("./services/autoCheckInService");
const alertService = require("./services/alertService");
const { rotateLogsNow } = require("./services/logRotationService");
const imageCleanupService = require("./services/imageCleanupService");
const recycleBinCleanupService = require("./services/recycleBinCleanupService");
const logRetentionService = require("./services/logRetentionService");

rotateLogsNow();

cron.schedule("*/10 * * * *", () => {
  try { rotateLogsNow(); }
  catch (error) { logger.error({ error: error.message }, "log_rotation_failed"); }
}, { timezone: env.timezone });

let retentionRunning = false;
async function cleanLogs() {
  if (retentionRunning) return;
  retentionRunning = true;
  try { logger.info({ deleted: await logRetentionService.cleanupLogs() }, "log_retention_completed"); }
  catch (error) { logger.error({ error: error.message }, "log_retention_failed"); }
  finally { retentionRunning = false; }
}
cron.schedule("45 * * * *", cleanLogs, { timezone: env.timezone });

function cleanRecycleBin() {
  return recycleBinCleanupService.purgeExpired().catch((error) => {
    logger.error({ error: error.message, stack: error.stack }, "recycle_bin_cleanup_job_failed");
  });
}

let autoCheckInRunning = false;
async function checkInExpired() {
  if (autoCheckInRunning) return;
  autoCheckInRunning = true;
  try { await autoCheckInService.checkInExpired(); }
  catch (error) { logger.error({ error: error.message, stack: error.stack }, "expired_auto_check_in_failed"); }
  finally { autoCheckInRunning = false; }
}

cron.schedule(autoCheckInService.CRON, checkInExpired, { timezone: env.timezone });

const app = createApp();
const server = app.listen(env.port, () => {
  logger.info({ port: env.port, nodeEnv: env.nodeEnv }, "server_started");
  // node-cron does not catch up missed runs. Check once on every process start
  // so records still expire if the server was offline at the scheduled time.
  cleanRecycleBin();
  cleanLogs();
  checkInExpired();
});

cron.schedule(env.noShowCron, () => {
  noShowService.markNoShows().catch((error) => {
    logger.error({ error: error.message, stack: error.stack }, "no_show_job_failed");
  });
}, { timezone: env.timezone });

cron.schedule("*/5 * * * *", () => {
  alertService.evaluate5xx().catch((error) => {
    logger.warn({ error: error.message }, "alert_evaluation_failed");
  });
});

cron.schedule(env.imageCleanupCron, () => {
  imageCleanupService.cleanupOrphans().catch((error) => {
    logger.error({ error: error.message, stack: error.stack }, "image_cleanup_job_failed");
  });
}, { timezone: env.timezone });

cron.schedule(env.recycleBinCleanupCron, cleanRecycleBin, { timezone: env.timezone });

async function shutdown(signal) {
  logger.info({ signal }, "graceful_shutdown_started");
  server.close(async () => {
    try {
      await db.close();
      logger.info("database_closed");
      process.exit(0);
    } catch (error) {
      logger.error({ error: error.message }, "graceful_shutdown_failed");
      process.exit(1);
    }
  });
  setTimeout(() => {
    logger.error("graceful_shutdown_timeout");
    process.exit(1);
  }, 15000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", async (error) => {
  logger.fatal({ error: error.message, stack: error.stack }, "uncaught_exception");
  await alertService.processException("uncaughtException", error);
  process.exit(1);
});
process.on("unhandledRejection", async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.fatal({ error: error.message, stack: error.stack }, "unhandled_rejection");
  await alertService.processException("unhandledRejection", error);
  process.exit(1);
});
