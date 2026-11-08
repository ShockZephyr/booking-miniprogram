// Regression coverage; use only synthetic data in the isolated local test database.
// Requires the guarded disposable PostgreSQL instance used by the audit helper.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { once } = require("node:events");
const isolated = require("../audit-2026-10-20/isolated");

test.after(() => isolated.cleanup());

test("logging review with synthetic data and real local HTTP/PostgreSQL", {
  skip: process.env.RUN_DB_TESTS !== "1"
}, async (t) => isolated.withDatabase(async (h) => {
  const logs = require("../../src/repositories/logRepository");
  const loggerModule = require("../../src/config/logger");
  const pause = () => new Promise(resolve => setTimeout(resolve, 20));
  async function rowsFor(id) {
    return (await h.pool.query("SELECT * FROM http_request_logs WHERE request_id=$1", [id])).rows;
  }
  async function waitForRow(id) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await rowsFor(id);
      if (rows.length) return rows;
      await pause();
    }
    assert.fail("HTTP request log was not persisted");
  }
  async function send(url, id, options = {}) {
    return fetch(h.origin + url, {
      ...options,
      headers: { "content-type": "application/json", "x-request-id": id, ...options.headers },
      signal: AbortSignal.timeout(5000)
    });
  }

  await t.test("health checks and early parser/auth failures each persist one request log", async () => {
    // db.ready closes over the production pool. Bind this probe to the helper's
    // isolated pool, just as the helper redirects repository queries.
    const ready = h.db.ready;
    h.db.ready = () => h.pool.query("SELECT 1");
    try {
      for (const endpoint of ["/health", "/health/ready"]) {
        const id = "review" + endpoint;
        assert.equal((await send(endpoint, id)).status, 200);
        assert.equal((await waitForRow(id)).length, 1);
      }
    } finally { h.db.ready = ready; }
    for (const [id, body, status] of [
      ["review-invalid-json", "{", 400],
      ["review-large-json", JSON.stringify({ message: "x".repeat(1024 * 1024) }), 413]
    ]) {
      const response = await send("/api/client-errors", id, { method: "POST", body });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("x-request-id"), id);
      assert.equal((await response.json()).requestId, id);
      assert.equal((await waitForRow(id))[0].status_code, status);
    }
    const response = await send("/api/admin/logs", "review-invalid-session", {
      headers: { authorization: "Bearer synthetic-invalid-token" }
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("x-request-id"), "review-invalid-session");
    assert.equal((await waitForRow("review-invalid-session"))[0].status_code, 401);
    const users = require("../../src/repositories/userRepository");
    const token = await h.tokenFor(h.admin);
    const find = users.findById;
    users.findById = async () => { throw new Error("Synthetic authentication database failure"); };
    try {
      const failed = await send("/api/admin/logs", "review-auth-db", { headers: { authorization: `Bearer ${token}` } });
      assert.equal(failed.status, 500);
      assert.equal((await waitForRow("review-auth-db"))[0].status_code, 500);
    } finally { users.findById = find; }
  });

  await t.test("aborted responses are recorded once even if a late finish follows", async () => {
    const middleware = require("../../src/middleware/requestLogger");
    const res = new EventEmitter();
    const id = "review-disconnected";
    middleware({ requestId: id, method: "GET", originalUrl: "/synthetic", get: () => "" }, res, () => {});
    assert.equal(res.listenerCount("finish"), 1);
    assert.equal(res.listenerCount("close"), 1);
    res.emit("close");
    res.emit("finish");
    const records = await waitForRow(id);
    assert.equal(records.length, 1);
    assert.equal(records[0].status_code, 499);
  });

  await t.test("only committed whitelist writes emit successful file events", async () => {
    const file = path.join(isolated.directory, "transaction-observation.log");
    const stream = require("pino").destination({ dest: file, sync: true });
    await once(stream, "ready");
    const writer = require("pino")({ base: null }, stream);
    const oldInfo = loggerModule.logger.info;
    const oldAudit = loggerModule.auditLogger.info;
    const createBusiness = logs.createBusiness;
    loggerModule.logger.info = writer.info.bind(writer);
    loggerModule.auditLogger.info = writer.info.bind(writer);
    logs.createBusiness = async (entry, client) => {
      const result = await createBusiness(entry, client);
      if (entry.action === "add_whitelist_member") await client.query("SELECT 1 / 0");
      return result;
    };
    try {
      const result = await h.api("/api/admin/whitelist", h.admin, "POST", {
        phone: "13900000999", remarkName: "Synthetic rollback member"
      });
      assert.equal(result.status, 500);
      const id = result.body.requestId;
      await waitForRow(id);
      for (const table of ["audit_logs", "business_logs"]) {
        assert.equal((await h.pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE request_id=$1`, [id])).rows[0].count, 0);
      }
      assert.equal((await h.pool.query("SELECT count(*)::int AS count FROM member_whitelist WHERE remark_name=$1", ["Synthetic rollback member"])).rows[0].count, 0);
      const records = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).filter(row => row.requestId === id);
      assert.equal(records.some(row => row.msg === "audit"), false);
      assert.equal(records.some(row => row.msg === "business_activity"), false);
      logs.createBusiness = createBusiness;
      const committed = await h.api("/api/admin/whitelist", h.admin, "POST", {
        phone: "13900000999", remarkName: "Synthetic committed member"
      });
      assert.equal(committed.status, 200);
      const saved = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(saved.filter(row => row.msg === "audit" && row.action === "add_whitelist_member").length, 1);
      assert.equal(saved.filter(row => row.msg === "business_activity" && row.result === "success").length, 1);
      const client = await h.pool.connect();
      try {
        const value = await h.db.withTransaction(client, async () => {
          h.db.afterCommit(client, () => { throw new Error("Synthetic sink failure"); });
          return "committed";
        });
        assert.equal(value, "committed");
      } finally { client.release(); }
    } finally {
      logs.createBusiness = createBusiness;
      loggerModule.logger.info = oldInfo;
      loggerModule.auditLogger.info = oldAudit;
      stream.end();
      await once(stream, "close");
    }
  });

  await t.test("bounded batches catch up expired logs and preserve current records", async () => {
    await h.pool.query(`INSERT INTO http_request_logs(request_id, method, path, status_code, duration_ms, created_at)
      SELECT 'review-expired-' || n, 'GET', '/health', 200, 1, now() - interval '200 days'
      FROM generate_series(1, 11520) n`);
    const deleted = await require("../../src/services/logRetentionService").cleanupLogs(h.db, 186);
    assert.equal(deleted.http_request_logs, 11520);
    const remaining = await h.pool.query("SELECT count(*)::int AS count FROM http_request_logs WHERE request_id LIKE 'review-expired-%'");
    assert.equal(remaining.rows[0].count, 0);
    assert.equal((await rowsFor("review/health")).length, 1);
    const indexes = (await h.pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename='http_request_logs'")).rows;
    assert.ok(indexes.some(index => index.indexdef.includes("created_at DESC, id DESC")));
    assert.ok(indexes.some(index => index.indexdef.includes("(request_id)")));
  });

  await t.test("a COMMIT failure drops queued effects before reusing the connection", async () => {
    const client = await h.pool.connect();
    const query = client.query;
    const emitted = [];
    let failCommit = true;
    client.query = function (sql, ...args) {
      if (sql === "COMMIT" && failCommit) throw new Error("Synthetic COMMIT failure");
      return query.call(this, sql, ...args);
    };
    try {
      await assert.rejects(h.db.withTransaction(client, async () => {
        h.db.afterCommit(client, () => emitted.push("rolled-back"));
      }), /COMMIT failure/);
      assert.deepEqual(emitted, []);
      failCommit = false;
      await h.db.withTransaction(client, async () => h.db.afterCommit(client, () => emitted.push("committed")));
      assert.deepEqual(emitted, ["committed"]);
    } finally { client.query = query; client.release(); }
  });

  await t.test("client errors redact secrets, bound fields and retain source correlation", async () => {
    const marker = "SYNTHETIC_PRIVATE_MARKER";
    const response = await send("/api/client-errors", "review-client-privacy", {
      method: "POST",
      body: JSON.stringify({ message: "synthetic", stack: "x".repeat(64 * 1024), sourceRequestId: "review-origin",
        systemInfo: { platform: "synthetic", token: marker, openid: marker, access_token: marker } })
    });
    assert.equal(response.status, 200);
    const row = (await h.pool.query("SELECT system_info, stack FROM client_errors WHERE request_id=$1", ["review-client-privacy"])).rows[0];
    assert.equal(row.system_info.token, undefined);
    assert.equal(row.system_info.openid, undefined);
    assert.equal(row.system_info.access_token, undefined);
    assert.equal(row.system_info.platform, "synthetic");
    assert.equal(row.stack.length, 8192);
    const sanitize = require("../../src/utils/privacy").sanitizeLogPayload;
    assert.equal(sanitize({ token: marker }).token, "***");
    assert.equal(sanitize({ access_token: marker }).access_token, "***");
    assert.equal(sanitize({ session_key: marker }).session_key, "***");
    assert.ok(!sanitize(`https://example.invalid/?access_token=${marker}`).includes(marker));
    const related = await logs.queryLogs({ source: "client", requestId: "review-origin" });
    assert.equal(related[0].request_id, "review-client-privacy");
    assert.equal(related[0].source_request_id, "review-origin");
    const invalid = await send("/api/client-errors", "review-invalid-fields", { method: "POST", body: JSON.stringify({ message: {} }) });
    assert.equal(invalid.status, 400);
    const alert = await require("../../src/repositories/alertRepository").create({
      type: "synthetic", message: `token=${marker}`, metadata: { access_token: marker }
    });
    assert.equal(alert.metadata.access_token, "***");
    assert.ok(!alert.message.includes(marker));
  });

  await t.test("log lookup searches all sources, paginates without gaps and rejects invalid filters", async () => {
    const audits = require("../../src/repositories/auditLogRepository");
    await audits.create({ adminUserId: h.admin.id, action: "synthetic_admin_change", resourceType: "schedule", requestId: "review-audit-only" });
    assert.equal((await logs.queryLogs({ requestId: "review-audit-only" }))[0].source, "audit");
    assert.equal((await logs.queryLogs({ source: "audit", requestId: "review-audit-only" })).length, 1);
    await h.pool.query(`INSERT INTO business_logs(action,result,request_id)
      SELECT 'synthetic_review', 'success', 'review-many-' || n FROM generate_series(1,205) n`);
    assert.equal((await logs.queryLogs({ action: "synthetic_review" })).length, 200);
    const first = await logs.queryLogPage({ action: "synthetic_review" });
    assert.equal(first.hasMore, true);
    const second = await logs.queryLogPage({ action: "synthetic_review", cursor: first.nextCursor });
    assert.equal(second.logs.length, 5);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.logs, ...second.logs].map(row => row.id)).size, 205);
    // Independent expected calendar boundaries, including PostgreSQL microseconds.
    await h.pool.query(`INSERT INTO business_logs(action,result,request_id,created_at) VALUES
      ('synthetic_date', 'success', 'before', '2030-01-01 23:59:59.999999+08'),
      ('synthetic_date', 'success', 'inside', '2030-01-02 23:59:59.999999+08'),
      ('synthetic_date', 'success', 'after', '2030-01-03 00:00:00+08')`);
    const day = await logs.queryLogs({ source: "business", action: "synthetic_date", from: "2030-01-02", to: "2030-01-02" });
    assert.deepEqual(day.map(row => row.request_id), ["inside"]);
    const invalid = await h.api("/api/admin/logs?userId=not-a-uuid", h.admin);
    assert.equal(invalid.status, 400);
    for (const query of ["source=missing", "from=2030-02-30", "cursor=invalid", "limit=201", "from[]=2030-01-01"]) {
      assert.equal((await h.api(`/api/admin/logs?${query}`, h.admin)).status, 400);
    }
    const anonymous = await send("/api/admin/logs", "review-anonymous");
    assert.equal(anonymous.status, 401);
    assert.equal((await h.api("/api/admin/logs", h.customer)).status, 403);
    assert.equal((await h.api("/api/admin/logs", h.staff)).status, 403);
    assert.equal((await h.api("/api/admin/logs", h.admin)).status, 200);
  });

  await t.test("regular writes across midnight rotate once and persist the new date", () => {
    const directory = path.join(isolated.directory, "midnight-rotation");
    fs.mkdirSync(directory);
    const file = path.join(directory, "application.log");
    fs.writeFileSync(file, JSON.stringify({ time: "2030-01-01T15:59:59Z", msg: "previous-day-entry" }) + "\n");
    const modified = new Date("2030-01-01T16:00:01Z");
    const now = new Date("2030-01-01T16:10:00Z");
    fs.utimesSync(file, modified, modified);
    const rotate = require("../../src/services/logRotationService").rotateLogsNow;
    rotate({ directory, destinations: new Map(), now, maxBytes: 10485760, retentionDays: 186 });
    assert.equal(fs.readdirSync(directory).filter(name => name.startsWith("application.log.")).length, 1);
    fs.writeFileSync(file, "current-day-entry\n");
    rotate({ directory, destinations: new Map(), now, maxBytes: 10485760, retentionDays: 186 });
    assert.equal(fs.readdirSync(directory).filter(name => name.startsWith("application.log.")).length, 1);
  });
}));

test("frontend error reporting preserves the requestId as sourceRequestId", async () => {
  const sent = [];
  let app;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../../miniprogram/app.js"), "utf8"), {
    App: definition => { app = definition; },
    getCurrentPages: () => [{ route: "pages/booking/index" }],
    wx: { getSystemInfoSync: () => ({ platform: "synthetic" }) },
    require: name => name === "./services/clientError" ? { report: async payload => sent.push(payload) } : {}
  });
  app.onUnhandledRejection({ reason: { message: "synthetic failed API", requestId: "review-original-api", code: "REQUEST_FAILED" } });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message, "synthetic failed API");
  assert.equal(sent[0].requestId, undefined);
  assert.equal(sent[0].sourceRequestId, "review-original-api");
});

test("dashboard log search escapes content and ignores older responses", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../../public/dashboard/index.html"), "utf8");
  const elements = new Map();
  const element = key => {
    if (!elements.has(key)) elements.set(key, { value: "", innerHTML: "", textContent: "", disabled: true });
    return elements.get(key);
  };
  let token = "";
  const pending = [];
  vm.runInNewContext(html.split("<script>")[1].split("</script>")[0], {
    document: { querySelector: element },
    localStorage: { getItem: () => token, setItem: (_, value) => { token = value; } },
    URLSearchParams, FormData: class { [Symbol.iterator]() { return [["source", "all"]][Symbol.iterator](); } },
    fetch: () => new Promise(resolve => pending.push(resolve)), setInterval() {}
  });
  token = "synthetic-token";
  const submit = () => element("#log-filters").onsubmit({ preventDefault() {} });
  submit(); submit();
  const result = requestId => ({ json: async () => ({ success: true, data: {
    logs: [{ source: "client", request_id: requestId, metadata: { message: '<img src=x onerror="bad()">' } }],
    hasMore: false, nextCursor: null
  } }) });
  pending[1](result("latest"));
  await new Promise(resolve => setImmediate(resolve));
  pending[0](result("older"));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(element("#log-results").innerHTML, /latest/);
  assert.doesNotMatch(element("#log-results").innerHTML, /older|<img/);
  assert.match(element("#log-results").innerHTML, /&lt;img/);
  assert.equal(element("#log-next").disabled, true);
});
