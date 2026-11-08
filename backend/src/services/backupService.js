const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { Client } = require("pg");
const imageReferences = require("../repositories/imageReferenceRepository");
const imageBackupLock = require("../utils/imageBackupLock");

const IMAGE_FILE = /^[0-9a-f-]+\.(jpg|png|webp)$/i;
const BACKUP_NAME = /^booking-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}$/;
const FORMAT = "booking-backup-v1";

function contains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertSeparate(first, second) {
  if (contains(first, second) || contains(second, first)) throw new Error("Storage directories must not overlap.");
}

function pgEnvironment(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid PostgreSQL connection protocol.");
  const result = { ...process.env, PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: "10" };
  if (!result.PGDATABASE) throw new Error("PostgreSQL database name is required.");
  const supported = { sslmode: "PGSSLMODE", sslrootcert: "PGSSLROOTCERT", sslcert: "PGSSLCERT", sslkey: "PGSSLKEY", options: "PGOPTIONS" };
  for (const [key, value] of url.searchParams) {
    if (!supported[key]) throw new Error(`Unsupported backup connection option: ${key}`);
    result[supported[key]] = value;
  }
  return result;
}

function runPg(tool, args, databaseUrl, binDirectory = process.env.PG_BIN || "") {
  const binary = `${tool}${process.platform === "win32" ? ".exe" : ""}`;
  const executable = binDirectory ? path.join(binDirectory, binary) : binary;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: pgEnvironment(databaseUrl), shell: false, windowsHide: true, stdio: "ignore" });
    child.once("error", (error) => reject(new Error(`${tool} could not start (${error.code || "unknown"}); configure PG_BIN and matching PostgreSQL client tools.`)));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${tool} failed (${code}); database/files were not overwritten. Check PostgreSQL client compatibility and database permissions.`)));
  });
}

async function fingerprint(file) {
  if (!(await fs.lstat(file)).isFile()) throw new Error("Only regular files are allowed in backups.");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest("hex") };
}

async function copyImages(source, target) {
  assertSeparate(source, target);
  const copied = [];
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(source)).isDirectory() || !(await fs.lstat(target)).isDirectory()) throw new Error("Image directories must not be symlinks.");
  assertSeparate(await fs.realpath(source), await fs.realpath(target));
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (!IMAGE_FILE.test(entry.name)) continue;
    if (!entry.isFile()) throw new Error("Image storage contains a non-regular image file.");
    const sourceFile = path.join(source, entry.name), destination = path.join(target, entry.name);
    const expected = await fingerprint(sourceFile);
    try { await fs.copyFile(sourceFile, destination, require("node:fs").constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const actual = await fingerprint(destination);
    if (actual.sha256 !== expected.sha256) throw new Error(`Image copy verification failed: ${entry.name}`);
    copied.push({ name: entry.name, ...actual });
  }
  return copied;
}

async function verifyBackup(directory) {
  if (!(await fs.lstat(directory)).isDirectory()) throw new Error("Backup must be a real directory.");
  const manifestPath = path.join(directory, "manifest.json");
  if (!(await fs.lstat(manifestPath)).isFile()) throw new Error("Backup manifest must be a regular file.");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.format !== FORMAT || !Array.isArray(manifest.images) || !manifest.database || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error("Invalid backup manifest.");
  const dump = await fingerprint(path.join(directory, "database.dump"));
  if (dump.sha256 !== manifest.database.sha256 || dump.bytes !== manifest.database.bytes) throw new Error("Database backup checksum mismatch.");
  if (!(await fs.lstat(path.join(directory, "images"))).isDirectory()) throw new Error("Backup images must be a real directory.");
  const names = new Set();
  for (const file of manifest.images) {
    if (!IMAGE_FILE.test(file.name) || names.has(file.name)) throw new Error("Invalid or duplicate backup image name.");
    names.add(file.name);
    const actual = await fingerprint(path.join(directory, "images", file.name));
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error(`Image backup checksum mismatch: ${file.name}`);
  }
  return manifest;
}

async function pruneBackups(root, retentionDays, now = new Date()) {
  const absoluteRoot = await fs.realpath(root);
  const cutoff = now.getTime() - retentionDays * 86400000;
  let deleted = 0;
  for (const entry of await fs.readdir(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !BACKUP_NAME.test(entry.name)) continue;
    const target = path.join(absoluteRoot, entry.name);
    // Only delete verified backup trees created by this utility, inside this root.
    const manifest = await verifyBackup(target).catch(() => null);
    if (!manifest || Date.parse(manifest.createdAt) >= cutoff) continue;
    const resolved = await fs.realpath(target);
    if (!contains(absoluteRoot, resolved) || resolved === absoluteRoot) throw new Error("Unsafe backup cleanup path.");
    const expected = new Set(["database.dump", "manifest.json", "images"]);
    if ((await fs.readdir(target)).some((name) => !expected.has(name))) continue;
    if ((await fs.readdir(path.join(target, "images"))).some((name) => !manifest.images.some((file) => file.name === name))) continue;
    await fs.rm(resolved, { recursive: true });
    deleted += 1;
  }
  return deleted;
}

async function backup(options) {
  const { databaseUrl, uploadsDirectory, backupDirectory, mirrorDirectory = "", retentionDays = 14, binDirectory } = options;
  if (!backupDirectory || !Number.isInteger(retentionDays) || retentionDays < 1) throw new Error("BACKUP_DIR and a positive BACKUP_RETENTION_DAYS are required.");
  assertSeparate(uploadsDirectory, backupDirectory);
  if (mirrorDirectory) { assertSeparate(backupDirectory, mirrorDirectory); assertSeparate(uploadsDirectory, mirrorDirectory); }
  await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const name = `booking-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const staging = path.join(backupDirectory, `.${name}.pending`);
  const destination = path.join(backupDirectory, name);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query("SET lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_lock_shared($1)", [imageBackupLock]);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [{ snapshot }] } = await client.query("SELECT pg_export_snapshot() AS snapshot");
    await fs.mkdir(staging, { mode: 0o700 });
    const source = (await client.query("SELECT current_database() AS name")).rows[0].name;
    const references = await imageReferences.list(client, { allowLegacy: true });
    for (const row of references) {
      const name = path.basename(row.image_url);
      if (!IMAGE_FILE.test(name)) throw new Error("Unsupported referenced image URL.");
      await fingerprint(path.join(uploadsDirectory, name));
    }
    await runPg("pg_dump", ["--snapshot", snapshot, "--format=custom", "--no-owner", "--no-privileges", "--file", path.join(staging, "database.dump")], databaseUrl, binDirectory);
    await client.query("COMMIT");
    const images = await copyImages(uploadsDirectory, path.join(staging, "images"));
    await client.query("SELECT pg_advisory_unlock_shared($1)", [imageBackupLock]);
    const manifest = { format: FORMAT, createdAt: new Date().toISOString(), sourceDatabase: source,
      database: await fingerprint(path.join(staging, "database.dump")), images };
    await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
    await verifyBackup(staging);
    await fs.rename(staging, destination);
  } finally { await client.end(); }
  // Release application locks before mirroring and retention cleanup.
  if (mirrorDirectory) {
    await fs.mkdir(mirrorDirectory, { recursive: true, mode: 0o700 });
    const pending = path.join(mirrorDirectory, `.${name}.pending`);
    await fs.cp(destination, pending, { recursive: true, errorOnExist: true, force: false });
    await verifyBackup(pending);
    await fs.rename(pending, path.join(mirrorDirectory, name));
    await pruneBackups(mirrorDirectory, retentionDays);
  }
  await pruneBackups(backupDirectory, retentionDays);
  return { directory: path.resolve(destination), ...(mirrorDirectory ? { mirrorDirectory: path.resolve(mirrorDirectory) } : {}) };
}

async function invalidateRestoredSessions(client) {
  // Older backups do not yet contain the random session generation.
  await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch uuid NOT NULL DEFAULT gen_random_uuid()");
  await client.query("UPDATE users SET session_version=session_version+1, session_epoch=gen_random_uuid()");
}

async function restore(options) {
  const { directory, databaseUrl, uploadsDirectory, binDirectory, confirmEmptyTarget } = options;
  if (!confirmEmptyTarget || !databaseUrl || !uploadsDirectory) throw new Error("RESTORE_DATABASE_URL, RESTORE_UPLOAD_DIR and --confirm-empty-target are required.");
  assertSeparate(directory, uploadsDirectory);
  const manifest = await verifyBackup(directory);
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    const name = (await client.query("SELECT current_database() AS name")).rows[0].name;
    if (name === manifest.sourceDatabase) throw new Error("Restore into a different, empty database; source database name is protected.");
    const tables = await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p') LIMIT 1");
    if (tables.rowCount) throw new Error("Restore target database is not empty.");
    await fs.mkdir(uploadsDirectory, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(uploadsDirectory)).isDirectory() || (await fs.readdir(uploadsDirectory)).length) throw new Error("Restore image directory must be real and empty.");
    for (const image of manifest.images) {
      const destination = path.join(uploadsDirectory, image.name);
      await fs.copyFile(path.join(directory, "images", image.name), destination, require("node:fs").constants.COPYFILE_EXCL);
      if ((await fingerprint(destination)).sha256 !== image.sha256) throw new Error(`Restored image checksum mismatch: ${image.name}`);
    }
    await runPg("pg_restore", ["--dbname", name, "--single-transaction", "--exit-on-error", "--no-owner", "--no-privileges", path.join(directory, "database.dump")], databaseUrl, binDirectory);
    // An isolated rehearsal must never replay old WeChat messages or accept live tokens.
    await client.query("BEGIN");
    // Retire legacy queues when restoring a backup made before messaging was removed.
    await client.query("UPDATE notifications SET delivery_status='skipped', last_error='restored_backup', updated_at=now() WHERE delivery_status IN ('pending','sending','failed')");
    await invalidateRestoredSessions(client);
    await client.query("COMMIT");
    return { database: name, images: manifest.images.length, directory: path.resolve(uploadsDirectory), notificationsDisabled: true, sessionsInvalidated: true };
  } finally { await client.end(); }
}

module.exports = { backup, restore, invalidateRestoredSessions, verifyBackup, copyImages, fingerprint, pruneBackups, contains, assertSeparate, pgEnvironment, runPg, FORMAT };
