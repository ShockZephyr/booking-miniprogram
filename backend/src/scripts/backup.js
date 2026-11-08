const path = require("node:path");
const env = require("../config/env");
const backups = require("../services/backupService");

async function main() {
  const [action, directory, confirmation] = process.argv.slice(2);
  if (action === "verify") return { verified: true, images: (await backups.verifyBackup(path.resolve(directory))).images.length };
  if (action === "restore") return backups.restore({ directory: path.resolve(directory), databaseUrl: process.env.RESTORE_DATABASE_URL,
    uploadsDirectory: process.env.RESTORE_UPLOAD_DIR, confirmEmptyTarget: confirmation === "--confirm-empty-target" });
  if (action && action !== "create") throw new Error("Usage: backup.js [create | verify <directory> | restore <directory> --confirm-empty-target]");
  return backups.backup({ databaseUrl: env.databaseUrl, backupDirectory: process.env.BACKUP_DIR,
    uploadsDirectory: require("../services/therapistImageService").directory, mirrorDirectory: process.env.BACKUP_MIRROR_DIR || "",
    retentionDays: Number(process.env.BACKUP_RETENTION_DAYS || 14) });
}
main().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
