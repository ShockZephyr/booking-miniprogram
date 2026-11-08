const fs = require("fs/promises");
const path = require("path");
const images = require("../services/therapistImageService");
const { MANAGED_FILE } = require("../services/imageCleanupService");

(async () => {
  await images.ensureReady();
  const names = (await fs.readdir(images.directory)).filter((name) => MANAGED_FILE.test(name));
  const stats = await Promise.all(names.map((name) => fs.stat(path.join(images.directory, name))));
  const output = {
    directory: images.directory,
    files: names.length,
    bytes: stats.reduce((sum, item) => sum + item.size, 0)
  };
  if (typeof fs.statfs === "function") {
    const storage = await fs.statfs(images.directory);
    output.freeBytes = storage.bavail * storage.bsize;
    output.totalBytes = storage.blocks * storage.bsize;
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
