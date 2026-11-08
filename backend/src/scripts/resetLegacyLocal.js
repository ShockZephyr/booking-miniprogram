const { Client } = require("pg");

const tables = ["notifications", "appointments", "appointment_slots", "member_whitelist",
  "therapists", "service_items", "business_logs", "audit_logs", "http_request_logs", "client_errors",
  "alerts", "image_cleanup_candidates", "users"];

function localTarget(url, expected, environment) {
  if (environment === "production") throw new Error("本工具只用于本地开发库");
  let target;
  try { target = new URL(url); } catch { throw new Error("请设置 LEGACY_LOCAL_DATABASE_URL"); }
  if (!["postgresql:", "postgres:"].includes(target.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.search ||
      !/^[a-z][a-z0-9_]*_(dev|test)$/.test(expected || "") || target.pathname !== "/" + expected) {
    throw new Error("只接受明确同名的本地 _dev 或 _test 数据库，连接地址不能包含额外参数");
  }
  return target.href;
}
async function resetLegacy(client, expected, apply) {
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  try {
    const { rows: [identity] } = await client.query("SELECT current_database() AS name, current_schema() AS schema");
    if (identity.name !== expected || !identity.schema) throw new Error("数据库目标不一致");
    const schema = client.escapeIdentifier(identity.schema);
    const qualified = tables.map(t => schema + "." + client.escapeIdentifier(t));
    await client.query("SET LOCAL lock_timeout = '5s'");
    if (apply) {
      await client.query("SELECT pg_advisory_xact_lock(582301)");
      await client.query("SELECT pg_advisory_xact_lock(582302)");
    }
    const { rows: [version] } = await client.query("SELECT to_regclass('weekly_schedules') AS current, to_regclass('image_cleanup_candidates') AS legacy");
    if (version.current || !version.legacy) throw new Error("仅接受迁移到014的旧预约库");
    const installed = await client.query("SELECT 1 FROM schema_migrations WHERE name='014_retire_subscription_notifications.sql'");
    if (!installed.rowCount) throw new Error("请先核对旧版本迁移记录");
    if (apply) await client.query("LOCK TABLE " + qualified.join(", ") + " IN ACCESS EXCLUSIVE MODE");
    const counts = {};
    for (let i = 0; i < tables.length; i++) {
      counts[tables[i]] = (await client.query("SELECT count(*)::text AS total FROM " + qualified[i])).rows[0].total;
    }
    if (apply) await client.query("TRUNCATE " + qualified.join(", ") + " RESTART IDENTITY");
    await client.query("COMMIT");
    return counts;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function main(args) {
  const expected = args[0], apply = args.length === 2 && args[1] === "--apply";
  if (!expected || (args.length !== 1 && !apply)) throw new Error("用法：node src/scripts/resetLegacyLocal.js <本地库名> [--apply]");
  const connectionString = localTarget(process.env.LEGACY_LOCAL_DATABASE_URL, expected, process.env.NODE_ENV);
  const client = new Client({ connectionString, options: "-c search_path=public", connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    const counts = await resetLegacy(client, expected, apply);
    console.log(apply ? "旧业务数据已清理，以下为清理前行数" : "预览旧业务数据行数", counts);
  } finally { await client.end(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
module.exports = { localTarget, resetLegacy };
