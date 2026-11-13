const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const range = (startTime, endTime) => ({ startTime, endTime });

async function queued(pool, first, second) {
  const guard = await pool.connect(), requests = [];
  try {
    await guard.query("BEGIN"); await guard.query("SELECT pg_advisory_xact_lock(582302)");
    for (const run of [first, second]) {
      let response;
      requests.push(run().then(value => { response=value; return value; }));
      let waiting = false;
      for (let attempt=0;attempt<180;attempt++) {
        const { rows: [row] } = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name=current_setting('application_name') AND wait_event_type='Lock'
          AND query LIKE 'SELECT pg_advisory_xact_lock%'`);
        if (row.n >= requests.length) { waiting = true; break; }
        if (response) break;
        await delay(10);
      }
      assert.ok(waiting,`request must reach the real transaction lock; early response: ${response?.status}/${response?.body?.code}`);
    }
    await guard.query("COMMIT");
    return await Promise.all(requests);
  } finally {
    await guard.query("ROLLBACK"); guard.release(); await Promise.allSettled(requests);
  }
}

test("live weekly schedules protect bookings, preserve closures and serialize concurrent writes", {
  skip: process.env.RUN_DB_TESTS !== "1"
}, async t => {
  const { withDatabase, cleanup } = require("./audit-2026-10-20/isolated");
  let legacy;
  try {
    await withDatabase(async f => {
      const { pool, api, customer, other, admin, projects, tomorrow } = f;
      await pool.query("INSERT INTO member_whitelist(phone,status) VALUES($1,'active')",[other.phone]);
      await pool.query("UPDATE schedule_settings SET days_visible=60");
      const ids=projects.map(p=>p.id), ok=response=>{
        assert.equal(response.status,200,JSON.stringify(response.body)); return response.body.data;
      };
      let scenarioCount=0;
      async function scenario(initial={step:30,minDuration:90,ranges:[range("09:00","12:00")]}) {
        // Independent fixtures share a loopback IP, not a user's rate-limit window.
        const limits=require("../src/middleware/rateLimit");
        limits.bookingLimiter.resetKey("127.0.0.1"); limits.adminLimiter.resetKey("127.0.0.1");
        const n=++scenarioCount;
        const date=new Date(Date.parse(tomorrow)+n*86400000).toISOString().slice(0,10);
        const weekday=new Date(date).getUTCDay()||7;
        const {rows:[person]}=await pool.query("INSERT INTO therapists(name,phone,service_item_ids) VALUES($1,$2,$3) RETURNING id",
          ["排班测试"+n,"139100"+String(n).padStart(5,"0"),ids]);
        const id=person.id;
        const week=(schedule,items=ids,single=false)=>single
          ? api(`/api/admin/schedules/weekly/${id}`,admin,"PUT",{days:[{weekday,schedule,serviceItemIds:items}]})
          : api("/api/admin/schedules/weekly",admin,"PUT",{therapistIds:[id],weekdays:[weekday],schedule,serviceItemIds:items});
        const read=(user=customer,edit="")=>api(`/api/schedules/${id}?date=${date}${edit?"&appointmentId="+edit:""}`,user);
        const book=(startTime,endTime,user=customer,items=[ids[0]])=>api("/api/appointments",user,"POST",
          {therapistId:id,date,startTime,endTime,serviceItemIds:items,note:"fixture"});
        const patch=body=>api(`/api/admin/schedules/day/${id}`,admin,"PATCH",{date,...body});
        const cancel=ap=>api(`/api/appointments/${ap.id}/cancel`,customer,"PATCH",{});
        const edit=(ap,body)=>api(`/api/appointments/${ap.id}/modify`,customer,"PATCH",{version:ap.version,serviceItemIds:ap.serviceItemIds,...body});
        const row=ap=>pool.query("SELECT * FROM appointments WHERE id=$1",[ap.id]).then(r=>r.rows[0]);
        ok(await week(initial));
        return {id,date,weekday,week,read,book,patch,cancel,edit,row,initial};
      }

      await t.test("migration preserves old date settings and translates closed cells without applying the weekly template",async()=>{
        const stored=(await pool.query("SELECT * FROM schedule_days WHERE therapist_id=$1",[legacy.id])).rows[0];
        const {fallback_step,fallback_min_duration,manual_closed_ranges,...unchanged}=stored;
        assert.deepEqual(unchanged,legacy.day);
        assert.equal(fallback_step,null);assert.equal(fallback_min_duration,null);
        assert.deepEqual(manual_closed_ranges,[range("09:10","09:20"),range("10:50","11:00")]);
        const day=ok(await api(`/api/schedules/${legacy.id}?date=${stored.date}`,customer));
        assert.deepEqual(day.ranges,[range("09:00","12:00")]);
        assert.deepEqual(day.closed,["09:10","10:50"]);
      });

      await t.test("both editors immediately replace free hours and preserve exact appointment data; cancellation removes only protection",async()=>{
        for(const single of [false,true]) {
          const s=await scenario();
          const ap=ok(await s.book("10:00","11:30")).appointment, before=await s.row(ap);
          const revisions=await pool.query("SELECT * FROM appointment_revisions WHERE appointment_id=$1",[ap.id]);
          ok(await s.week({...s.initial,ranges:[range("14:00","17:00")]},ids,single));
          assert.deepEqual(await s.row(ap),before);
          assert.deepEqual((await pool.query("SELECT * FROM appointment_revisions WHERE appointment_id=$1",[ap.id])).rows,revisions.rows);
          assert.deepEqual(ok(await s.read()).ranges,[range("10:00","11:30"),range("14:00","17:00")]);
          assert.equal((await s.book("09:00","10:30",other)).status,409);
          ok(await s.book("14:00","15:30",other));
          ok(await s.cancel(ap));
          assert.deepEqual(ok(await s.read()).ranges,[range("14:00","17:00")]);
          assert.equal((await s.book("10:00","11:30")).status,409);
        }
      });

      await t.test("shrinking or moving an existing booking cannot leave template-external hours available",async()=>{
        const s=await scenario(), ap=ok(await s.book("09:00","12:00")).appointment;
        ok(await s.week({...s.initial,ranges:[range("14:00","17:00")]}));
        const shortened=ok(await s.edit(ap,{endTime:"10:30"})).appointment;
        assert.deepEqual(ok(await s.read()).ranges,[range("09:00","10:30"),range("14:00","17:00")]);
        const moved=ok(await s.edit(shortened,{startTime:"14:00",endTime:"15:30"})).appointment;
        assert.deepEqual(ok(await s.read()).ranges,[range("14:00","17:00")]);
        assert.equal(moved.id,ap.id);
        assert.equal((await pool.query("SELECT 1 FROM appointment_revisions WHERE appointment_id=$1",[ap.id])).rowCount,2);
      });

      await t.test("project removal immediately blocks new selection, but original selection and history remain editable",async()=>{
        const s=await scenario({step:30,minDuration:90,ranges:[range("09:00","17:00")]});
        const ap=ok(await s.book("09:00","10:30",customer,ids.slice(0,2))).appointment;
        ok(await s.week(s.initial,[]));
        assert.deepEqual(ok(await s.read()).serviceItemIds,[]);
        assert.equal((await s.book("11:00","12:30",other)).body.code,"SERVICE_ITEM_NOT_ALLOWED");
        assert.deepEqual(ok(await s.read(customer,ap.id)).serviceItemIds.slice().sort(),ap.serviceItemIds.slice().sort());
        const edited=ok(await s.edit(ap,{note:"只改备注"})).appointment;
        assert.deepEqual(edited.serviceItemIds.slice().sort(),ap.serviceItemIds.slice().sort());
        assert.equal((await pool.query("SELECT before_data->>'note' AS note FROM appointment_revisions WHERE appointment_id=$1",[ap.id])).rows[0].note,"fixture");
        ok(await s.patch({serviceItemIds:[ids[0]]}));
        ok(await s.patch({serviceItemIds:[]}));
        assert.equal((await s.edit(edited,{serviceItemIds:[ids[2]],note:"不可增加"})).body.code,"SERVICE_ITEM_NOT_ALLOWED");
      });

      await t.test("manual closure survives removal/re-add and coarse/fine grid changes; explicit reopening clears only its interval",async()=>{
        const s=await scenario({step:10,minDuration:90,ranges:[range("09:00","12:00")]});
        ok(await s.patch({expectedStep:10,close:["09:10"]}));
        ok(await s.week({...s.initial,ranges:[]}));
        assert.deepEqual(ok(await s.read()).ranges,[]);
        ok(await s.week({...s.initial,step:30}));
        assert.deepEqual(ok(await s.read()).closed,["09:00"]);
        ok(await s.week(s.initial));
        assert.deepEqual(ok(await s.read()).closed,["09:10"]);
        ok(await s.patch({expectedStep:10,open:["09:10"]}));
        assert.deepEqual(ok(await s.read()).closed,[]);
        assert.deepEqual((await pool.query("SELECT manual_closed_ranges FROM schedule_days WHERE therapist_id=$1 AND date=$2",[s.id,s.date])).rows[0].manual_closed_ranges,[]);
      });

      await t.test("project-only edits keep hours; propagation includes distant stored dates and excludes past dates and other weekdays",async()=>{
        const s=await scenario();ok(await s.patch({expectedStep:30,close:["09:00"]}));
        const dateAt=offset=>new Date(Date.parse(s.date)+offset*86400000).toISOString().slice(0,10);
        for(const offset of [-70,1,70]) await pool.query(`INSERT INTO schedule_days
          (therapist_id,date,step,min_duration,ranges,service_item_ids,closed,manual_closed_ranges)
          SELECT therapist_id,$3,step,min_duration,ranges,service_item_ids,closed,manual_closed_ranges
          FROM schedule_days WHERE therapist_id=$1 AND date=$2`,[s.id,s.date,dateAt(offset)]);
        const rows=()=>pool.query("SELECT * FROM schedule_days WHERE therapist_id=$1 ORDER BY date",[s.id]).then(r=>r.rows);
        const before=await rows();
        ok(await api("/api/admin/schedules/weekly",admin,"PUT",{therapistIds:[s.id],weekdays:[s.weekday],serviceItemIds:[]}));
        const itemsOnly=await rows();
        for(const row of itemsOnly) {
          const old=before.find(r=>r.date===row.date),changed=[s.date,dateAt(70)].includes(row.date);
          assert.deepEqual(row,{...old,service_item_ids:changed?[]:old.service_item_ids});
        }
        ok(await s.week({...s.initial,ranges:[range("14:00","17:00")]}));
        for(const row of await rows()) {
          const old=before.find(r=>r.date===row.date);
          if([dateAt(-70),dateAt(1)].includes(row.date)) assert.deepEqual(row,old);
          else {
            assert.deepEqual(row.ranges,[range("14:00","17:00")]);
            assert.deepEqual(row.manual_closed_ranges,[range("09:00","09:30")]);
            assert.deepEqual(row.service_item_ids.slice().sort(),ids.slice().sort());
          }
        }
      });

      await t.test("incompatible new precision/minimum is deferred; cancellation activates it without another template save",async()=>{
        const s=await scenario({step:10,minDuration:90,ranges:[range("09:00","12:00")]});
        const ap=ok(await s.book("09:10","10:40")).appointment, before=await s.row(ap);
        const next={step:15,minDuration:120,ranges:[range("14:15","17:15")]};
        const saved=ok(await s.week(next));
        assert.deepEqual(saved.deferredDates,[{therapistId:s.id,date:s.date,step:10,minDuration:90}]);
        const day=ok(await s.read());
        assert.equal(day.step,10);assert.equal(day.minDuration,90);
        assert.deepEqual(day.ranges,[range("09:10","10:40"),range("14:20","17:10")]);
        assert.deepEqual(await s.row(ap),before);
        ok(await s.cancel(ap));
        const released=ok(await s.read());
        assert.equal(released.step,15);assert.equal(released.minDuration,120);assert.equal(released.parametersDeferred,false);
        assert.deepEqual(released.ranges,next.ranges);
        ok(await s.book("14:15","16:15"));
      });

      await t.test("compatible parameter changes apply immediately and checked-in appointments keep status and timestamp",async()=>{
        const s=await scenario(), ap=ok(await s.book("09:00","11:00")).appointment;
        await pool.query("UPDATE appointments SET status='checked_in',checked_in_at=now() WHERE id=$1",[ap.id]);
        const before=await s.row(ap);
        const result=ok(await s.week({step:15,minDuration:120,ranges:[range("14:00","18:00")]}));
        assert.deepEqual(result.deferredDates,[]);
        const day=ok(await s.read());assert.equal(day.step,15);assert.equal(day.minDuration,120);
        assert.deepEqual(await s.row(ap),before);
        assert.deepEqual(day.ranges,[range("09:00","11:00"),range("14:00","18:00")]);
      });

      await t.test("editing into compatibility activates new parameters; ended bookings never prolong fallback or protection",async()=>{
        const s=await scenario({step:10,minDuration:90,ranges:[range("09:00","12:00")]});
        const ap=ok(await s.book("09:00","10:30")).appointment;
        ok(await s.week({step:30,minDuration:120,ranges:[range("09:00","12:00")]}));
        assert.equal(ok(await s.read()).minDuration,90);
        const changed=ok(await s.edit(ap,{endTime:"11:00"})).appointment;
        assert.equal(ok(await s.read()).minDuration,120);
        assert.equal(ok(await s.read()).step,30);
        // A past fixture verifies the time predicate independently of the no-show job.
        await pool.query("UPDATE appointments SET date='2000-01-03',status='checked_in',checked_in_at=now() WHERE id=$1",[changed.id]);
        await pool.query(`INSERT INTO schedule_days(therapist_id,date,step,min_duration,ranges,service_item_ids,fallback_step,fallback_min_duration)
          VALUES($1,'2000-01-03',15,180,$2::jsonb,$3,10,90)`,[s.id,JSON.stringify([range("14:00","17:00")]),ids]);
        const [past]=await require("../src/repositories/scheduleRepository").rulesForDate([s.id],"2000-01-03");
        assert.equal(past.step,15);assert.equal(past.minDuration,180);assert.equal(past.parametersDeferred,false);
        assert.deepEqual(past.ranges,[range("14:00","17:00")]);
        assert.equal((await s.row(ap)).status,"checked_in","reading does not rewrite the historical booking");
      });

      await t.test("booking versus template save is serialized in both orders without partial booking or resurrected hours",async()=>{
        const s=await scenario(), next={...s.initial,ranges:[range("14:00","17:00")]};
        const [booked,saved]=await queued(pool,()=>s.book("09:00","10:30"),()=>s.week(next));
        const ap=ok(booked).appointment;ok(saved);
        assert.deepEqual(ok(await s.read()).ranges,[range("09:00","10:30"),range("14:00","17:00")]);
        ok(await s.cancel(ap));ok(await s.week(s.initial));
        const [changed,rejected]=await queued(pool,()=>s.week(next),()=>s.book("09:00","10:30"));
        ok(changed);assert.equal(rejected.status,409);assert.equal(rejected.body.code,"TIME_UNAVAILABLE");
        assert.equal((await pool.query("SELECT 1 FROM appointments WHERE therapist_id=$1 AND status='booked'",[s.id])).rowCount,0);
      });

      await t.test("extension versus template removal respects commit order and preserves a failed edit's record and revisions",async()=>{
        const s=await scenario(), next={...s.initial,ranges:[range("14:00","17:00")]};
        const ap=ok(await s.book("09:00","10:30")).appointment;
        const [extended,saved]=await queued(pool,()=>s.edit(ap,{endTime:"12:00"}),()=>s.week(next));
        ok(extended);ok(saved);
        assert.deepEqual(ok(await s.read()).ranges,[range("09:00","12:00"),range("14:00","17:00")]);
        ok(await s.cancel(ap));ok(await s.week(s.initial));
        const original=ok(await s.book("09:00","10:30")).appointment,before=await s.row(original);
        const [updated,rejected]=await queued(pool,()=>s.week(next),()=>s.edit(original,{endTime:"12:00"}));
        ok(updated);assert.equal(rejected.body.code,"TIME_UNAVAILABLE");
        assert.deepEqual(await s.row(original),before);
        assert.equal((await pool.query("SELECT 1 FROM appointment_revisions WHERE appointment_id=$1",[original.id])).rowCount,0);
      });

      await t.test("stale all-day confirmations reject changed grids; explicit cell closes serialize with bookings",async()=>{
        const s=await scenario();
        const observed=ok(await s.read(admin));
        const cells=["09:00","09:30","10:00","10:30","11:00","11:30"];
        const [saved,stale]=await queued(pool,()=>s.week({...s.initial,ranges:[range("09:00","13:00")]}),
          ()=>s.patch({close:cells,expectedGrid:{step:observed.step,ranges:observed.ranges}}));
        ok(saved);assert.equal(stale.body.code,"SCHEDULE_DAY_CHANGED");
        const [booked,closed]=await queued(pool,()=>s.book("09:00","10:30"),()=>s.patch({expectedStep:30,close:["09:00"]}));
        const ap=ok(booked).appointment;assert.equal(closed.body.code,"SCHEDULE_CELL_UNAVAILABLE");
        ok(await s.cancel(ap));
        const [closure,rejected]=await queued(pool,()=>s.patch({expectedStep:30,close:["09:00"]}),()=>s.book("09:00","10:30"));
        ok(closure);assert.equal(rejected.body.code,"TIME_UNAVAILABLE");
      });

      await t.test("failure in daily propagation rolls back the template, date configuration and audit together",async()=>{
        const s=await scenario();ok(await s.patch({expectedStep:30,close:["09:00"]}));
        const state=async()=>({w:(await pool.query("SELECT * FROM weekly_schedules WHERE therapist_id=$1",[s.id])).rows,
          d:(await pool.query("SELECT * FROM schedule_days WHERE therapist_id=$1",[s.id])).rows,
          audits:(await pool.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n});
        const before=await state();
        await pool.query(`CREATE FUNCTION reject_live_schedule_test() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected date propagation failure'; END $$`);
        await pool.query("CREATE TRIGGER reject_live_schedule_test BEFORE UPDATE ON schedule_days FOR EACH ROW EXECUTE FUNCTION reject_live_schedule_test()");
        assert.equal((await s.week({...s.initial,ranges:[range("14:00","17:00")]})).status,500);
        assert.deepEqual(await state(),before);
        await pool.query("DROP TRIGGER reject_live_schedule_test ON schedule_days");
      });
    },{beforeMigration:async(file,client)=>{
      if(file!=="025_live_schedule_reconciliation.sql") return;
      const {rows:[person]}=await client.query("INSERT INTO therapists(name,phone) VALUES('迁移测试','13910000090') RETURNING id");
      await client.query(`INSERT INTO schedule_days(therapist_id,date,step,min_duration,ranges,service_item_ids,closed)
        VALUES($1,(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date+1,10,90,$2::jsonb,'{}','{09:10,10:50}')`,
        [person.id,JSON.stringify([range("09:00","12:00")])]);
      const {rows:[day]}=await client.query("SELECT * FROM schedule_days WHERE therapist_id=$1",[person.id]);
      await client.query(`INSERT INTO weekly_schedules(therapist_id,weekday,step,min_duration,ranges,service_item_ids)
        VALUES($1,extract(isodow from $2::date),30,90,$3::jsonb,'{}')`,[person.id,day.date,JSON.stringify([range("14:00","17:00")])]);
      legacy={id:person.id,day};
    }});
  } finally { cleanup(); }
});
