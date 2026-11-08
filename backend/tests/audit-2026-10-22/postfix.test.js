// Requires the dedicated local audit database enforced by this helper.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withDatabase, cleanup } = require('../audit-2026-10-20/isolated');
test.after(cleanup);

async function waitForIdentityLock(pool) {
  for (let n = 0; n < 100; n++) {
    const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' LIMIT 1");
    if (result.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('request never reached the real identity lock');
}
async function snapshot(pool) {
  const data = {};
  // HTTP logs are expected to record rejected calls; business state must not change.
  for (const table of ['service_items', 'therapists', 'member_whitelist', 'weekly_schedules', 'schedule_days', 'schedule_settings', 'appointment_revisions',
    'appointments', 'notifications', 'audit_logs', 'business_logs']) {
    data[table] = (await pool.query(`SELECT * FROM ${table} AS item ORDER BY to_jsonb(item)::text`)).rows;
  }
  return JSON.stringify(data);
}
async function rejectQueued(fixture, operation, change, expected) {
  const { pool, api, admin, tokenFor } = fixture;
  const token = await tokenFor(admin), lock = await pool.connect();
  const before = await snapshot(pool);
  let pending;
  try {
    await lock.query('BEGIN'); await lock.query('SELECT pg_advisory_xact_lock(582302)');
    pending = api(operation.route, admin, operation.method, operation.body, token);
    await waitForIdentityLock(pool);
    await change(lock, admin.id);
    await lock.query('COMMIT');
    const result = await pending;
    assert.equal(result.status, expected.status, operation.route);
    assert.equal(result.body.code, expected.code, operation.route);
    assert.equal(await snapshot(pool), before, 'denied write must leave catalog, bookings, audits and outbox intact');
  } finally {
    await lock.query('ROLLBACK'); lock.release(); if (pending) await pending.catch(() => {});
  }
}

test('all catalog and whitelist writes reject queued revoked sessions; fresh administrators retain every operation', async () => {
  await withDatabase(async fixture => {
    const { pool, api, admin, customer, projects } = fixture;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
    const image = await require('../../src/services/therapistImageService').uploadBuffer(png);
    const project = { name: 'session regression project', durationMinutes: 60, effect: '', priceFen: 100, description: '', imageUrl: image.imageUrl };
    const therapist = { name: 'session regression therapist', phone: '13900000005', bio: '', serviceItemIds: [projects[0].id], imageUrl: image.imageUrl };
    let projectId, therapistId, memberId;
    async function allowed(operation) {
      const result = await api(operation.route, admin, operation.method, operation.body);
      assert.equal(result.status, 200, operation.route + ': ' + result.body.code);
      return result.body.data;
    }
    const operations = [
      async () => ({ method: 'POST', route: '/api/admin/projects', body: project, after: data => { projectId = data.item.id; } }),
      async () => ({ method: 'PATCH', route: '/api/admin/projects/' + projectId, body: { ...project, name: 'updated project' } }),
      async () => ({ method: 'PATCH', route: '/api/admin/projects/order', body: { ids: (await pool.query("SELECT id FROM service_items WHERE status='active' ORDER BY sort_order DESC, id")).rows.map(row => row.id) } }),
      async () => ({ method: 'DELETE', route: '/api/admin/projects/' + projectId }),
      async () => ({ method: 'PATCH', route: '/api/admin/projects/restore', body: { ids: [projectId] } }),
      async () => { await allowed({ method: 'DELETE', route: '/api/admin/projects/' + projectId }); return { method: 'POST', route: '/api/admin/projects/purge', body: { ids: [projectId] } }; },
      async () => ({ method: 'POST', route: '/api/admin/therapists', body: therapist, after: data => { therapistId = data.therapist.id; } }),
      async () => ({ method: 'PATCH', route: '/api/admin/therapists/' + therapistId, body: { ...therapist, bio: 'updated bio' } }),
      async () => ({ method: 'DELETE', route: '/api/admin/therapists/' + therapistId }),
      async () => ({ method: 'PATCH', route: '/api/admin/therapists/restore', body: { ids: [therapistId] } }),
      async () => { await allowed({ method: 'DELETE', route: '/api/admin/therapists/' + therapistId }); return { method: 'POST', route: '/api/admin/therapists/purge', body: { ids: [therapistId] } }; },
      async () => ({ method: 'POST', route: '/api/admin/whitelist', body: { phone: '13900000006', remarkName: 'session regression member' }, after: data => { memberId = data.item.id; } }),
      async () => ({ method: 'PATCH', route: '/api/admin/whitelist/' + memberId, body: { remarkName: 'updated member' } }),
      async () => ({ method: 'DELETE', route: '/api/admin/whitelist/' + memberId }),
      async () => { await allowed({ method: 'POST', route: '/api/admin/whitelist', body: { phone: '13900000006' } });
        const member = (await pool.query('SELECT id FROM member_whitelist WHERE phone=$1', [customer.phone])).rows[0];
        return { method: 'POST', route: '/api/admin/whitelist/batch-delete', body: { ids: [memberId, member.id] } }; }
    ];
    for (const build of operations) {
      const operation = await build();
      assert.equal((await api(operation.route, customer, operation.method, operation.body)).status, 403);
      await rejectQueued(fixture, operation, (client, id) => client.query(
        'UPDATE users SET session_version=session_version+1 WHERE id=$1', [id]
      ), { status: 401, code: 'INVALID_SESSION' });
      const result = await allowed(operation);
      if (operation.after) operation.after(result);
    }
    assert.equal((await pool.query('SELECT purged_at IS NOT NULL AS purged FROM service_items WHERE id=$1', [projectId])).rows[0].purged, true);
    assert.equal((await pool.query('SELECT purged_at IS NOT NULL AS purged FROM therapists WHERE id=$1', [therapistId])).rows[0].purged, true);
    assert.equal((await pool.query('SELECT status FROM member_whitelist WHERE id=$1', [memberId])).rows[0].status, 'inactive');
  });
});

test('catalog and whitelist transactions also recheck current administrator role after lock waits', async () => {
  await withDatabase(async fixture => {
    const { pool, admin, customer, therapistB, projects } = fixture;
    const member = (await pool.query('SELECT id FROM member_whitelist WHERE phone=$1', [customer.phone])).rows[0];
    for (const operation of [
      { method: 'PATCH', route: '/api/admin/projects/order', body: { ids: projects.map(item => item.id) } },
      { method: 'DELETE', route: '/api/admin/therapists/' + therapistB.id },
      { method: 'PATCH', route: '/api/admin/whitelist/' + member.id, body: { remarkName: 'denied' } }
    ]) {
      // Deliberately change only role to exercise role validation independently
      // from the normal role-change session-version bump.
      await rejectQueued(fixture, operation, (client, id) => client.query(
        "UPDATE users SET role='user' WHERE id=$1", [id]
      ), { status: 403, code: 'NOT_ADMIN' });
      await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
    }
  });
});

test('anonymous public metadata and catalog DTOs are identical and contain no therapist account information', async () => {
  await withDatabase(async ({ api, admin, therapistA, projects }) => {
    const request = require('supertest')(require('../../src/app')());
    for (const route of ['/api/meta/business', '/api/meta/service-items', '/api/projects',
      '/api/projects/' + projects[0].id, '/api/therapists', '/api/therapists/' + therapistA.id]) {
      const guest = await request.get(route), loggedIn = await api(route, admin);
      assert.equal(guest.status, 200); assert.equal(loggedIn.status, 200);
      assert.deepEqual(guest.body.data, loggedIn.body.data, route);
      if (route.startsWith('/api/therapists')) {
        const items = guest.body.data.therapists || [guest.body.data.therapist];
        for (const item of items) {
          assert.equal(item.phone, undefined); assert.equal(item.userId, undefined);
        }
      }
    }
    assert.equal((await request.get('/api/admin/therapists/' + therapistA.id)).status, 401);
    assert.equal((await request.get('/api/appointments/my')).status, 401);
  });
});
