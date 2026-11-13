const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(file, mocks, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), {
    ...globals, module, require(name) {
      assert.ok(name in mocks, `unexpected dependency ${name}`);
      return mocks[name];
    }
  });
  return module.exports;
}

function harness({ due = true, completed = false, failLog = false } = {}) {
  const calls = [], effects = [], client = {};
  const window = { due, runDate: "2020-03-02", cutoffDate: "2020-02-29", executedAt: "2020-03-01T16:05:00Z" };
  const repo = {
    windowForRun: async () => { calls.push("clock"); return window; },
    completed: async () => completed,
    candidates: async () => [{ id: "valid", status: "no_show" }, { id: "overlap", status: "no_show" }],
    conflicts: async id => id === "overlap",
    checkIn: async (id, time, tx) => { assert.equal(tx, client); calls.push(["checked", id, time]); },
    complete: async (result, tx) => { assert.equal(tx, client); calls.push(["complete", result]); }
  };
  const db = {
    transaction: async fn => {
      try {
        const result = await fn(client);
        calls.push("commit");
        for (const effect of effects) effect();
        return result;
      } catch (error) { calls.push("rollback"); throw error; }
    },
    afterCommit: (tx, fn) => { assert.equal(tx, client); effects.push(fn); }
  };
  const service = load("services/autoCheckInService.js", {
    "../config/db": db,
    "../utils/identityLock": async tx => { assert.equal(tx, client); calls.push("lock"); },
    "../repositories/autoCheckInRepository": repo,
    "./logService": { business: async (entry, tx) => {
      assert.equal(tx, client); calls.push(["log", entry]);
      if (failLog) throw new Error("fixture log failure");
    } },
    "./metricsService": { incrementAppointment: (event, n) => calls.push(["metric", event, n]) },
    "../config/logger": { logger: { info() {}, warn() {} } }
  });
  return { service, calls };
}

test("automatic check-in reads time after lock and skips early/already completed runs", async () => {
  for (const [options, expected] of [[{ due: false }, "not_due"], [{ completed: true }, "already_completed"]]) {
    const h = harness(options);
    assert.equal((await h.service.checkInExpired()).skipped, expected);
    assert.deepEqual(h.calls, ["lock", "clock", "commit"]);
  }
});

test("automatic check-in distinguishes system logs and commits counters only after success", async () => {
  const h = harness();
  const result = await h.service.checkInExpired();
  assert.equal(result.checkedIn, 1);
  assert.equal(result.conflicts, 1);
  const logs = h.calls.filter(c => c[0] === "log").map(c => c[1]);
  assert.deepEqual(logs.map(e => e.result), ["success", "skipped"]);
  assert.ok(logs.every(e => e.effectiveRole === "system" && e.userId === null && e.action === "auto_check_in_expired"));
  assert.equal(logs[1].metadata.reason, "overlapping_active_appointment");
  assert.ok(h.calls.indexOf("commit") < h.calls.findIndex(c => c[0] === "metric"));
  const failed = harness({ failLog: true });
  await assert.rejects(failed.service.checkInExpired(), /fixture log failure/);
  assert.equal(failed.calls.at(-1), "rollback");
  assert.ok(!failed.calls.some(c => c[0] === "complete" || c[0] === "metric"));
});

test("server runs Shanghai nightly task plus startup catchup, coalesces overlap and releases guard after errors", async () => {
  const schedules = [], errors = [];
  let onListen, calls = 0, rejectJob;
  const ignore = () => {};
  const cron = "5 0 * * *";
  load("server.js", {
    "node-cron": { schedule: (...args) => schedules.push(args) },
    "./app": () => ({ listen: (port, fn) => { onListen = fn; return {}; } }),
    "./config/env": { timezone: "Asia/Shanghai", port: 0 },
    "./config/db": {},
    "./config/logger": { logger: { info: ignore, warn: ignore, error: e => errors.push(e) } },
    "./services/noShowService": {},
    "./services/autoCheckInService": { CRON: cron, checkInExpired: () => {
      calls++;
      return new Promise((resolve, reject) => { rejectJob = reject; });
    } },
    "./services/alertService": {},
    "./services/logRotationService": { rotateLogsNow: ignore },
    "./services/imageCleanupService": {},
    "./services/recycleBinCleanupService": { purgeExpired: async () => {} },
    "./services/logRetentionService": { cleanupLogs: async () => {} },
  }, { process: { on: ignore } });
  const [, nightly, options] = schedules.find(([expression]) => expression === cron);
  assert.equal(options.timezone, "Asia/Shanghai");
  onListen();
  assert.equal(calls, 1);
  await nightly();
  assert.equal(calls, 1, "startup and cron must not overlap in one process");
  rejectJob(new Error("fixture failure"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  const retry = nightly();
  assert.equal(calls, 2, "failure must release the in-process guard");
  rejectJob(new Error("fixture retry failure"));
  await retry;
});
