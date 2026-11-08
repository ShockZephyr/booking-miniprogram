const fs = require("fs/promises");
const path = require("path");
const db = require("../config/db");
const env = require("../config/env");
const images = require("./therapistImageService");
const references = require("../repositories/imageReferenceRepository");
const imageBackupLock = require("../utils/imageBackupLock");
const { logger } = require("../config/logger");

const MANAGED_FILE = /^[0-9a-f-]+\.(jpg|png|webp)$/i;
const URL_PREFIX = "/uploads/therapists/";

async function listManagedFiles() {
  await images.ensureReady();
  return (await fs.readdir(images.directory)).filter((name) => MANAGED_FILE.test(name));
}

async function cleanupOrphans(options = {}) {
  const retentionHours = options.retentionHours == null
    ? env.imageOrphanRetentionHours
    : Number(options.retentionHours);
  if (!Number.isFinite(retentionHours) || retentionHours < 0) {
    throw new Error("retentionHours must be zero or greater");
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);
  const fileNames = await listManagedFiles();
  const fileUrls = fileNames.map((name) => `${URL_PREFIX}${name}`);

  return db.transaction(async (client) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [imageBackupLock], client);
    // Catalog saves use the same lock, so a file cannot become referenced between
    // the final reference check and unlinking it.
    await db.query("SELECT pg_advisory_xact_lock(582302)", [], client);
    const rows = await references.list(client);
    const referenced = new Set(rows.map((row) => row.image_url));
    const orphanUrls = fileUrls.filter((url) => !referenced.has(url));

    await db.query(
      "DELETE FROM image_cleanup_candidates WHERE NOT (image_url = ANY($1::text[]))",
      [orphanUrls],
      client
    );
    if (orphanUrls.length) {
      await db.query(
        `
          INSERT INTO image_cleanup_candidates (image_url, first_seen_orphan_at)
          SELECT image_url, $2::timestamptz FROM unnest($1::text[]) AS image_url
          ON CONFLICT (image_url) DO NOTHING
        `,
        [orphanUrls, now],
        client
      );
    }

    const eligible = orphanUrls.length
      ? await db.query(
        `
          SELECT image_url
          FROM image_cleanup_candidates
          WHERE image_url = ANY($1::text[]) AND first_seen_orphan_at <= $2
          ORDER BY image_url
        `,
        [orphanUrls, cutoff],
        client
      )
      : { rows: [] };

    let deleted = 0;
    let failed = 0;
    for (const candidate of eligible.rows) {
      const name = path.basename(candidate.image_url);
      if (!MANAGED_FILE.test(name)) continue;
      try {
        await fs.unlink(path.join(images.directory, name));
        deleted += 1;
        await db.query("DELETE FROM image_cleanup_candidates WHERE image_url = $1", [candidate.image_url], client);
      } catch (error) {
        if (error.code === "ENOENT") {
          await db.query("DELETE FROM image_cleanup_candidates WHERE image_url = $1", [candidate.image_url], client);
        } else {
          failed += 1;
          logger.warn({ imageUrl: candidate.image_url, error: error.message }, "image_cleanup_failed");
        }
      }
    }

    const result = {
      files: fileUrls.length,
      referenced: referenced.size,
      orphaned: orphanUrls.length,
      deleted,
      failed,
      retentionHours
    };
    logger.info(result, "image_cleanup_completed");
    return result;
  });
}

module.exports = { cleanupOrphans, listManagedFiles, MANAGED_FILE, URL_PREFIX };
