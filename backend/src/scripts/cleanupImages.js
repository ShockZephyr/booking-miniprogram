const db = require("../config/db");
const { cleanupOrphans } = require("../services/imageCleanupService");

cleanupOrphans()
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.close());
