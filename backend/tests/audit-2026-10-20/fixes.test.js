const test = require('node:test');
const assert = require('node:assert/strict');
const { withDatabase, cleanup } = require('./isolated');
test.after(cleanup);

test('edits accept only time, project, note and source version and retain their appointment ID', async () => {
  await withDatabase(async ({ api, pool, customer, projects, configureWeek, addAppointment }) => {
    const time = await configureWeek();
    const original = await addAppointment(time);
    for (const patch of [{ slotId: original.id }, { therapistId: time.therapistId }, { date: time.date },
      { userId: customer.id }, { status: 'checked_in' }, { extra: true }]) {
      assert.equal((await api(`/api/appointments/${original.id}/modify`, customer, 'PATCH', patch)).status, 400);
    }
    const response = await api(`/api/appointments/${original.id}/modify`, customer, 'PATCH', {
      startTime: '13:00', endTime: '14:00', serviceItemId: projects[1].id, note: '新的预约备注', version: original.version
    });
    assert.equal(response.status, 200);
    const edited = response.body.data.appointment;
    assert.equal(edited.id, original.id);
    assert.equal(edited.status, 'booked');
    assert.equal(edited.therapistId, time.therapistId);
    assert.equal(edited.startTime, '13:00');
    assert.equal(edited.version, original.version + 1);
    assert.equal((await pool.query('SELECT 1 FROM notifications')).rowCount, 0);
  });
});

test('original start locks exactly at service start while edits remain available through the end boundary', async () => {
  await withDatabase(async ({ db, customer, configureWeek, addAppointment }) => {
    const actions = require('../../src/services/appointmentService');
    const user = await require('../../src/repositories/userRepository').findById(customer.id);
    for (const [index, offset] of [-1, 0, 1].entries()) {
      const time = await configureWeek(`2999-02-0${index + 1}`);
      const original = await addAppointment(time);
      const now = new Date(Date.parse(`${time.date}T09:00:00+08:00`) + offset);
      const service = actions.createAppointmentService({ transaction: db.transaction, now: () => now });
      const operation = service.modifyAppointment(original.id, { startTime: '10:00', endTime: '11:00' }, { user });
      if (offset < 0) assert.equal((await operation).startTime, '10:00');
      else {
        await assert.rejects(operation, { code: 'START_TIME_LOCKED' });
        assert.equal((await service.modifyAppointment(original.id, { note: '进行中备注' }, { user })).id, original.id);
      }
    }
  });
});

test('revision insertion failure preserves original values and creates no messages', async () => {
  await withDatabase(async ({ api, pool, customer, configureWeek, addAppointment }) => {
    const original = await addAppointment(await configureWeek());
    await pool.query("ALTER TABLE appointment_revisions ADD CONSTRAINT simulate_revision_failure CHECK (false)");
    const response = await api(`/api/appointments/${original.id}/modify`, customer, 'PATCH', { note: '变更' });
    assert.equal(response.status, 500);
    const { rows: [saved] } = await pool.query('SELECT * FROM appointments WHERE id=$1', [original.id]);
    assert.equal(saved.status, 'booked');
    assert.equal(saved.version, original.version);
    assert.equal(saved.note, original.note);
    assert.equal((await pool.query('SELECT 1 FROM notifications')).rowCount, 0);
  });
});

test('cursor paging covers all identities, tied microseconds, live inserts/deletes and SQL filters', async () => {
  await withDatabase(async ({ api, pool, admin, customer, staff, other, therapistB, bookingTime, addAppointment }) => {
    const slot = bookingTime({ therapist: therapistB });
    const ids = [];
    for (let n = 0; n < 43; n++) ids.push((await addAppointment(slot, { status: 'cancelled' })).id);
    await addAppointment(slot, { user: other, status: 'cancelled' });
    await pool.query("UPDATE appointments SET created_at='2020-01-01T00:00:00.123456Z'");
    for (const [path, actor, expected] of [['/api/appointments/my', customer, 43],
      ['/api/therapist/appointments', staff, 44], ['/api/admin/appointments', admin, 44]]) {
      const base = `${path}?status=cancelled&fromDate=2020-01-01&toDate=2020-01-01&startTime=09:00&endTime=10:00`;
      const first = await api(base, actor);
      assert.equal(first.status, 200);
      const seen = new Set(first.body.data.appointments.map(p => p.id));
      let cursor = first.body.data.pagination.nextCursor;
      let pages = 1;
      while (cursor) {
        const result = await api(`${base}&cursor=${encodeURIComponent(cursor)}`, actor);
        assert.equal(result.status, 200);
        for (const row of result.body.data.appointments) { assert.ok(!seen.has(row.id)); seen.add(row.id); }
        cursor = result.body.data.pagination.nextCursor;
        assert.ok(++pages < 10);
      }
      assert.equal(seen.size, expected);
    }
    const list = require('../../src/repositories/appointmentRepository').listByUser;
    const first = await list(customer.id, { status: 'cancelled' });
    await pool.query('DELETE FROM appointments WHERE id=$1', [first.appointments[0].id]);
    await addAppointment(bookingTime({ date: '2021-01-01' }), { status: 'cancelled' });
    const second = await list(customer.id, { status: 'cancelled', cursor: first.pagination.nextCursor });
    assert.equal(second.appointments.length, 20);
    assert.ok(second.appointments.every(row => !first.appointments.some(p => p.id === row.id)));
    const bad = Buffer.from(JSON.stringify(['appointments', '2020-01-01', '09:00:00', '2020-01-01 00:00:00+00', '-'.repeat(36)])).toString('base64url');
    assert.equal((await api(`/api/admin/appointments?cursor=${bad}`, admin)).status, 400);
  });
});

test('whitelist pagination reaches every member beyond the previous 200-row cutoff', async () => {
  await withDatabase(async ({ api, pool, admin }) => {
    await pool.query(`INSERT INTO member_whitelist(phone,remark_name,status)
      SELECT '137' || lpad(n::text,8,'0'), '合成分页成员', 'active' FROM generate_series(1,205) n`);
    const first = await api('/api/admin/whitelist?keyword=合成分页成员', admin);
    assert.equal(first.status, 200);
    assert.equal(first.body.data.items.length, 200);
    assert.equal(first.body.data.pagination.hasMore, true);
    const second = await api(`/api/admin/whitelist?keyword=合成分页成员&cursor=${first.body.data.pagination.nextCursor}`, admin);
    assert.equal(second.status, 200);
    assert.equal(second.body.data.items.length, 5);
    assert.equal(second.body.data.pagination.hasMore, false);
    assert.equal(new Set(first.body.data.items.concat(second.body.data.items).map(p => p.id)).size, 205);
    assert.equal((await api('/api/admin/whitelist?cursor=invalid', admin)).status, 400);
  });
});
