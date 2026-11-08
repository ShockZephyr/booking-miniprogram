const fs = require("fs");
const path = require("path");
const env = require("../config/env");
const { logsDir, destinations } = require("../config/logger");

function dateStamp(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function initialDate(full, stat) {
  // Recover the first entry's date for installations without a rotation state.
  // Read only a bounded prefix, even if an existing log is very large.
  const fd = fs.openSync(full, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const first = JSON.parse(buffer.subarray(0, length).toString("utf8").split("\n")[0]);
    const time = new Date(first.time);
    if (!Number.isNaN(time.getTime())) return dateStamp(time);
  } catch (_) {
    // Legacy non-JSON logs acquire a persistent date on the first inspection.
  } finally { fs.closeSync(fd); }
  return dateStamp(stat.mtime);
}

function rotateIfOld(file, options) {
  const full = path.join(options.directory, file);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (!options.state[file]) options.state[file] = initialDate(full, stat);
  if (!stat.size) options.state[file] = dateStamp(options.now);
  if (stat.size && (options.state[file] !== dateStamp(options.now) || stat.size >= options.maxBytes)) {
    const stream = options.destinations.get(file);
    if (stream && (!Number.isInteger(stream.fd) || stream.fd < 0)) return;
    if (stream) stream.flushSync();
    const stamp = options.now.toISOString().replace(/[:.]/g, "-");
    const target = path.join(options.directory, `${file}.${stamp}`);
    if (fs.existsSync(target)) return;
    if (process.platform === "win32" && stream) {
      // Windows cannot rename a live writer. Flush, then copy/truncate without
      // yielding the event loop; O_APPEND keeps subsequent writes in the live file.
      fs.copyFileSync(full, target, fs.constants.COPYFILE_EXCL);
      fs.truncateSync(full, 0);
      options.state[file] = dateStamp(options.now);
      return;
    }
    fs.renameSync(full, target);
    // Reopen the live Pino descriptor; otherwise it keeps writing to the archive.
    if (stream) stream.reopen(full);
    options.state[file] = dateStamp(options.now);
  }
}

function cleanupOld(options) {
  const cutoff = options.now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(options.directory)) {
    const full = path.join(options.directory, file);
    const stat = fs.lstatSync(full);
    if (stat.isFile() && stat.mtimeMs < cutoff && /^(application|error|audit)\.log\.\d{4}-\d{2}-\d{2}(T[\d-]+Z)?$/.test(file)) {
      fs.unlinkSync(full);
    }
  }
}

function rotateLogsNow(overrides = {}) {
  const options = { directory: logsDir, destinations, now: new Date(), maxBytes: env.logMaxBytes, retentionDays: env.logRetentionDays, ...overrides };
  fs.mkdirSync(options.directory, { recursive: true });
  const stateFile = path.join(options.directory, ".rotation-state.json");
  options.state = {};
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    for (const file of ["application.log", "error.log", "audit.log"]) {
      if (typeof saved?.[file] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(saved[file])) options.state[file] = saved[file];
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  ["application.log", "error.log", "audit.log"].forEach((file) => rotateIfOld(file, options));
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(options.state), { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
  cleanupOld(options);
}

module.exports = {
  rotateLogsNow
};

