// Positive controls for this audit. No actual WeChat calls or existing business data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { withDatabase, cleanup } = require('../audit-2026-10-20/isolated');
test.after(cleanup);

test('CONTROL concurrent check-in and cancel cannot both commit for any authorized check-in identity', async () => {
  await withDatabase(async ({ pool, api, admin, customer, staff, therapistB, bookingTime, addAppointment }) => {
    for (const [index, actor] of [customer, staff, admin].entries()) {
      const appointment = await addAppointment(bookingTime({ date: `2020-01-0${index + 1}`, therapist: therapistB }));
      const prefix = actor.id === customer.id ? '/api/appointments' : actor.id === staff.id ? '/api/therapist/appointments' : '/api/admin/appointments';
      const outcomes = await Promise.all([
        api(`${prefix}/${appointment.id}/check-in`, actor, 'PATCH'),
        api(`/api/appointments/${appointment.id}/cancel`, customer, 'PATCH')
      ]);
      assert.deepEqual(outcomes.map(item => item.status).sort(), [200, 409]);
      const row = (await pool.query('SELECT status FROM appointments WHERE id=$1', [appointment.id])).rows[0];
      assert.ok(['checked_in', 'cancelled'].includes(row.status));
    }
  });
});

test('CONTROL foreign resource IDs, staff consumer booking and spoofed therapist filter remain denied', async () => {
  await withDatabase(async ({ api, admin, customer, staff, other, therapistB, projects, bookingTime, addAppointment }) => {
    const assigned = await addAppointment(bookingTime({ therapist: therapistB }), { status: 'no_show' });
    const foreign = await addAppointment(bookingTime({ date: '2020-01-02' }), { user: other, status: 'no_show' });
    assert.equal((await api(`/api/appointments/${foreign.id}/cancel`, customer, 'PATCH')).status, 404);
    assert.equal((await api(`/api/appointments/${foreign.id}/check-in`, customer, 'PATCH')).status, 404);
    assert.equal((await api(`/api/admin/appointments/${foreign.id}`, customer)).status, 403);
    assert.equal((await api(`/api/admin/appointments/${foreign.id}`, staff)).status, 403);
    assert.equal((await api(`/api/therapist/appointments/${foreign.id}`, staff)).status, 404);
    const result = await api('/api/therapist/appointments?therapistIds=' + foreign.therapist_id, staff);
    assert.deepEqual(result.body.data.appointments.map(item => item.id), [assigned.id]);
    const input = bookingTime({ date: '2999-01-01' });
    for (const actor of [admin, staff]) {
      assert.equal((await api('/api/appointments', actor, 'POST', input)).status, 403);
    }
  });
});
