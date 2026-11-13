const db = require("../config/db");
const acquireIdentityLock = require("../utils/identityLock");
const repository = require("../repositories/autoCheckInRepository");
const logService = require("./logService");
const metrics = require("./metricsService");
const { logger } = require("../config/logger");

const CRON = "5 0 * * *";

function createAutoCheckInService(deps = {}) {
  const transaction = deps.transaction || ((handler) => db.transaction(handler));
  const repo = deps.repository || repository;
  const log = deps.logService || logService;
  const clock = deps.now || (() => null);

  async function checkInExpired() {
    return transaction(async (client) => {
      // Same first lock as cancellation, manual check-in and no-show marking.
      await acquireIdentityLock(client);
      const window = await repo.windowForRun(client, clock());
      if (!window.due) return { skipped: "not_due" };
      if (await repo.completed(window.runDate, client)) return { skipped: "already_completed" };

      const result = { runDate: window.runDate, cutoffDate: window.cutoffDate,
        executedAt: window.executedAt, checkedIn: 0, conflicts: 0 };
      for (const appointment of await repo.candidates(window.cutoffDate, client)) {
        const conflict = await repo.conflicts(appointment.id, client);
        if (conflict) result.conflicts += 1;
        else {
          await repo.checkIn(appointment.id, window.executedAt, client);
          result.checkedIn += 1;
        }
        await log.business({
          userId: null, effectiveRole: "system", action: "auto_check_in_expired",
          resourceType: "appointment", resourceId: appointment.id,
          result: conflict ? "skipped" : "success",
          requestId: `auto_check_in_${window.runDate}`,
          metadata: { runDate: window.runDate, cutoffDate: window.cutoffDate,
            previousStatus: appointment.status,
            ...(conflict ? { reason: "overlapping_active_appointment" } : { checkedInAt: window.executedAt }) }
        }, client);
      }
      // Atomic with appointment changes and logs: a failed run can be retried.
      await repo.complete(result, client);
      db.afterCommit(client, () => {
        if (result.checkedIn) metrics.incrementAppointment("checked_in", result.checkedIn);
        logger[result.conflicts ? "warn" : "info"]({ ...result }, "expired_auto_check_in_completed");
      });
      return result;
    });
  }

  return { checkInExpired };
}

module.exports = { ...createAutoCheckInService(), createAutoCheckInService, CRON };
