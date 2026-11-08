// Regression coverage; use only synthetic data in the isolated local test database.
// Reuses a helper which refuses every database except the dedicated localhost audit cluster.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { withDatabase, cleanup } = require('../audit-2026-10-20/isolated');
test.after(cleanup);

test('A1 browser regression: stored client errors are visible text, never executable HTML', { skip: !process.env.AUDIT_CHROME }, async () => {
  await withDatabase(async ({ admin, tokenFor }) => {
    const app = require('express')();
    const token = await tokenFor(admin);
    const original = fs.readFileSync(path.join(__dirname, '../../public/dashboard/index.html'), 'utf8');
    app.get('/dashboard', (req, res) => res.type('html').send(original.replace('<script>',
      '<script>localStorage.setItem("booking_dashboard_token",' + JSON.stringify(token) + ');</script><script>')));
    app.use(require('../../src/app')());
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-audit-chrome-'));
    try {
      const base = 'http://127.0.0.1:' + server.address().port;
      const inserted = await fetch(base + '/api/client-errors', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '<img src="missing-audit-image" onerror="document.body.dataset.auditMarker=1">' }) });
      assert.equal(inserted.status, 200);
      const { stdout } = await promisify(execFile)(process.env.AUDIT_CHROME, [
        '--headless=new', '--no-first-run', '--disable-background-networking', '--disable-default-apps',
        '--disable-extensions', '--disable-sync', '--metrics-recording-only', '--no-default-browser-check',
        '--user-data-dir=' + profile, '--dump-dom', '--virtual-time-budget=6000', base + '/dashboard'
      ], { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true });
      assert.doesNotMatch(stdout, /<body[^>]*data-audit-marker="1"/);
      assert.match(stdout, /&lt;img src="missing-audit-image"/, 'the loaded error is still displayed as text');
      assert.doesNotMatch(stdout, /<img src="missing-audit-image"/);
    } finally {
      await new Promise(resolve => server.close(resolve));
      assert.equal(path.dirname(profile), os.tmpdir());
      assert.ok(path.basename(profile).startsWith('booking-audit-chrome-'));
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

test('A1 regression: client errors stay readable and all dashboard HTML outputs are escaped', async () => {
  await withDatabase(async ({ pool }) => {
    // Harmless local marker only; no secret read, no network or external target.
    const payload = '<img src="missing-audit-image" onerror="document.body.dataset.auditMarker=1">';
    const response = await require('supertest')(require('../../src/app')())
      .post('/api/client-errors').send({ page: 'audit', message: payload });
    assert.equal(response.status, 200);
    const saved = (await pool.query('SELECT message FROM client_errors')).rows;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].message, payload);
    const html = fs.readFileSync(path.join(__dirname, '../../public/dashboard/index.html'), 'utf8');
    const rendering = html.slice(html.indexOf('function escapeHtml'), html.indexOf('async function load'));
    const rendered = vm.runInNewContext(rendering + '; rows(items, ["message"])', { items: saved });
    assert.ok(!rendered.includes(payload));
    assert.ok(rendered.includes('&lt;img'));
    const card = vm.runInNewContext(rendering + '; card(label, value)', { label: '<script>', value: `&<>"'` });
    assert.ok(card.includes('&lt;script&gt;'));
    assert.ok(card.includes('&amp;&lt;&gt;&quot;&#39;'));
    assert.match(vm.runInNewContext(rendering + '; rows([{n:0}], ["n"])'), /<td>0<\/td>/);
    assert.equal((await pool.query('SELECT user_id FROM client_errors')).rows[0].user_id, null);
  });
});

test('A2 regression: therapist list waiting during transfer cannot return former clients', async () => {
  await withDatabase(async ({ api, db, pool, tokenFor, admin, staff, other, therapistB, bookingTime, addAppointment }) => {
    const booking = await addAppointment(bookingTime({ therapist: therapistB }), { status: 'no_show' });
    const token = await tokenFor(staff);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
    const image = await require('../../src/services/therapistImageService').uploadBuffer(png);
    const original = db.query;
    let arrived, release, pauseOnce = true;
    const paused = new Promise(resolve => { arrived = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    db.query = async (...args) => {
      const result = await original(...args);
      if (pauseOnce && /pg_advisory_xact_lock/.test(args[0])) { pauseOnce = false; arrived(); await resume; }
      return result;
    };
    let transfer, request;
    try {
      transfer = require('../../src/services/therapistService').save(therapistB.id, {
        name: therapistB.name, phone: other.phone, bio: 'audit transfer', imageUrl: image.imageUrl
      }, { user: admin, requestId: 'audit-read-transfer' });
      await paused;
      request = api('/api/therapist/appointments?status=pending', staff, 'GET', undefined, token);
      for (let n = 0; n < 100; n++) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' LIMIT 1");
        if (waiting.rowCount) break;
        if (n === 99) assert.fail('request never reached the real database lock');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      release(); await transfer;
      const response = await request;
      assert.equal(response.status, 401);
      assert.equal(response.body.code, 'INVALID_SESSION');
      assert.ok(!JSON.stringify(response.body).includes(booking.id));
      assert.equal((await api('/api/auth/me', staff, 'GET', undefined, token)).status, 401);
      const assigned = await api('/api/therapist/appointments?status=pending', other);
      assert.equal(assigned.status, 200);
      assert.ok(assigned.body.data.appointments.some(item => item.id === booking.id));
    } finally { release(); db.query = original; await Promise.allSettled([transfer, request].filter(Boolean)); }
  });
});

test('A3 regression: all identities reject malformed date cursors and accept valid neighbors', async () => {
  await withDatabase(async ({ api, admin, customer, staff, bookingTime, addAppointment }) => {
    const booking = await addAppointment(bookingTime(), { status: 'cancelled' });
    const cursor = (stamp) => Buffer.from(JSON.stringify(['appointments', '2020-01-01', '09:00:00', stamp, booking.id])).toString('base64url');
    for (const [route, actor] of [['/api/admin/appointments', admin], ['/api/appointments/my', customer], ['/api/therapist/appointments', staff]]) {
      const invalid = await api(route + '?cursor=' + cursor('2026-02-30 00:00:00+00'), actor);
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.code, 'INVALID_CURSOR');
      assert.equal((await api(route + '?cursor=' + cursor('2026-02-28 00:00:00+00'), actor)).status, 200);
    }
    for (const [stamp, status] of [['2026-02-30 00:00:00+00', 400], ['2024-02-29 00:00:00.123456+08', 200]]) {
      const value = Buffer.from(JSON.stringify(['whitelist', stamp, booking.id])).toString('base64url');
      assert.equal((await api('/api/admin/whitelist?cursor=' + value, admin)).status, status);
    }
  });
});

test('A4 regression: Shanghai early-morning counters are independent of database timezone', async () => {
  await withDatabase(async ({ pool, bookingTime, addAppointment, db }) => {
    const booking = await addAppointment(bookingTime(), { status: 'cancelled' });
    const original = db.query;
    const client = await pool.connect();
    try {
      db.query = (sql, params = [], supplied) => (supplied || client).query(sql, params);
      for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
        await client.query("SELECT set_config('TimeZone',$1,false)", [timezone]);
        for (const seconds of [-1, 0, 28799]) {
          const stamp = "(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') + $2::int * interval '1 second') AT TIME ZONE 'Asia/Shanghai'";
          await client.query(`UPDATE appointments SET created_at=${stamp},cancelled_at=${stamp},checked_in_at=${stamp},no_show_at=${stamp} WHERE id=$1`, [booking.id, seconds]);
          const actual = await require('../../src/services/dashboardService').summary();
          for (const key of ['todayAppointments', 'todayCancelled', 'todayCheckedIn', 'todayNoShow']) {
            assert.equal(actual[key], seconds < 0 ? 0 : 1, `${timezone}: ${key} at midnight offset ${seconds}`);
          }
        }
      }
    } finally { db.query = original; client.release(); }
  });
});

test('A2 regression: queued weekly schedule change rolls back after administrator session is revoked', async () => {
  await withDatabase(async ({ api, pool, tokenFor, admin, therapistA, projects }) => {
    const token = await tokenFor(admin);
    const input = { therapistIds: [therapistA.id], weekdays: [1], schedule: { step: 30, minDuration: 90, ranges: [{ startTime: '09:00', endTime: '19:00' }] }, serviceItemIds: [projects[0].id] };
    const lock = await pool.connect();
    let request;
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT pg_advisory_xact_lock(582302)');
      request = api('/api/admin/schedules/weekly', admin, 'PUT', input, token);
      for (let n = 0; n < 100; n++) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' LIMIT 1");
        if (waiting.rowCount) break;
        if (n === 99) assert.fail('weekly schedule change never reached the database lock');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      // Same SQL as logout; committed before the waiting mutation resumes.
      await lock.query('UPDATE users SET session_version=session_version+1 WHERE id=$1', [admin.id]);
      await lock.query('COMMIT');
      assert.equal((await request).status, 401);
      assert.equal((await api('/api/auth/me', admin, 'GET', undefined, token)).status, 401);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM weekly_schedules')).rows[0].count, 0);
      const fresh = await api('/api/admin/schedules/weekly', admin, 'PUT', input);
      assert.equal(fresh.status, 200);
    } finally { await lock.query('ROLLBACK'); lock.release(); if (request) await request.catch(() => {}); }
  });
});

test('A6 HTTP evidence: a revoked bearer rejects public catalogs while anonymous reads succeed', async () => {
  await withDatabase(async ({ pool, tokenFor, customer }) => {
    const token = await tokenFor(customer);
    await pool.query('UPDATE users SET session_version=session_version+1 WHERE id=$1', [customer.id]);
    const request = require('supertest')(require('../../src/app')());
    for (const route of ['/api/projects', '/api/therapists']) {
      assert.equal((await request.get(route).set('authorization', 'Bearer ' + token)).status, 401);
      assert.equal((await request.get(route)).status, 200);
    }
  });
});

async function waitForIdentityWait(pool) {
  for (let n = 0; n < 100; n++) {
    const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' LIMIT 1");
    if (waiting.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('request did not wait at the real identity lock');
}

test('A2 every admin schedule mutation rejects a session revoked while waiting, without partial changes', async () => {
  await withDatabase(async ({ pool, api, tokenFor, admin, therapistA, therapistB, projects, tomorrow, configureWeek, addAppointment }) => {
    const time = await configureWeek();
    await addAppointment(time);
    const weekly = { therapistIds: [therapistA.id,therapistB.id], weekdays: [1,2] };
    const scenarios = [
      ['PUT', '/api/admin/schedules/weekly', { ...weekly, schedule: { step: 15, minDuration: 60, ranges: [{ startTime: '10:00', endTime: '15:00' }] } }],
      ['PUT', '/api/admin/schedules/weekly', { ...weekly, serviceItemIds: [projects[0].id] }],
      ['PATCH', '/api/admin/schedules/settings', { daysVisible: 3 }],
      ['PATCH', `/api/admin/schedules/day/${therapistA.id}`, { date: tomorrow, expectedStep: 30, close: ['11:00'] }],
      ['PATCH', `/api/admin/schedules/day/${therapistA.id}`, { date: tomorrow, expectedStep: 30, open: ['11:00'] }],
      ['PATCH', `/api/admin/schedules/day/${therapistA.id}`, { date: tomorrow, serviceItemIds: [projects[0].id] }]
    ];
    const snapshot = async () => JSON.stringify({
      weekly: (await pool.query('SELECT * FROM weekly_schedules ORDER BY therapist_id,weekday')).rows,
      settings: (await pool.query('SELECT * FROM schedule_settings')).rows,
      frozen: (await pool.query('SELECT * FROM schedule_days ORDER BY therapist_id,date')).rows,
      bookings: (await pool.query('SELECT * FROM appointments ORDER BY id')).rows,
      notifications: (await pool.query('SELECT * FROM notifications ORDER BY id')).rows
    });
    const before = await snapshot();
    for (const [method, route, body] of scenarios) {
      const token = await tokenFor(admin), client = await pool.connect();
      let request;
      try {
        await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(582302)');
        request = api(route, admin, method, body, token);
        await waitForIdentityWait(pool);
        await client.query('UPDATE users SET session_version=session_version+1 WHERE id=$1', [admin.id]);
        await client.query('COMMIT');
        assert.equal((await request).status, 401, method + ' ' + route);
        assert.equal(await snapshot(), before);
      } finally {
        await client.query('ROLLBACK'); client.release();
        if (request) await request.catch(() => {});
      }
    }
  });
});

test('A2 therapist schedule list and both detail reads revalidate waiting sessions using one transaction', async () => {
  await withDatabase(async ({ pool, api, tokenFor, staff, therapistB, tomorrow, bookingTime, addAppointment }) => {
    const slot = bookingTime({ therapist: therapistB });
    const appointment = await addAppointment(slot, { status: 'no_show' });
    const routes = [`/api/schedules?date=${tomorrow}`, `/api/schedules/${therapistB.id}?date=${tomorrow}`, `/api/therapist/appointments/${appointment.id}`];
    for (const route of routes) {
      const token = await tokenFor(staff), client = await pool.connect();
      let request;
      try {
        await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(582302)');
        request = api(route, staff, 'GET', undefined, token);
        await waitForIdentityWait(pool);
        await client.query('UPDATE users SET session_version=session_version+1 WHERE id=$1', [staff.id]);
        await client.query('COMMIT');
        assert.equal((await request).status, 401);
        assert.equal((await api(route, staff)).status, 200);
      } finally {
        await client.query('ROLLBACK'); client.release();
        if (request) await request.catch(() => {});
      }
    }
  });
});

test('operational counts include the weekly schedule, frozen day, visibility and appointment history', async () => {
  const { scheduleCounts } = require('../../src/services/scheduleCounts');
  await withDatabase(async ({ pool, api, customer, configureWeek }) => {
    const time = await configureWeek();
    const booked = await api('/api/appointments', customer, 'POST', time);
    assert.equal(booked.status, 200);
    const edited = await api(`/api/appointments/${booked.body.data.appointment.id}/modify`, customer, 'PATCH', { note: '新备注' });
    assert.equal(edited.status, 200);
    assert.deepEqual(await scheduleCounts(pool, { allowLegacy: true }),
      { days_visible: 7, weekly_schedules: 1, frozen_schedule_days: 1, appointment_revisions: 1 });
    // Historical archive before 015: inspect its old schema without migrating it.

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path=pg_temp');
      await client.query('CREATE TEMP TABLE appointment_slots (id int)');
      await client.query('INSERT INTO appointment_slots VALUES(1),(2)');
      assert.deepEqual(await scheduleCounts(client, { allowLegacy: true }), { slots: 2 });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
