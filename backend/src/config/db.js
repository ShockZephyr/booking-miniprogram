const { Pool, types } = require("pg");
const env = require("./env");

// PostgreSQL DATE is a calendar date, not midnight in the server's local zone.
types.setTypeParser(1082, (value) => value);

const pool = env.databaseUrl
  ? new Pool({
      connectionString: env.databaseUrl,
      max: 15,
      idleTimeoutMillis: 30000
    })
  : null;

const commitEffects = new WeakMap();

// File logs and counters must describe committed work. Database log inserts
// still use the business transaction and can fail/roll back with it.
function afterCommit(client, effect) {
  if (!client) return effect();
  if (!commitEffects.has(client)) commitEffects.set(client, []);
  commitEffects.get(client).push(effect);
}

function getExecutor(client) {
  return client || pool;
}

async function query(text, params = [], client) {
  if (!pool && !client) {
    throw new Error("Database pool is not configured.");
  }
  return getExecutor(client).query(text, params);
}

async function withTransaction(client, handler) {
  commitEffects.set(client, []);
  let result;
  let effects;
  try {
    await client.query("BEGIN");
    result = await handler(client);
    await client.query("COMMIT");
    effects = commitEffects.get(client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    commitEffects.delete(client);
  }
  for (const effect of effects) {
    try { effect(); }
    catch (error) {
      // The commit succeeded. A secondary sink failure must not tell the caller
      // to repeat a business operation which has already been saved.
      try { require("./logger").logger.error({ error }, "committed_log_output_failed"); } catch (_) {}
    }
  }
  return result;
}

async function transaction(handler) {
  const client = await pool.connect();
  try { return await withTransaction(client, handler); }
  finally { client.release(); }
}

async function ready() {
  await query("SELECT 1");
  return true;
}

async function close() {
  if (pool) {
    await pool.end();
  }
}

module.exports = {
  pool,
  query,
  transaction,
  withTransaction,
  afterCommit,
  ready,
  close
};
