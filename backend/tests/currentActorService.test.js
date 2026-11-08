process.env.NODE_TEST_CONTEXT = '1';
process.env.DATABASE_URL = '';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCurrentActorService } = require('../src/services/currentActorService');

test('current actor rejects revoked sessions, removed bindings and roles after acquiring the identity lock', async () => {
  const before = { id: 'actor', role: 'admin', therapistId: 'assigned', sessionVersion: 1, sessionEpoch: 'epoch' };
  for (const [current, options, code] of [
    [null, {}, 'INVALID_SESSION'],
    [{ ...before, sessionVersion: 2 }, {}, 'INVALID_SESSION'],
    [{ ...before, sessionEpoch: 'new' }, {}, 'INVALID_SESSION'],
    [{ ...before, role: 'user' }, { admin: true }, 'NOT_ADMIN'],
    [{ ...before, therapistId: 'another' }, { therapistId: 'assigned' }, 'NOT_THERAPIST']
  ]) {
    const calls = [], client = {};
    const service = createCurrentActorService({
      acquireIdentityLock: async (tx) => { assert.equal(tx, client); calls.push('lock'); },
      userRepository: { findById: async (id, tx, lock) => {
        assert.equal(id, before.id); assert.equal(tx, client); assert.equal(lock, true);
        calls.push('user'); return current;
      } },
      accessService: { enrichUser: async (user, tx) => { assert.equal(tx, client); return user; } }
    });
    await assert.rejects(() => service.load({ user: before }, client, options), { code });
    assert.deepEqual(calls, ['lock', 'user']);
  }
});

test('current administrator/therapist remains allowed and database failures are not masked', async () => {
  const user = { id: 'actor', role: 'admin', therapistId: 'assigned', sessionVersion: 3, sessionEpoch: 'epoch' };
  const deps = { acquireIdentityLock: async () => {}, userRepository: { findById: async () => user },
    accessService: { enrichUser: async value => value } };
  const service = createCurrentActorService(deps);
  assert.deepEqual(await service.load({ user }, {}, { admin: true, therapistId: 'assigned' }), user);
  deps.userRepository.findById = async () => { throw new Error('database unavailable'); };
  await assert.rejects(() => service.load({ user }, {}), /database unavailable/);
});
