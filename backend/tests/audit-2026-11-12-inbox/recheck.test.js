// The original lifecycle audit cases now assert the fixed behavior in the default suite.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../appointmentInboxLifecycle.test');

test('migration 024 preserves old appointments/receipts but refuses their unversioned list continuation',
  { skip: process.env.RUN_DB_TESTS !== '1' }, async () => {
    const { withDatabase, cleanup } = require('../audit-2026-10-20/isolated');
    const { encodePosition } = require('../../src/utils/appointmentInbox');
    let legacy;
    try {
      await withDatabase(async ({ pool, api }) => {
        const item = (await pool.query('SELECT * FROM appointment_inbox_view_items WHERE view_id=$1', [legacy.view])).rows[0];
        assert.equal(item.appointment_version, null);
        assert.equal(item.version, '1'); assert.equal(item.kind, 'created');
        const readBefore = (await pool.query('SELECT version FROM appointment_reads WHERE user_id=$1 AND appointment_id=$2', [legacy.user.id, legacy.appointment])).rows[0];
        assert.equal(readBefore.version, '0');
        const query = 'unread=1&status=all&sort=service_asc&pageSize=1';
        const fresh = await api(`/api/admin/appointments?${query}`, legacy.user);
        assert.equal(fresh.status, 200);
        // Attach the migrated old-format view to the current session, without
        // backfilling its missing business version or changing its read receipt.
        await pool.query(`UPDATE appointment_inbox_views old SET scope_key=fresh.scope_key,query_key=fresh.query_key
          FROM appointment_inbox_views fresh WHERE old.id=$1 AND fresh.id=$2`, [legacy.view, fresh.body.data.inboxViewId]);
        const stale = await api(`/api/admin/appointments?${query}&cursor=${encodePosition(legacy.view, 0)}`, legacy.user);
        assert.equal(stale.status, 409); assert.equal(stale.body.code, 'INBOX_VIEW_EXPIRED');
        const read = await api('/api/appointment-inbox/read', legacy.user, 'POST', {
          viewId: legacy.view, entries: [{ id: legacy.appointment, version: '1' }]
        });
        assert.equal(read.status, 200); assert.deepEqual(read.body.data.acknowledged, [legacy.appointment]);
        const record = (await pool.query('SELECT status,inbox_version FROM appointments WHERE id=$1', [legacy.appointment])).rows[0];
        assert.equal(record.status, 'no_show'); assert.equal(record.inbox_version, '1');
      }, { beforeMigration: async (file, client) => {
        if (!file.startsWith('024_')) return;
        const user = (await client.query("INSERT INTO users(openid,phone,role) VALUES('inbox-upgrade-fixture','13900000009','admin') RETURNING *")).rows[0];
        const project = (await client.query("SELECT id FROM service_items WHERE status='active' LIMIT 1")).rows[0];
        const therapist = (await client.query("INSERT INTO therapists(name,phone,service_item_ids) VALUES('升级测试芳疗师','13900000008',$1) RETURNING id", [[project.id]])).rows[0];
        const appointment = (await client.query("INSERT INTO appointments(user_id,service_item_id,therapist_id,date,start_time,end_time,status) VALUES($1,$2,$3,'2020-01-01','09:00','10:30','no_show') RETURNING id", [user.id, project.id, therapist.id])).rows[0].id;
        const view = (await client.query("INSERT INTO appointment_inbox_views(user_id,scope_key,query_key,summary) VALUES($1,'old-scope','old-query','{}') RETURNING id", [user.id])).rows[0].id;
        await client.query("INSERT INTO appointment_inbox_view_items(view_id,position,appointment_id,version,kind) VALUES($1,1,$2,1,'created')", [view, appointment]);
        await client.query('INSERT INTO appointment_reads(user_id,appointment_id,version) VALUES($1,$2,0)', [user.id, appointment]);
        legacy = { user, appointment, view };
      }});
    } finally { cleanup(); }
  });
