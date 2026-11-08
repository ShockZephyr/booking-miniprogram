const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {randomUUID} = require("node:crypto");
const {localTarget,resetLegacy} = require("../src/scripts/resetLegacyLocal");

test("explicit local cutover requires an exact development database and loopback connection", () => {
  const valid = "postgresql://127.0.0.1:5432/booking_dev";
  assert.equal(localTarget(valid, "booking_dev","development"),valid);
  for (const args of [[valid,"booking_dev","production"], [valid,"other_dev"], [valid.replace("127.0.0.1","example.test"),"booking_dev"],
    [valid+"?host=example.test","booking_dev"],[valid.replace("_dev","_prod"),"booking_prod"]]) {
    assert.throws(()=>localTarget(...args));
  }
});

test("014 preview, explicit empty-ledger cutover and 015 preflight use an isolated schema", {skip:process.env.RUN_DB_TESTS!=="1"},async()=>{
  const target=new URL(process.env.TEST_DATABASE_URL);
  assert.equal(target.hostname,"127.0.0.1"); assert.equal(target.port,"55483"); assert.equal(target.pathname,"/booking_audit");
  const {Client}=require("pg");
  const client=new Client({connectionString:target.href});
  const schema="cutover_"+randomUUID().replaceAll("-","");
  const directory=path.resolve(__dirname,"../migrations");
  const migration=name=>fs.readFileSync(path.join(directory,name),"utf8");
  await client.connect();
  try {
    await client.query("CREATE SCHEMA "+schema);
    await client.query("SET search_path TO "+schema+",public");
    await client.query("CREATE TABLE schema_migrations(name text primary key)");
    const names=fs.readdirSync(directory).filter(f=>f.endsWith(".sql")).sort();
    for (const file of names.filter(f=>f<"015")) {
      await client.query(migration(file)); await client.query("INSERT INTO schema_migrations VALUES($1)",[file]);
    }
    await client.query("INSERT INTO appointment_slots(date,start_time,end_time,service_item_ids) SELECT '2098-01-03','09:00','10:00',ARRAY[id] FROM service_items LIMIT 1");
    const sql=migration("015_weekly_schedules.sql");
    await assert.rejects(client.query(sql),/Legacy booking data present/);
    assert.equal((await resetLegacy(client,"booking_audit",false)).appointment_slots,"1");
    assert.equal((await resetLegacy(client,"booking_audit",true)).appointment_slots,"1");
    assert.equal((await resetLegacy(client,"booking_audit",true)).appointment_slots,"0");
    assert.equal((await client.query("SELECT 1 FROM schema_migrations")).rowCount,14);
    await client.query(sql);
    assert.equal((await client.query("SELECT days_visible FROM schedule_settings")).rows[0].days_visible,7);
    await assert.rejects(resetLegacy(client,"booking_audit",true),/仅接受/);
  } finally {
    try {await client.query("DROP SCHEMA "+schema+" CASCADE");} finally {await client.end();}
  }
});
