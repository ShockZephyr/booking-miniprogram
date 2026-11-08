const db = require("../config/db");

// Shared by identity changes and appointment writers, before any row locks.
module.exports = async function acquireIdentityLock(client) {
  await db.query("SELECT pg_advisory_xact_lock(582302)", [], client);
};
