process.env.NODE_TEST_CONTEXT = "1";
process.env.DATABASE_URL = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { createWechatClient } = require("../src/services/wechatClient");
const backup = require("../src/services/backupService");

test("production startup rejects mock login, placeholder secrets and release-local storage", () => {
  const base = { ...process.env, NODE_ENV: "production", BOOKING_ENV_FILE: "", JWT_SECRET: "a".repeat(64),
    DATABASE_URL: "postgres://unused:unused@localhost/unused", WECHAT_MOCK_LOGIN: "false", WECHAT_MOCK_ADMIN: "false",
    WECHAT_APP_ID: "wx-production-id", WECHAT_APP_SECRET: "nonempty", LOG_RETENTION_DAYS: "186",
    LOG_DIR: path.join(os.tmpdir(), "booking-prod-logs"), THERAPIST_UPLOAD_DIR: path.join(os.tmpdir(), "booking-prod-images"),
    TRUST_PROXY_HOPS: "1", REVIEW_LOGIN_ENABLED: "false", REVIEW_LOGIN_CODE: "", REVIEW_LOGIN_EXPIRES_AT: "" };
  const run = (extra) => spawnSync(process.execPath, ["-e", "require('./src/config/env')"], { cwd: path.join(__dirname, ".."), env: { ...base, ...extra }, encoding: "utf8" });
  assert.equal(run({}).status, 0);
  assert.equal(run({ REVIEW_LOGIN_ENABLED: "false", REVIEW_LOGIN_CODE: "REPLACE_WITH_PRIVATE_RANDOM_REVIEW_CODE",
    REVIEW_LOGIN_EXPIRES_AT: "2000-01-01T00:00:00+08:00" }).status, 0);
  assert.equal(run({ REVIEW_LOGIN_ENABLED: "true", REVIEW_LOGIN_CODE: "r".repeat(64),
    REVIEW_LOGIN_EXPIRES_AT: "2030-01-01T00:00:00+08:00" }).status, 0);
  for (const extra of [
    { REVIEW_LOGIN_ENABLED: "true" },
    { REVIEW_LOGIN_ENABLED: "true", REVIEW_LOGIN_CODE: "short", REVIEW_LOGIN_EXPIRES_AT: "2030-01-01T00:00:00Z" },
    { REVIEW_LOGIN_ENABLED: "true", REVIEW_LOGIN_CODE: "REPLACE_WITH_PRIVATE_RANDOM_REVIEW_CODE",
      REVIEW_LOGIN_EXPIRES_AT: "2030-01-01T00:00:00+08:00" },
    { REVIEW_LOGIN_ENABLED: "true", REVIEW_LOGIN_CODE: "r".repeat(64), REVIEW_LOGIN_EXPIRES_AT: "2030-01-01 00:00:00" }
  ]) assert.notEqual(run(extra).status, 0);
  for (const extra of [{ WECHAT_MOCK_LOGIN: "true" }, { WECHAT_MOCK_ADMIN: "true" }, { JWT_SECRET: "replace-with-a-long-random-secret" },
    { THERAPIST_UPLOAD_DIR: path.join(__dirname, "../uploads") }, { LOG_RETENTION_DAYS: "21" }, { NO_SHOW_CRON: "invalid" },
    { TRUST_PROXY_HOPS: "6" }, { WECHAT_APP_ID: "wx0000000000000000" },
    { WECHAT_APP_SECRET: "REPLACE_WITH_YOUR_WECHAT_APP_SECRET" }]) {
    assert.notEqual(run(extra).status, 0);
  }
});

test("release and trial clients cannot use development login controls", async () => {
  const source = await fs.readFile(path.join(__dirname, "../../miniprogram/utils/runtime.js"), "utf8");
  for (const envVersion of ["release", "trial", "develop", undefined]) {
    const module = { exports: {} };
    for (const local of [false, true]) for (const platform of ["devtools", "ios", "android"]) {
      vm.runInNewContext(source, { module, require: () => ({ ENABLE_LOCAL_DEBUG: local }), wx: {
        getDeviceInfo: () => ({ platform }), getAccountInfoSync: () => ({ miniProgram: { envVersion } }) } });
      assert.equal(module.exports.canUseTestLogin(), local && platform === "devtools" && envVersion === "develop");
    }
  }
});

test("WeChat failures and timeouts are bounded and never expose credential-bearing URLs", async () => {
  const client = createWechatClient({ wechat: { appId: "id", appSecret: "SECRET", requestTimeoutMs: 15 } });
  await assert.rejects(client.requestJson("https://example.invalid/?secret=SECRET", {}, async (url) => { throw new Error(url); }),
    (error) => error.status === 503 && error.message === "登录服务暂不可用，请稍后重试" && !error.message.includes("SECRET"));
  await assert.rejects(client.requestJson("https://example.invalid", {}, (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  })), { code: "WECHAT_UNAVAILABLE", status: 503 });
  await assert.rejects(client.requestJson("https://example.invalid", { deadline: Date.now() - 1 }, async () => assert.fail()), { status: 503 });
  const unconfigured = createWechatClient({ wechat: { appId: "", appSecret: "" } });
  await assert.rejects(unconfigured.getAccessToken(), {
    code: "WECHAT_NOT_CONFIGURED", status: 503, message: "登录服务暂不可用，请联系门店"
  });
});

test("simultaneous phone authorization token requests share one refresh and expire correctly", async () => {
  let count = 0;
  const client = createWechatClient({ wechat: { appId: "id", appSecret: "secret", requestTimeoutMs: 100 } });
  const fetch = async () => { count += 1; return { ok: true, json: async () => ({ access_token: `token-${count}`, expires_in: 7200 }) }; };
  const tokens = await Promise.all([client.getAccessToken({ fetch }), client.getAccessToken({ fetch })]);
  assert.deepEqual(tokens, ["token-1", "token-1"]);
  assert.equal(count, 1);
  assert.equal(await client.getAccessToken({ fetch }), "token-1");
  assert.equal(await client.getAccessToken({ fetch, force: true }), "token-2");
});

test("backup validation detects tampering and protects arbitrary files during retention cleanup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "booking-backup-test-"));
  t.after(async () => { assert.ok(root.startsWith(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const name = "booking-2026-01-01T00-00-00-000Z-12345678";
  const directory = path.join(root, name);
  await fs.mkdir(path.join(directory, "images"), { recursive: true });
  await fs.writeFile(path.join(directory, "database.dump"), "dump data");
  await fs.writeFile(path.join(directory, "images", "1234.png"), "image data");
  const manifest = { format: backup.FORMAT, createdAt: "2026-01-01T00:00:00Z", sourceDatabase: "booking",
    database: await backup.fingerprint(path.join(directory, "database.dump")),
    images: [{ name: "1234.png", ...await backup.fingerprint(path.join(directory, "images", "1234.png")) }] };
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  assert.equal((await backup.verifyBackup(directory)).images.length, 1);
  await fs.writeFile(path.join(directory, "images", "1234.png"), "tampered");
  await assert.rejects(backup.verifyBackup(directory), /checksum mismatch/);
  assert.equal(await backup.pruneBackups(root, 14), 0);
  await fs.writeFile(path.join(directory, "images", "1234.png"), "image data");
  await fs.writeFile(path.join(directory, "unrelated.txt"), "leave this alone");
  assert.equal(await backup.pruneBackups(root, 14), 0);
  await fs.unlink(path.join(directory, "unrelated.txt"));
  assert.equal(await backup.pruneBackups(root, 14), 1);
  await assert.rejects(backup.restore({ directory, confirmEmptyTarget: false }), /confirm-empty-target/);
});

test("image migration preserves the source and refuses different existing target images", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "booking-image-copy-test-"));
  t.after(async () => { assert.ok(root.startsWith(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source"), target = path.join(root, "target");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "1234.png"), "original");
  assert.equal((await backup.copyImages(source, target)).length, 1);
  assert.equal(await fs.readFile(path.join(source, "1234.png"), "utf8"), "original");
  await fs.writeFile(path.join(target, "1234.png"), "different");
  await assert.rejects(backup.copyImages(source, target), /verification failed/);
  await assert.rejects(backup.copyImages(source, path.join(source, "nested")), /overlap/);
});

test("log rotation reopens the active writer and keeps new entries out of the archived file", async (t) => {
  const pino = require("pino");
  const { rotateLogsNow } = require("../src/services/logRotationService");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "booking-log-rotation-test-"));
  const stream = pino.destination(path.join(directory, "application.log"));
  t.after(async () => { stream.end(); await once(stream, "close"); assert.ok(directory.startsWith(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  await once(stream, "ready");
  stream.write("before\n"); stream.flushSync();
  const reopened = process.platform === "win32" ? Promise.resolve() : once(stream, "ready");
  rotateLogsNow({ directory, destinations: new Map([["application.log", stream]]), maxBytes: 1, now: new Date() });
  await reopened;
  stream.write("after\n"); stream.flushSync();
  const archive = (await fs.readdir(directory)).find((name) => name.startsWith("application.log."));
  assert.equal(await fs.readFile(path.join(directory, archive), "utf8"), "before\n");
  assert.equal(await fs.readFile(path.join(directory, "application.log"), "utf8"), "after\n");
});
