const test = require('node:test');
const assert = require('node:assert/strict');
const { withDatabase, cleanup } = require('./isolated');
test.after(cleanup);

// Assertions describe the intended rule. Failing audit cases are evidence,
// not permission to change product rules or production code.
test('AUDIT scope: therapist cannot sign a historical customer booking assigned to somebody else', async () => {
  await withDatabase(async ({ api, bookingTime, addAppointment, therapistB, staff, other }) => {
    const ownClient = await addAppointment(bookingTime({ therapist: therapistB }));
    assert.equal((await api(`/api/therapist/appointments/${ownClient.id}/check-in`, staff, 'PATCH')).status, 200);
    const foreign = await addAppointment(bookingTime({ date: '2020-01-02' }), { user: other });
    assert.equal((await api(`/api/therapist/appointments/${foreign.id}/check-in`, staff, 'PATCH')).status, 404);
    // This customer history predates the user's therapist binding; only future
    // customer bookings are automatically cancelled when that binding is made.
    const personal = await addAppointment(bookingTime({ date: '2020-01-03' }), { user: staff, status: 'no_show' });
    const response = await api(`/api/therapist/appointments/${personal.id}/check-in`, staff, 'PATCH');
    assert.equal(response.status, 404, 'a therapist endpoint must enforce assignment even when the therapist is also the customer');
  });
});

test('AUDIT concurrency: transferring a therapist account revokes a request waiting after middleware', async () => {
  await withDatabase(async ({ api, db, pool, tokenFor, admin, staff, other, therapistB, bookingTime, addAppointment }) => {
    const appointment = await addAppointment(bookingTime({ therapist: therapistB }));
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
        name: therapistB.name, phone: other.phone, bio: '审查换绑', imageUrl: image.imageUrl
      }, { user: admin, requestId: 'audit-transfer' });
      await paused;
      request = api(`/api/therapist/appointments/${appointment.id}/check-in`, staff, 'PATCH', {}, token);
      for (let n=0; n<100; n++) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' LIMIT 1");
        if (waiting.rowCount) break;
        if (n===99) assert.fail('check-in did not reach the identity lock');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      release(); await transfer;
      assert.ok([401,403,404].includes((await request).status));
      assert.equal((await api('/api/auth/me', staff, 'GET', undefined, token)).status, 401);
      assert.equal((await pool.query('SELECT status FROM appointments WHERE id=$1',[appointment.id])).rows[0].status, 'booked');
    } finally { release(); db.query = original; await Promise.allSettled([transfer,request].filter(Boolean)); }
  });
});

test('AUDIT concurrency: no-show marking and customer cancellation do not deadlock', async (t) => {
  await withDatabase(async ({ pool, customer, bookingTime, addAppointment }) => {
    const appointment = await addAppointment(bookingTime());
    const repository = require('../../src/repositories/appointmentRepository');
    const original = repository.markNoShows;
    let marked, release;
    const paused = new Promise(resolve => { marked = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    repository.markNoShows = async (client) => { const result = await original(client); marked(); await resume; return result; };
    let markRequest, cancelRequest;
    try {
      markRequest = require('../../src/services/noShowService').markNoShows();
      markRequest.catch(() => {});
      await paused;
      const actor = await require('../../src/repositories/userRepository').findById(customer.id);
      cancelRequest = require('../../src/services/appointmentService').cancelAppointment(appointment.id, { user: actor, requestId: 'audit-cancel' });
      cancelRequest.catch(() => {});
      // Wait until the real cancellation SQL is blocked on the no-show row.
      for (let n = 0; n < 100; n++) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%' LIMIT 1");
        if (waiting.rowCount) break;
        if (n === 99) assert.fail('cancellation never reached the expected database row lock');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      release();
      const results = await Promise.allSettled([markRequest, cancelRequest]);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason.code || result.reason.name);
      t.diagnostic(results.map((result, index) => `${index === 0 ? 'no-show job' : 'customer cancellation'}: ${result.status === 'fulfilled' ? 'committed' : result.reason.code}`).join('; '));
      assert.deepEqual(failures, [], `background/user lock conflict: ${failures.join(',')}`);
    } finally {
      release(); repository.markNoShows = original;
      await Promise.allSettled([markRequest, cancelRequest].filter(Boolean));
    }
  });
});

test('AUDIT pagination: tied creation times neither duplicate nor omit historical appointments', async () => {
  await withDatabase(async ({ pool, customer, bookingTime, addAppointment }) => {
    const slot = bookingTime();
    for (let n = 0; n < 65; n++) await addAppointment(slot, { status: 'cancelled' });
    await pool.query("UPDATE appointments SET created_at='2020-01-01T00:00:00Z'");
    const repo = require('../../src/repositories/appointmentRepository');
    for (const list of [query => repo.listByUser(customer.id, query), query => repo.listForAdmin(query)]) {
      const pages = [];
      for (let page = 1; page <= 4; page++) pages.push(...(await list({ page, pageSize: 20 })).appointments);
      assert.equal(new Set(pages.map(item => item.id)).size, 65, 'ORDER BY needs a unique final tie-breaker');
    }
  });
});

test('AUDIT pagination: receiving a newer appointment between pages does not repeat a previously displayed card', async () => {
  await withDatabase(async ({ bookingTime, addAppointment }) => {
    const slot = bookingTime();
    for (let index = 0; index < 25; index++) await addAppointment(slot, { status: 'cancelled' });
    const list = require('../../src/repositories/appointmentRepository').listForAdmin;
    const first = await list({ page: 1, pageSize: 20 });
    await addAppointment(bookingTime({ date: '2021-01-01' }), { status: 'cancelled' });
    assert.ok(first.pagination.nextCursor);
    const second = await list({ page: 2, pageSize: 20, cursor: first.pagination.nextCursor });
    const displayed = new Set(first.appointments.map(item => item.id));
    assert.equal(second.appointments.some(item => displayed.has(item.id)), false,
      'offset pagination plus frontend concat produces duplicate appointment cards after a live insertion');
  });
});

test('an edit cannot move a booking to another therapist or service date', async () => {
  await withDatabase(async ({ api, customer, configureWeek, addAppointment, therapistB, projects }) => {
    const time = await configureWeek();
    const original = await addAppointment(time);
    for (const patch of [{ therapistId: therapistB.id }, { date: '2020-01-01' }]) {
      assert.equal((await api(`/api/appointments/${original.id}/modify`, customer, 'PATCH', patch)).status, 400);
    }
    const allowed = await api(`/api/appointments/${original.id}/modify`, customer, 'PATCH', { serviceItemId: projects[1].id, note: '修改备注' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.data.appointment.therapistId, time.therapistId);
    assert.equal(allowed.body.data.appointment.date, time.date);
  });
});

test('a business-log failure rolls back both booking and first-day freeze without creating messages', async () => {
  await withDatabase(async ({ api, pool, customer, configureWeek }) => {
    const input = await configureWeek();
    await pool.query("ALTER TABLE business_logs ADD CONSTRAINT reject_booking CHECK(action <> 'create_appointment') NOT VALID");
    const response = await api('/api/appointments', customer, 'POST', input);
    assert.equal(response.status, 500);
    for (const table of ['appointments','schedule_days','notifications']) assert.equal((await pool.query('SELECT 1 FROM ' + table)).rowCount, 0);
    await pool.query('ALTER TABLE business_logs DROP CONSTRAINT reject_booking');
    assert.equal((await api('/api/appointments', customer, 'POST', input)).status, 200);
  });
});

test('AUDIT control: phone migration preserves a customer id/history and invalidates the previous token', async () => {
  await withDatabase(async ({ api, pool, tokenFor, customer, bookingTime, addAppointment, admin }) => {
    const history = await addAppointment(bookingTime(), { status: 'cancelled' });
    const oldToken = await tokenFor(customer);
    const auth = require('../../src/services/authService');
    const migrated = await auth.loginWithWechat({ loginCode: 'audit-new-wechat', mockPhone: customer.phone }, { requestId: 'audit-migration' });
    assert.equal(migrated.user.id, customer.id);
    assert.equal((await pool.query('SELECT user_id FROM appointments WHERE id=$1', [history.id])).rows[0].user_id, customer.id);
    assert.equal((await api('/api/auth/me', customer, 'GET', undefined, oldToken)).status, 401);
    assert.equal((await api('/api/auth/me', customer, 'GET', undefined, migrated.token)).status, 200);
    await assert.rejects(auth.loginWithWechat({ loginCode: 'audit-conflicting-wechat', mockPhone: admin.phone }), { code: 'ACCOUNT_IDENTITY_CONFLICT', status: 409 });
  });
});

test('AUDIT control: shared/recycled images survive cleanup and unlink failures stay retryable', async () => {
  await withDatabase(async ({ pool, projects }) => {
    const fs = require('node:fs/promises'), path = require('node:path');
    const images = require('../../src/services/therapistImageService');
    const cleaner = require('../../src/services/imageCleanupService');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
    assert.throws(() => images.inspect(Buffer.from('not an image')), { code: 'INVALID_IMAGE' });
    assert.throws(() => images.inspect(Buffer.alloc(5 * 1024 * 1024 + 1)), { code: 'IMAGE_TOO_LARGE' });
    const shared = await images.uploadBuffer(png);
    await pool.query('UPDATE service_items SET image_url=$1 WHERE id=ANY($2::uuid[])', [shared.imageUrl, projects.slice(0, 2).map(item => item.id)]);
    await pool.query("UPDATE service_items SET status='inactive' WHERE id=$1", [projects[0].id]);
    const firstSeen = new Date('2026-10-20T00:00:00Z'), due = new Date('2026-10-21T00:00:00Z');
    await cleaner.cleanupOrphans({ now: firstSeen }); await cleaner.cleanupOrphans({ now: due });
    await fs.access(path.join(images.directory, path.basename(shared.imageUrl)));
    await pool.query("UPDATE service_items SET image_url='' WHERE id=$1", [projects[1].id]);
    await cleaner.cleanupOrphans({ now: due });
    await fs.access(path.join(images.directory, path.basename(shared.imageUrl))); // Recoverable inactive record still owns it.
    await pool.query("UPDATE service_items SET image_url='',purged_at=now() WHERE id=$1", [projects[0].id]);
    await cleaner.cleanupOrphans({ now: due });
    const unlink = fs.unlink;
    fs.unlink = async file => { if (path.basename(file) === path.basename(shared.imageUrl)) throw Object.assign(new Error('audit denied'), { code: 'EACCES' }); return unlink(file); };
    try {
      const failed = await cleaner.cleanupOrphans({ now: new Date('2026-10-22T00:00:00Z') });
      assert.equal(failed.failed, 1);
      await fs.access(path.join(images.directory, path.basename(shared.imageUrl)));
    } finally { fs.unlink = unlink; }
    await cleaner.cleanupOrphans({ now: new Date('2026-10-22T00:01:00Z') });
    await assert.rejects(fs.access(path.join(images.directory, path.basename(shared.imageUrl))), { code: 'ENOENT' });
  });
});

test('AUDIT privacy: searching/adding a member does not put an unmasked phone in file log records', async () => {
  await withDatabase(async ({ admin, other }) => {
    const logging = require('../../src/config/logger');
    const info = logging.logger.info, auditInfo = logging.auditLogger.info;
    const captured = [];
    logging.logger.info = entry => captured.push(entry);
    logging.auditLogger.info = entry => captured.push(entry);
    const logRepo = require('../../src/repositories/logRepository');
    const persist = logRepo.createHttpRequest;
    logRepo.createHttpRequest = async () => null;
    try {
      await require('../../src/services/whitelistService').add({ phone: other.phone, remarkName: '合成审查会员' }, { user: admin, requestId: 'audit-privacy' });
      const callbacks = {};
      require('../../src/middleware/requestLogger')({
        method: 'GET', originalUrl: `/api/admin/whitelist?keyword=${other.phone}`,
        path: '/api/admin/whitelist', route: { path: '/whitelist' }, baseUrl: '/api/admin',
        requestId: 'audit-search', user: admin, ip: '127.0.0.1', get: () => 'audit'
      }, { statusCode: 200, on: (event, callback) => { callbacks[event] = callback; } }, () => {});
      callbacks.finish();
      assert.equal(captured.some(entry => JSON.stringify(entry).includes(other.phone)), false,
        'file audit snapshots and full query URLs contain an unmasked synthetic phone');
    } finally {
      logging.logger.info = info; logging.auditLogger.info = auditInfo; logRepo.createHttpRequest = persist;
    }
  });
});
