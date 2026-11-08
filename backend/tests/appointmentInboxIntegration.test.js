const test = require('node:test');
const assert = require('node:assert/strict');

test('in-app unread events, snapshot paging and read receipts use isolated PostgreSQL and HTTP',
  { skip: process.env.RUN_DB_TESTS !== '1' }, async t => {
    const { withDatabase, cleanup } = require('./audit-2026-10-20/isolated');
    let historical;
    try {
      await withDatabase(async ({ pool, db, api, admin, customer, staff, other, therapistA, therapistB, projects, tomorrow, configureWeek, bookingTime, addAppointment }) => {
        const summary = async user => {
          const response = await api('/api/appointment-inbox', user);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          return response.body.data;
        };
        const list = async (user, extra = {}) => {
          const params = new URLSearchParams({ unread:'1',status:'all',sort:'created_desc', ...extra });
          const response = await api(`/api/${user.role === 'admin' ? 'admin' : 'therapist'}/appointments?${params}`, user);
          assert.equal(response.status,200,JSON.stringify(response.body));
          return response.body.data;
        };
        const read = (user, view, records = view.appointments) => api('/api/appointment-inbox/read',user,'POST',{
          viewId:view.inboxViewId,
          entries:records.filter(a=>a.unreadKind).map(a=>({id:a.id,version:a.unreadVersion}))
        });
        const revision = async id => pool.query(`INSERT INTO appointment_revisions(appointment_id,actor_user_id,before_data,after_data)
          VALUES($1,$2,'{"note":"before"}','{"note":"after"}')`,[id,customer.id]);
        await t.test('existing records are baseline-read; customer access is forbidden',async()=>{
          assert.equal((await summary(admin)).total,0);
          assert.equal((await pool.query('SELECT inbox_version FROM appointments WHERE id=$1',[historical])).rows[0].inbox_version,'0');
          assert.equal((await api('/api/appointment-inbox',customer)).status,403);
          assert.equal((await api('/api/appointment-inbox',other)).status,403);
        });

        const selection = { ...await configureWeek(tomorrow,therapistB), endTime:'10:30', serviceItemIds:projects.map(p=>p.id), note:'initial' };
        delete selection.serviceItemId;
        const created = await api('/api/appointments',customer,'POST',selection);
        assert.equal(created.status,200,JSON.stringify(created.body));
        const id = created.body.data.appointment.id;
        await t.test('create emits one unread for each eligible account; admin/therapist overlap is not doubled',async()=>{
          assert.equal((await summary(admin)).created,1);
          assert.equal((await summary(staff)).created,1);
          const a = await list(admin), b = await list(staff);
          assert.equal(a.appointments[0].unreadKind,'created');
          assert.equal(b.appointments[0].userId,undefined);
          assert.match(b.appointments[0].userPhone,/\*\*\*\*/);
          assert.equal((await read(admin,a)).status,200);
          assert.equal((await summary(admin)).total,0);
          assert.equal((await summary(staff)).total,1);
          assert.equal((await list(admin)).appointments.find(a=>a.id===id).unreadKind,'');
        });

        const oldStaffView = await list(staff);
        await t.test('effective edit creates modified unread; old version read cannot consume it',async()=>{
          const current = (await api(`/api/appointments/${id}`,customer)).body.data.appointment;
          const modified = await api(`/api/appointments/${id}/modify`,customer,'PATCH',{
            version:current.version, note:'edited note',serviceItemIds:current.serviceItemIds
          });
          assert.equal(modified.status,200,JSON.stringify(modified.body));
          assert.equal((await summary(staff)).created,0);
          assert.equal((await summary(staff)).changed,1);
          assert.equal((await summary(admin)).changed,1);
          assert.equal((await read(staff,oldStaffView)).status,200);
          assert.equal((await summary(staff)).total,1);
          const view=await list(staff);
          assert.equal(view.appointments[0].unreadKind,'modified');
          await read(staff,view);
          await read(staff,oldStaffView);
          assert.equal((await summary(staff)).total,0,'late old acknowledgment never regresses the read version');
          const originalVersion=(await pool.query('SELECT inbox_version FROM appointments WHERE id=$1',[id])).rows[0].inbox_version;
          const unchanged=await api(`/api/appointments/${id}/modify`,customer,'PATCH',{
            version:modified.body.data.appointment.version,note:'edited note',serviceItemIds:current.serviceItemIds.slice().reverse()
          });
          assert.equal(unchanged.status,200,JSON.stringify(unchanged.body));
          assert.equal((await pool.query('SELECT inbox_version FROM appointments WHERE id=$1',[id])).rows[0].inbox_version,originalVersion);
        });
        await t.test('non-first project edits are unread, while transaction rollback and check-in states do not add events',async()=>{
          const before=(await api(`/api/appointments/${id}`,customer)).body.data.appointment;
          const edited=await api(`/api/appointments/${id}/modify`,customer,'PATCH',{
            version:before.version, serviceItemIds:[before.serviceItemIds[0]],note:before.note
          });
          assert.equal(edited.status,200,JSON.stringify(edited.body));
          let record=(await pool.query('SELECT inbox_version,inbox_kind FROM appointments WHERE id=$1',[id])).rows[0];
          assert.equal(record.inbox_kind,'modified');
          await assert.rejects(db.transaction(async client=>{
            await client.query("UPDATE appointments SET status='cancelled' WHERE id=$1",[id]);
            throw new Error('intentional isolated rollback');
          }),/intentional/);
          assert.deepEqual((await pool.query('SELECT inbox_version,inbox_kind FROM appointments WHERE id=$1',[id])).rows[0],record);
          await assert.rejects(db.transaction(async client=>{
            await client.query(`INSERT INTO appointment_revisions(appointment_id,actor_user_id,before_data,after_data)
              VALUES($1,$2,'{"note":"before"}','{"note":"rolled back edit"}')`,[id,customer.id]);
            throw new Error('intentional revision rollback');
          }),/intentional/);
          assert.deepEqual((await pool.query('SELECT inbox_version,inbox_kind FROM appointments WHERE id=$1',[id])).rows[0],record);
          const own=await list(staff); await read(staff,own);
          for(const status of ['checked_in','booked','no_show','booked']) {
            await pool.query('UPDATE appointments SET status=$2 WHERE id=$1',[id,status]);
            assert.equal((await summary(staff)).total,0);
          }
          const result=await api(`/api/admin/appointments/${id}/cancel`,admin,'PATCH');
          assert.equal(result.status,200,JSON.stringify(result.body));
          assert.equal((await summary(admin)).total,0,'performing administrator has read their cancellation');
          const unread=await summary(staff);
          assert.equal(unread.total,1);assert.equal(unread.changed,1);assert.equal(unread.target,'cancelled');
          const cancelled=await list(staff);assert.equal(cancelled.appointments[0].unreadKind,'cancelled');
          await read(staff,cancelled);
        });
        await t.test('system cancellation of a historical appointment produces a new cancellation without rewriting history',async()=>{
          await pool.query("UPDATE appointments SET status='cancelled' WHERE id=$1",[historical]);
          const value=await summary(admin);assert.equal(value.changed,1);assert.equal(value.target,'cancelled');
          const view=await list(admin);await read(admin,view);
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM appointment_revisions WHERE appointment_id=$1',[id])).rows[0].n,2);
        });

        const fixtures=[];
        for(let i=0;i<47;i++) {
          const time=bookingTime({date:`2020-01-${String(1+i%9).padStart(2,'0')}`,therapist:i===46?therapistA:therapistB});
          const record=await addAppointment(time,{status:'no_show'});
          const createdKey=`2020-01-01T00:00:00.${String(i).padStart(6,'0')}Z`;
          await pool.query('UPDATE appointments SET created_at=$2 WHERE id=$1',[record.id,createdKey]);
          if(i%3===0) await revision(record.id);
          if(i%5===0) await pool.query('INSERT INTO appointment_reads(user_id,appointment_id,version) SELECT $1,id,inbox_version FROM appointments WHERE id=$2',[staff.id,record.id]);
          fixtures.push({id:record.id,date:time.date,createdKey,unread:i%5!==0,therapistId:time.therapistId});
        }
        const filters={status:'pending',toDate:'2020-12-31'};
        await t.test('all four orders globally put unread first before pagination',async()=>{
          for(const sort of ['created_asc','created_desc','service_asc','service_desc']) {
            const expected=fixtures.filter(r=>r.therapistId===therapistB.id).sort((a,b)=>{
              if(a.unread!==b.unread) return a.unread?-1:1;
              const sign=sort.endsWith('asc')?1:-1;
              const ka=sort.startsWith('service')?[a.date,a.createdKey,a.id]:[a.createdKey,a.id];
              const kb=sort.startsWith('service')?[b.date,b.createdKey,b.id]:[b.createdKey,b.id];
              for(let i=0;i<ka.length;i++) if(ka[i]!==kb[i]) return (ka[i]<kb[i]?-1:1)*sign;
              return 0;
            }).map(r=>r.id);
            const found=[];let cursor='';
            for(let page=1;page<=4;page++) {
              const view=await list(staff,{...filters,sort,page:String(page),...(cursor?{cursor}:{})});
              found.push(...view.appointments.map(a=>a.id));
              if(!view.pagination.hasMore)break;
              cursor=view.pagination.nextCursor;
            }
            assert.deepEqual(found,expected,sort);
          }
        });
        await t.test('acknowledging pages and concurrent new bookings do not move frozen positions',async()=>{
          const first=await list(staff,filters),initialTabs=first.unread.tabs;
          const order=[];let view=first;
          const newRecord=await addAppointment(bookingTime({date:'2020-01-01',therapist:therapistB}),{status:'no_show'});
          for(let page=1;page<=4;page++) {
            order.push(...view.appointments.map(a=>a.id));
            if(view.appointments.some(a=>a.unreadKind))assert.equal((await read(staff,view)).status,200);
            assert.deepEqual(view.unread.tabs,initialTabs,'labels stay frozen in the current list');
            if(!view.pagination.hasMore)break;
            view=await list(staff,{...filters,page:String(page+1),cursor:view.pagination.nextCursor});
          }
          assert.equal(new Set(order).size,order.length);
          assert.equal(order.length,46);
          assert.equal(order.includes(newRecord.id),false);
          const next=await list(staff,filters);
          assert.equal(next.unread.total,1);
          assert.deepEqual(next.appointments.filter(a=>a.unreadKind).map(a=>a.id),[newRecord.id]);
          assert.equal((await summary(admin)).total,48,'another administrator has independent read state');
        });
        await t.test('modifications invalidate continuation but late acknowledgments remain limited to the shown version',async()=>{
          const first=await list(staff,filters);
          const item=first.appointments[0];
          await revision(item.id);
          const params=new URLSearchParams({...filters,unread:'1',sort:'created_desc',cursor:first.pagination.nextCursor});
          const stale=await api(`/api/therapist/appointments?${params}`,staff);
          assert.equal(stale.status,409);assert.equal(stale.body.code,'INBOX_VIEW_EXPIRED');
          assert.equal((await read(staff,first,[item])).status,200);
          const next=await list(staff,filters);
          assert.equal(next.unread.total,1);
          const changed=next.appointments.find(a=>a.id===item.id);
          assert.equal(changed.unreadKind,'modified');
          assert.equal(Number(changed.unreadVersion),Number(item.unreadVersion)+1);
        });
        await t.test('a receipt waiting on the identity lock cannot consume a concurrently committed modification',async()=>{
          const view=await list(staff,filters);
          const item=view.appointments.find(a=>a.unreadKind);
          const writer=await pool.connect();
          let pending;
          try {
            await writer.query('BEGIN');
            await writer.query('SELECT pg_advisory_xact_lock(582302)');
            await writer.query(`INSERT INTO appointment_revisions(appointment_id,actor_user_id,before_data,after_data)
              VALUES($1,$2,'{"note":"old"}','{"note":"concurrent"}')`,[item.id,customer.id]);
            let completed=false;
            pending=read(staff,view,[item]).then(value=>{completed=true;return value;});
            await new Promise(resolve=>setTimeout(resolve,60));
            assert.equal(completed,false);
            await writer.query('COMMIT');
            assert.equal((await pending).status,200);
            const fresh=await list(staff,filters);
            assert.equal(fresh.appointments.find(a=>a.id===item.id).unreadKind,'modified');
          } finally { await writer.query('ROLLBACK');writer.release();if(pending)await pending; }
        });
        await t.test('filters, permissions, forged versions, owner changes and expired snapshots are validated',async()=>{
          const first=await list(staff,{...filters,pageSize:'1'});
          const total=(await summary(staff)).total;
          const a=first.appointments[0];
          const forged=await api('/api/appointment-inbox/read',staff,'POST',{viewId:first.inboxViewId,entries:[{id:a.id,version:String(Number(a.unreadVersion)+1)}]});
          assert.equal(forged.status,200);assert.deepEqual(forged.body.data.acknowledged,[]);
          assert.equal((await summary(staff)).total,total);
          for(const entries of [[{id:[a.id],version:a.unreadVersion}],[{id:a.id,version:'0'}],Array(21).fill({id:a.id,version:'1'})]) {
            assert.equal((await api('/api/appointment-inbox/read',staff,'POST',{viewId:first.inboxViewId,entries})).status,400);
          }
          const wrongOwner=await read(admin,first);
          assert.deepEqual(wrongOwner.body.data.acknowledged,[]);
          assert.equal((await api('/api/appointment-inbox/read',customer,'POST',{viewId:first.inboxViewId,entries:[{id:a.id,version:a.unreadVersion}]})).status,403);
          const mismatch=await api(`/api/therapist/appointments?unread=1&status=pending&sort=service_asc&cursor=${first.pagination.nextCursor}`,staff);
          assert.equal(mismatch.status,409);
          const hidden=await list(staff,{...filters,serviceItemIds:projects[1].id});
          assert.equal(hidden.appointments.length,0);assert.equal(hidden.unread.total,0);
          const foreign=await list(staff,{...filters,therapistIds:therapistA.id});
          assert.ok(foreign.appointments.every(a=>a.therapistId===therapistB.id));
          await pool.query("UPDATE appointment_inbox_views SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[first.inboxViewId]);
          const expired=await api(`/api/therapist/appointments?unread=1&status=pending&sort=created_desc&toDate=2020-12-31&cursor=${first.pagination.nextCursor}`,staff);
          assert.equal(expired.status,409);assert.equal(expired.body.code,'INBOX_VIEW_EXPIRED');
          const old=await list(staff,filters);
          await pool.query('UPDATE users SET session_version=session_version+1 WHERE id=$1',[staff.id]);
          const stale=await read(staff,old);
          assert.deepEqual(stale.body.data.acknowledged,[],'new login session cannot reuse an old snapshot');
          await pool.query("UPDATE therapists SET status='deleted' WHERE id=$1",[therapistB.id]);
          assert.equal((await api('/api/appointment-inbox',staff)).status,403);
        });
      }, { beforeMigration:async (file,client)=>{
        if(!file.startsWith('023_'))return;
        const project=(await client.query("SELECT id FROM service_items WHERE status='active' LIMIT 1")).rows[0];
        const user=(await client.query("INSERT INTO users(openid,phone) VALUES('inbox-historical-fixture','13900000009') RETURNING id")).rows[0];
        const therapist=(await client.query("INSERT INTO therapists(name,phone,service_item_ids) VALUES('历史测试芳疗师','13900000008',$1) RETURNING id",[[project.id]])).rows[0];
        historical=(await client.query("INSERT INTO appointments(user_id,service_item_id,therapist_id,date,start_time,end_time,status) VALUES($1,$2,$3,'2020-01-01','09:00','10:30','no_show') RETURNING id",[user.id,project.id,therapist.id])).rows[0].id;
      } });
    } finally { cleanup(); }
  });
