process.env.NODE_TEST_CONTEXT = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeCursor, decodeCursor } = require('../src/utils/cursor');
const id = '11111111-1111-4111-8111-111111111111';

test('cursor rejects impossible dates, invalid clock/offset and malformed payloads', () => {
  const invalid = [
    '2026-02-30 00:00:00+00', '2026-02-29 00:00:00Z', '2026-04-31 10:00:00+08',
    '0000-01-01 00:00:00Z', '2026-01-01 24:00:00Z', '2026-01-01 23:60:00Z',
    '2026-01-01 23:59:60Z', '2026-01-01 00:00:00+16', '2026-01-01 00:00:00+08:60',
    '2026-01-01 00:00:00', '2026-01-01 00:00:00.1234567Z'
  ];
  for (const kind of ['appointments', 'whitelist']) {
    for (const stamp of invalid) {
      const values = kind === 'appointments' ? ['2026-01-01', '09:00:00', stamp, id] : [stamp, id];
      assert.throws(() => decodeCursor(encodeCursor(kind, values), kind), { code: 'INVALID_CURSOR', status: 400 });
    }
    for (const cursor of ['not-json', '!', 'a'.repeat(1025), Buffer.from('null').toString('base64url')]) {
      assert.throws(() => decodeCursor(cursor, kind), { code: 'INVALID_CURSOR' });
    }
  }
});

test('cursor keeps valid leap days, PostgreSQL offsets and microseconds without precision loss', () => {
  for (const stamp of ['2024-02-29 23:59:59.123456+00', '2026-01-01T00:00:00Z',
    '2026-01-01 08:00:00+08', '2026-01-01 08:00:00+0800',
    '2026-01-01 00:00:00+15:59', '2026-01-01 00:00:00-15:59']) {
    const values = ['2024-02-29', '23:59:59', stamp, id];
    assert.deepEqual(decodeCursor(encodeCursor('appointments', values), 'appointments'), values);
    assert.deepEqual(decodeCursor(encodeCursor('whitelist', [stamp, id]), 'whitelist'), [stamp, id]);
  }
  assert.equal(decodeCursor('', 'appointments'), null);
});
