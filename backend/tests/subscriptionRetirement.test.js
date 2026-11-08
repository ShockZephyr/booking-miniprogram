const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// No application env or services are loaded: the only connection is an explicitly
// supplied local test database, and all writes stay in this run's temporary schema.
test("retirement preserves history, stops every unfinished job and is idempotent", {
  skip: process.env.RUN_DB_TESTS !== "1"
}, async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, "TEST_DATABASE_URL must explicitly identify an isolated test database");
  const target = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only local PostgreSQL is allowed");
  assert.match(decodeURIComponent(target.pathname), /test|audit|e2e/i, "use a dedicated test database");
  const { Pool } = require("pg");
  const schema = "booking_test_" + randomUUID().replaceAll("-", "");
  assert.match(schema, /^booking_test_[a-f0-9]{32}$/);
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000,
    options: "-c search_path=" + schema + ",public" });
  let created = false;
  try {
    await pool.query("CREATE SCHEMA " + schema);
    created = true;
    await pool.query("SET search_path TO " + schema + ",public");
    const directory = path.join(__dirname, "../migrations");
    const retirement = "014_retire_subscription_notifications.sql";
    for (const file of fs.readdirSync(directory).filter((name) => name.endsWith(".sql") && name < retirement).sort()) {
      await pool.query(fs.readFileSync(path.join(directory, file), "utf8"));
    }
    const states = ["pending", "sending", "failed", "sent", "skipped"];
    for (const state of states) {
      await pool.query(
        "INSERT INTO notifications(type,title,content,template_id,template_data,delivery_status,last_error,sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        ["fixture_" + state, "合成通知", "历史内容", "synthetic-template", { thing1: { value: "测试" } },
          state, "previous_" + state, state === "sent" ? "2026-01-01T00:00:00Z" : null]
      );
    }
    const before = (await pool.query("SELECT * FROM notifications ORDER BY type")).rows;
    const migration = fs.readFileSync(path.join(directory, retirement), "utf8");
    await pool.query("BEGIN");
    await pool.query(migration);
    await pool.query("COMMIT");
    const after = (await pool.query("SELECT * FROM notifications ORDER BY type")).rows;
    assert.equal(after.length, before.length);
    for (let index = 0; index < before.length; index += 1) {
      const original = before[index], actual = after[index];
      if (["pending", "sending", "failed"].includes(original.delivery_status)) {
        assert.deepEqual(actual, { ...original, delivery_status: "skipped",
          last_error: "subscription_notifications_removed", updated_at: actual.updated_at });
      } else assert.deepEqual(actual, original);
    }
    await pool.query(migration);
    assert.deepEqual((await pool.query("SELECT * FROM notifications ORDER BY type")).rows, after);
  } finally {
    try {
      if (created) {
        await pool.query("ROLLBACK");
        await pool.query("SET search_path TO public");
        await pool.query("DROP SCHEMA " + schema + " CASCADE");
      }
    } finally { await pool.end(); }
  }
});
