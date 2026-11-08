// Regression cases promoted from the audit; isolated fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');

test('unread snapshot and receipt edge audit on isolated PostgreSQL', { skip: process.env.RUN_DB_TESTS !== '1' }, async t => {
  const { withDatabase, cleanup } = require('../audit-2026-10-20/isolated');
  try {
    await withDatabase(async ({ pool, api, admin, customer, staff, therapistB, bookingTime, addAppointment }) => {
      const first = await addAppointment(bookingTime({ date: '2020-01-01', therapist: therapistB }), { status: 'no_show' });
      const second = await addAppointment(bookingTime({ date: '2020-01-02', therapist: therapistB }), { status: 'no_show' });
      const options = 'unread=1&status=pending&sort=service_asc&pageSize=1';
      for (const [label, person, route] of [['admin',admin,'admin'], ['therapist',staff,'therapist']]) {
        await t.test(`${label}: capture independent pending snapshot`, async () => {
          const response = await api(`/api/${route}/appointments?${options}`,person);
          assert.equal(response.status,200);
          person.auditView=response.body.data;
          assert.equal(person.auditView.appointments[0].id,first.id);
          assert.equal(person.auditView.unread.tabs.pending,2);
        });
      }
      const cancelled = await api(`/api/appointments/${second.id}/cancel`, customer, 'PATCH');
      assert.equal(cancelled.status,200);
      for (const [person, route] of [[admin,'admin'], [staff,'therapist']]) {
        await t.test(`${route}: a concurrent cancellation invalidates pending continuation instead of mixing versions`, async () => {
          const response = await api(`/api/${route}/appointments?${options}&page=2&cursor=${person.auditView.pagination.nextCursor}`,person);
          assert.equal(response.status,409);
          assert.equal(response.body.code,'INBOX_VIEW_EXPIRED');
          const fresh = await api(`/api/${route}/appointments?${options}`,person);
          assert.equal(fresh.body.data.pagination.total,1,'neighbor: fresh pending query correctly excludes cancelled row');
          assert.equal(fresh.body.data.unread.tabs.cancelled,1);
          const cancelledView = await api(`/api/${route}/appointments?unread=1&status=cancelled`,person);
          assert.equal(cancelledView.body.data.appointments[0].unreadKind,'cancelled');
          assert.equal(cancelledView.body.data.appointments[0].unreadVersion,'2');
        });
      }
      await t.test('check-in changes business version without creating a reminder; all-status continuation refreshes too', async () => {
        const query='unread=1&status=all&sort=service_asc&pageSize=1';
        const snapshots=[];
        for (const [person, route] of [[admin,'admin'],[staff,'therapist']]) {
          const response=await api(`/api/${route}/appointments?${query}`,person);
          assert.equal(response.status,200);
          snapshots.push({ person, route, view:response.body.data });
        }
        const checked=await api(`/api/admin/appointments/${first.id}/check-in`,admin,'PATCH');
        assert.equal(checked.status,200,JSON.stringify(checked.body));
        for (const {person,route,view} of snapshots) {
          const response=await api(`/api/${route}/appointments?${query}&cursor=${view.pagination.nextCursor}`,person);
          assert.equal(response.status,409);
          assert.equal(response.body.code,'INBOX_VIEW_EXPIRED');
          const fresh=(await api(`/api/${route}/appointments?${query}`,person)).body.data;
          const item=fresh.appointments.find(a=>a.id===first.id);
          assert.equal(item.status,'checked_in');
          assert.equal(item.unreadKind,'created'); assert.equal(item.unreadVersion,'1');
          assert.equal(fresh.unread.tabs.pending,0); assert.equal(fresh.unread.tabs.checked_in,1);
        }
      });
      await t.test('pre-024 snapshots refresh, while their exact-version receipts remain valid', async () => {
        const query='unread=1&status=all&sort=service_asc&pageSize=1';
        const view=(await api(`/api/admin/appointments?${query}`,admin)).body.data;
        await pool.query('UPDATE appointment_inbox_view_items SET appointment_version=NULL WHERE view_id=$1',[view.inboxViewId]);
        const stale=await api(`/api/admin/appointments?${query}&cursor=${view.pagination.nextCursor}`,admin);
        assert.equal(stale.status,409); assert.equal(stale.body.code,'INBOX_VIEW_EXPIRED');
        const item=view.appointments[0];
        const read=await api('/api/appointment-inbox/read',admin,'POST',{
          viewId:view.inboxViewId,entries:[{id:item.id,version:item.unreadVersion}]
        });
        assert.equal(read.status,200); assert.deepEqual(read.body.data.acknowledged,[item.id]);
      });
      await t.test('duplicate UUIDs differing only by case return 400; a single uppercase UUID remains valid', async () => {
        // Fixed, wholly fictitious UUID ensures there are alphabetic hex digits.
        const id='abcdefab-cdef-4abc-8def-abcdefabcdef';
        await pool.query(`INSERT INTO appointments(id,user_id,service_item_id,therapist_id,date,start_time,end_time,status)
          SELECT $1,user_id,service_item_id,therapist_id,'2020-01-03','09:00','10:00','no_show' FROM appointments WHERE id=$2`,[id,first.id]);
        const view=(await api('/api/admin/appointments?unread=1&status=all',admin)).body.data;
        const item=view.appointments.find(a=>a.id===id);
        const response=await api('/api/appointment-inbox/read',admin,'POST',{viewId:view.inboxViewId,entries:[
          {id,version:item.unreadVersion},{id:id.toUpperCase(),version:item.unreadVersion}
        ]});
        assert.equal(response.status,400);
        assert.equal(response.body.code,'INVALID_READ_CONFIRMATION');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM appointment_reads WHERE user_id=$1 AND appointment_id=$2',[admin.id,id])).rows[0].n,0,'statement rolls back');
        const correct=await api('/api/appointment-inbox/read',admin,'POST',{viewId:view.inboxViewId.toUpperCase(),entries:[{id:id.toUpperCase(),version:item.unreadVersion}]});
        assert.equal(correct.status,200);
        assert.deepEqual(correct.body.data.acknowledged,[id]);
      });
    });
  } finally { cleanup(); }
});
