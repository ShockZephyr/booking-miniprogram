process.env.NODE_TEST_CONTEXT = "1";
process.env.DATABASE_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/config/db");
const service = require("../src/services/whitelistService");

const ID = "11111111-1111-4111-8111-111111111111";
const context = { user: { id: "admin" } };

test("whitelist rejects malformed member data, identifiers and filters before database access", async () => {
  const original = db.transaction;
  let writes = 0;
  db.transaction = async () => { writes += 1; throw new Error("Unexpected database access"); };
  try {
    for (const input of [null, [], {}, { phone:123 }, { phone:"" }, { phone:"invalid" },
      { phone:"13900000001", remarkName:{} }, { phone:"13900000001", status:"unknown" }]) {
      await assert.rejects(service.add(input, context), { status:400 });
    }
    for (const input of [null, [], { phone:"" }, { phone:123 }, { remarkName:[] }, { status:"all" }]) {
      await assert.rejects(service.update(ID, input, context), { status:400 });
    }
    await assert.rejects(service.update("invalid", {}, context), { status:404 });
    await assert.rejects(service.remove("invalid", context), { status:404 });
    for (const ids of [[], ["invalid"], [null]]) {
      await assert.rejects(service.batchRemove(ids, context), { status:400 });
    }
    await assert.rejects(service.list({ keyword:[] }), { status:400 });
    await assert.rejects(service.list({ status:"unknown" }), { status:400 });
    assert.equal(writes, 0);
  } finally { db.transaction = original; }
});
