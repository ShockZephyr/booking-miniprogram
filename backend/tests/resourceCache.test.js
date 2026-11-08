const test = require("node:test");
const assert = require("node:assert/strict");
const cache = require("../../miniprogram/utils/resourceCache");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("resource cache deduplicates concurrent loads and reuses fresh data", async () => {
  const key = "test-deduplicate";
  const pending = deferred();
  let calls = 0;
  const loader = () => { calls += 1; return pending.promise; };

  const first = cache.get(key, loader, { ttl: 1000 });
  const second = cache.get(key, loader, { ttl: 1000 });
  assert.equal(first, second);
  assert.equal(calls, 0);

  await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve({ value: 1 });
  assert.deepEqual(await first, { value: 1 });
  assert.deepEqual(await cache.get(key, loader, { ttl: 1000 }), { value: 1 });
  assert.equal(calls, 1);
  cache.invalidate(key);
});

test("resource cache retries failures and supports explicit invalidation", async () => {
  const key = "test-retry";
  let calls = 0;
  const loader = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error("temporary")) : Promise.resolve(calls);
  };

  await assert.rejects(cache.get(key, loader), /temporary/);
  assert.equal(await cache.get(key, loader), 2);
  cache.invalidate(key);
  assert.equal(await cache.get(key, loader), 3);
  cache.invalidate(key);
});
