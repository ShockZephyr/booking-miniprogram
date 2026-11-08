const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { Client } = require("pg");
const net = require("node:net");
const env = require("../config/env");
const { restore, verifyBackup, contains, runPg } = require("../services/backupService");
const { scheduleCounts } = require("../services/scheduleCounts");

async function isolatedPostgres(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString("hex");
  const passwordFile = path.join(directory, "password");
  await fs.writeFile(passwordFile, password, { mode: 0o600 });
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const databaseUrl = `postgres://booking_rehearsal:${password}@127.0.0.1:${port}/postgres`;
  const dataDirectory = path.join(directory, "data");
  await runPg("initdb", ["-D", dataDirectory, "--username=booking_rehearsal", "--pwfile", passwordFile, "--auth=scram-sha-256", "--no-locale", "--encoding=UTF8"], databaseUrl);
  const stop = () => runPg("pg_ctl", ["-D", dataDirectory, "-w", "stop", "-m", "fast"], databaseUrl);
  try {
    await runPg("pg_ctl", ["-D", dataDirectory, "-l", path.join(directory, "server.log"), "-o", `-h 127.0.0.1 -p ${port}`, "-w", "start"], databaseUrl);
    return { databaseUrl, stop };
  } catch (error) { await stop().catch(() => {}); throw error; }
}

async function main() {
  const backupRoot = path.resolve(process.env.BACKUP_DIR || "backups");
  const isolated = process.argv.includes("--isolated");
  const supplied = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const names = supplied ? [] : (await fs.readdir(backupRoot)).filter((name) => /^booking-/.test(name)).sort().reverse();
  const directory = supplied ? path.resolve(supplied) : path.join(backupRoot, names[0] || "missing");
  await verifyBackup(directory);
  const suffix = randomBytes(6).toString("hex");
  const databaseName = `booking_restore_${suffix}`;
  if (!/^booking_restore_[0-9a-f]{12}$/.test(databaseName)) throw new Error("Unsafe rehearsal database name.");
  const targetDirectory = path.join(backupRoot, `.restore-${suffix}`);
  const clusterDirectory = path.join(backupRoot, `.pg-rehearsal-${suffix}`);
  const cluster = isolated ? await isolatedPostgres(clusterDirectory) : null;
  const connection = new URL(cluster ? cluster.databaseUrl : (process.env.REHEARSAL_ADMIN_DATABASE_URL || env.databaseUrl));
  connection.pathname = `/${databaseName}`;
  const root = new Client({ connectionString: cluster ? cluster.databaseUrl : (process.env.REHEARSAL_ADMIN_DATABASE_URL || env.databaseUrl), connectionTimeoutMillis: 10000 });
  let created = false;
  try {
    await root.connect();
    // CREATE DATABASE requires CREATEDB; use a separate rehearsal account if needed.
    await root.query(`CREATE DATABASE ${databaseName}`);
    created = true;
    const result = await restore({ directory, databaseUrl: connection.toString(), uploadsDirectory: targetDirectory, confirmEmptyTarget: true });
    const restored = new Client({ connectionString: connection.toString(), connectionTimeoutMillis: 10000 });
    try {
      await restored.connect();
      const { rows: [counts] } = await restored.query(`SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM appointments) AS appointments,
        (SELECT count(*)::int FROM notifications WHERE delivery_status IN ('pending','sending')) AS pending_notifications`);
      if (counts.pending_notifications) throw new Error("Rehearsal contains pending notifications.");
      const restoredCounts = { ...counts, ...await scheduleCounts(restored, { allowLegacy: true }) };
      const report = { success: true, checkedAt: new Date().toISOString(), backup: path.basename(directory), counts: restoredCounts, images: result.images,
        originalDatabaseChanged: false, sessionsInvalidated: result.sessionsInvalidated };
      await fs.writeFile(path.join(backupRoot, "restore-rehearsal-latest.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
      return report;
    } finally { await restored.end(); }
  } finally {
    try {
      if (created) await root.query(`DROP DATABASE ${databaseName}`);
      if (contains(backupRoot, targetDirectory) && path.basename(targetDirectory) === `.restore-${suffix}`) await fs.rm(targetDirectory, { recursive: true, force: true });
    } finally {
      await root.end();
      if (cluster) {
        await cluster.stop();
        if (contains(backupRoot, clusterDirectory) && path.basename(clusterDirectory) === `.pg-rehearsal-${suffix}`) await fs.rm(clusterDirectory, { recursive: true, force: true });
      }
    }
  }
}
main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
