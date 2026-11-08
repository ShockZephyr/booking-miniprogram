const env = require("../config/env");
const { Client } = require("pg");
const { copyImages } = require("../services/backupService");
const images = require("../services/therapistImageService");
const imageReferences = require("../repositories/imageReferenceRepository");

async function main() {
  const target = process.argv[2];
  if (!target || !require("node:path").isAbsolute(target)) throw new Error("Pass the absolute destination directory. Source files are preserved.");
  const client = new Client({ connectionString: env.databaseUrl, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query("SET lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_lock(582302)");
    const references = await imageReferences.list(client, { allowLegacy: true });
    for (const row of references) await images.assertExists(row.image_url);
    const files = await copyImages(images.directory, target);
    return { source: images.directory, destination: target, files: files.length, verified: true, nextStep: "Set THERAPIST_UPLOAD_DIR to destination and restart the service. Source files have been preserved." };
  } finally { await client.end(); }
}
main().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
