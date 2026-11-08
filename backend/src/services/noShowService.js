const acquireIdentityLock = require("../utils/identityLock");
const appointmentRepository = require("../repositories/appointmentRepository");
const metrics = require("./metricsService");
const db = require("../config/db");
const { logger } = require("../config/logger");

async function markNoShows() {
  const count = await db.transaction(async (client) => {
    await acquireIdentityLock(client);
    return appointmentRepository.markNoShows(client);
  });
  if (count) {
    metrics.incrementAppointment("no_show", count);
    logger.info({ count }, "appointments_marked_no_show");
  }
  return count;
}

module.exports = {
  markNoShows
};
