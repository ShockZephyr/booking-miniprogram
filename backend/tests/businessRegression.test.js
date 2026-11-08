process.env.NODE_TEST_CONTEXT = "1";
process.env.DATABASE_URL = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const errors = require("../src/utils/errors");
const reviewSession = require("../src/services/reviewSession");

function load(file, deps) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    module, require: (name) => {
      if (name === "node:crypto") return require(name);
      if (!(name in deps)) throw new Error(`Unexpected dependency: ${name}`);
      return deps[name];
    }
  });
  return module.exports;
}

test("database failures remain server errors while invalid JWTs are session errors", async () => {
  const databaseError = new Error("database temporarily unavailable");
  let tokenError;
  const middleware = load("../src/middleware/auth.js", {
    jsonwebtoken: { decode: () => ({ header: {} }), verify: () => { if (tokenError) throw tokenError; return { sub: "u" }; } },
    "../config/env": { jwtSecret: "test" },
    "../services/reviewSession": reviewSession,
    "../repositories/userRepository": { findById: async () => { throw databaseError; } },
    "../services/accessService": { enrichUser: async (user) => user }, "../utils/errors": errors
  });
  let result;
  await middleware.attachUser({ get: () => "Bearer valid" }, {}, (error) => { result = error; });
  assert.equal(result, databaseError);
  tokenError = { name: "TokenExpiredError" };
  await middleware.attachUser({ get: () => "Bearer expired" }, {}, (error) => { result = error; });
  assert.equal(result.code, "INVALID_SESSION");
  assert.equal(result.status, 401);
});

test("tokens issued before an identity migration are rejected by session version", async () => {
  const middleware = load("../src/middleware/auth.js", {
    jsonwebtoken: { decode: () => ({ header: {} }), verify: () => ({ sub: "u", sv: 0 }) },
    "../config/env": { jwtSecret: "test" },
    "../services/reviewSession": reviewSession,
    "../repositories/userRepository": { findById: async () => ({ id: "u", sessionVersion: 1 }) },
    "../services/accessService": { enrichUser: async (user) => user }, "../utils/errors": errors
  });
  let result;
  await middleware.attachUser({ get: () => "Bearer old" }, {}, (error) => { result = error; });
  assert.equal(result.code, "INVALID_SESSION");
  assert.equal(result.status, 401);
});

test("appointment background jobs are registered in Shanghai time", () => {
  const jobs = [];
  let recycleCleanupRuns = 0;
  const module = { exports: {} };
  const noop = () => {};
  const deps = {
    "node-cron": { schedule: (...args) => jobs.push(args) },
    "./app": () => ({ listen: (port, callback) => { callback(); return {}; } }),
    "./config/env": {
      noShowCron: "*/5 * * * *", imageCleanupCron: "17 3 * * *", timezone: "Asia/Shanghai",
      recycleBinCleanupCron: "7 3 * * *",
    },
    "./config/db": {}, "./config/logger": { logger: { info: noop, error: noop } },
    "./services/noShowService": {}, "./services/alertService": {}, "./services/imageCleanupService": {},
    "./services/recycleBinCleanupService": { purgeExpired: async () => { recycleCleanupRuns += 1; } },
    "./services/logRotationService": { rotateLogsNow: noop },
    "./services/logRetentionService": { cleanupLogs: async () => ({}) }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8"), {
    module, require: (name) => deps[name], process: { on: noop }
  });
  assert.equal(jobs.length, 6);
  for (const expression of ["*/5 * * * *", "17 3 * * *", "7 3 * * *", "45 * * * *", "*/10 * * * *"]) {
    assert.equal(jobs.find((job) => job[0] === expression)[2].timezone, "Asia/Shanghai");
  }
  assert.equal(recycleCleanupRuns, 1);
  assert.equal(jobs.some((job) => job[0] === "* * * * *" || job[0] === "0 9 * * *"), false);
});
