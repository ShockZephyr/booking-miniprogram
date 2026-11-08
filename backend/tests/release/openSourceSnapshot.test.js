const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.join(__dirname, "../../..");

test("public snapshot uses only non-operational credentials and clearly fictional business examples", () => {
  const development = require("../../../miniprogram/config/development");
  const env = require("../../../miniprogram/config/env");
  const business = require("../../../miniprogram/config/business");
  const legal = require("../../../miniprogram/config/legal");
  const project = require("../../../project.config.json");
  assert.equal(development.ENABLE_LOCAL_DEBUG, false);
  assert.equal(new URL(env.API_BASE_URL).hostname, "api.example.invalid");
  assert.equal(project.appid, "wx0000000000000000");
  assert.equal(business.name, "示例预约馆");
  assert.equal(business.phone, "00000000000");
  assert.equal(business.address, "上海市黄浦区人民广场（示例地址）");
  assert.equal(business.latitude, 31.228827);
  assert.equal(business.longitude, 121.475213);
  assert.equal(legal.copyright, "Copyright © 2026 示例预约馆 版权所有");
  assert.equal(legal.organizer, "示例预约服务工作室（虚构主体）");
  assert.equal(legal.icpNumber, "沪ICP备XXXXXXXX号（示例）");
});

test("environment samples contain complete, matching examples and leave optional features disabled", () => {
  const dotenv = require("dotenv");
  const vm = require("node:vm");
  const business = require("../../../miniprogram/config/business");
  const legal = require("../../../miniprogram/config/legal");
  const fakeModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "backend/src/config/env.js"), "utf8"), {
    module: fakeModule, __dirname: path.join(root, "backend/src/config"),
    process: { env: { NODE_TEST_CONTEXT: "1" } },
    require: name => name === "dotenv" ? { config: () => ({}) } : name === "node-cron" ? { validate: () => true } : require(name)
  });
  const defaults = fakeModule.exports.business;
  for (const key of ["name", "phone", "address", "latitude", "longitude", "providerName"]) {
    assert.equal(defaults[key], business[key], key);
  }
  assert.equal(defaults.privacyOperator, legal.organizer);
  assert.equal(defaults.privacyContactPhone, business.phone);
  for (const name of [".env.example", ".env.production.example"]) {
    const sample = dotenv.parse(fs.readFileSync(path.join(root, "backend", name)));
    assert.deepEqual(Object.entries(sample).filter(([, value]) => value === ""), [], name);
    assert.equal(sample.BUSINESS_NAME, business.name);
    assert.equal(sample.BUSINESS_PHONE, business.phone);
    assert.equal(sample.BUSINESS_ADDRESS, business.address);
    assert.equal(Number(sample.BUSINESS_LATITUDE), business.latitude);
    assert.equal(Number(sample.BUSINESS_LONGITUDE), business.longitude);
    assert.equal(sample.PRIVACY_OPERATOR, legal.organizer);
    assert.equal(sample.PRIVACY_CONTACT_PHONE, business.phone);
    assert.equal(sample.WECHAT_APP_ID, "wx0000000000000000");
    assert.match(sample.WECHAT_APP_SECRET, /^REPLACE_/);
    assert.equal(sample.REVIEW_LOGIN_ENABLED, "false");
    assert.match(sample.REVIEW_LOGIN_CODE, /^REPLACE_/);
    assert.ok(Date.parse(sample.REVIEW_LOGIN_EXPIRES_AT) < Date.UTC(2020, 0, 1));
    assert.equal(sample.WECHAT_MOCK_ADMIN, "false");
    assert.equal(sample.WECHAT_MOCK_LOGIN, name === ".env.example" ? "true" : "false");
    assert.equal(sample.BACKUP_MIRROR_DIR, undefined, "mirror must remain opt-in");
  }
});

test("production release validation rejects public placeholder API and legal details", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "booking-public-config-"));
  const envFile = path.join(directory, "empty.env"); fs.writeFileSync(envFile, "");
  try {
    const result = spawnSync(process.execPath, ["src/scripts/checkProduction.js", "--release"], {
      cwd: path.join(root, "backend"), encoding: "utf8",
      env: { ...process.env, BOOKING_ENV_FILE: envFile, NODE_ENV: "production",
        DATABASE_URL: "postgres://unused:unused@127.0.0.1/unused", JWT_SECRET: randomBytes(32).toString("hex"),
        WECHAT_APP_ID: "synthetic-app-id", WECHAT_APP_SECRET: "synthetic-app-secret",
        WECHAT_MOCK_LOGIN: "false", WECHAT_MOCK_ADMIN: "false", REVIEW_LOGIN_ENABLED: "false",
        THERAPIST_UPLOAD_DIR: path.join(directory, "images"), LOG_DIR: path.join(directory, "logs"),
        LOG_RETENTION_DAYS: "186", BACKUP_DIR: path.join(directory, "backups"), TRUST_PROXY_HOPS: "1" }
    });
    assert.equal(result.status, 1);
    const errors = JSON.parse(result.stdout).errors;
    assert.ok(errors.includes("Set the real HTTPS API_BASE_URL."));
    assert.ok(errors.includes("Replace sample legal details; leave unissued registration fields empty."));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
