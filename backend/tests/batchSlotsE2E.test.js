const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const formEvents = require("./support/weeklyFormEvents");

test.after(() => {
  if (process.env.RUN_DB_TESTS === "1") require("./audit-2026-10-20/isolated").cleanup();
});

// Only WeChat rendering, navigation and native dialogs are replaced. The page
// loads its real client services and talks HTTP to the isolated PostgreSQL app.
function miniProgram(origin) {
  const root = path.resolve(__dirname, "../../miniprogram");
  const cache = new Map(), definitions = new Map(), storage = new Map(), navigation = [], stack = [];
  const app = { globalData: {}, _loginSessionVersion: 0 };
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key,v) => storage.set(key,v), removeStorageSync: key => storage.delete(key),
    showToast() {}, setNavigationBarTitle() {},
    showModal(opts) { opts.success({ confirm: true }); if (opts.complete) opts.complete(); },
    navigateTo(opts) { navigation.push(opts.url); if (opts.success) opts.success(); },
    redirectTo(opts) { navigation.push(opts.url); if (opts.success) opts.success(); }, navigateBack(opts) { navigation.push(opts.delta); if (opts.success) opts.success(); },
    request(opts) {
      assert.equal(new URL(opts.url).origin, origin);
      fetch(opts.url, { method: opts.method, headers: opts.header, body: opts.method === "GET" ? undefined : JSON.stringify(opts.data),
        signal: AbortSignal.timeout(10000) }).then(async res => opts.success({ statusCode: res.status, data: await res.json() })).catch(opts.fail);
    }
  };
  function load(file) {
    if (file === path.join(root, "config/env.js")) return { API_BASE_URL: origin, REQUEST_TIMEOUT: 10000 };
    if (cache.has(file)) return cache.get(file);
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
      require: name => load(path.resolve(path.dirname(file), name + ".js")), module: mod, exports: mod.exports,
      Page: def => definitions.set(file,def), Component: def => definitions.set(file,def),
      Date, wx, getApp: () => app, getCurrentPages: () => stack, setInterval: () => 1, clearInterval() {},
      setTimeout, clearTimeout, console
    }, { filename: file });
    cache.set(file,mod.exports); return mod.exports;
  }
  function screen(route, properties) {
    const file = path.join(root, route + ".js"); load(file);
    const def = definitions.get(file);
    const instance = Object.assign({ route, properties }, def.methods || def);
    instance.data = JSON.parse(JSON.stringify(def.data));
    instance.setData = (patch,cb) => { Object.assign(instance.data,patch); if (cb) cb(); };
    if (route === "pages/admin/batch-slots/index") formEvents.install(instance);
    return instance;
  }
  async function login(fx,user) {
    const token = await fx.tokenFor(user);
    const {body} = await fx.api("/api/auth/me",user,"GET",null,token);
    assert.ok(body.data && body.data.user);
    app.globalData = { token, user: body.data.user }; app._loginSessionVersion++;
  }
  async function grid(target) {
    const view = screen("components/day-schedule/index", { target, visible:true });
    view._attached = true; view.triggerEvent = () => {};
    await view.load(); assert.equal(view.data.error,""); return view;
  }
  return { screen, grid, login, navigation, stack, app };
}
const tap = obj => ({ currentTarget:{dataset:obj} });
const change = value => ({ detail:{value} });
async function settle(predicate) {
  for (let i=0;i<500;i++) { if (predicate()) return; await new Promise(r=>setTimeout(r,10)); }
  assert.fail("page did not settle");
}

test("week template, day controls, customer time selection, forms and roles through local HTTP/PostgreSQL", {skip:process.env.RUN_DB_TESTS!=="1"}, async t => {
  const isolated = require("./audit-2026-10-20/isolated");
  const date = "2034-04-04", weekday = new Date(date).getUTCDay() || 7;
  t.mock.timers.enable({apis:["Date"],now:new Date(date+"T09:05:00+08:00")});
  await isolated.withDatabase(async fx => {
    const client = miniProgram(fx.origin), project = fx.projects[0].id, id = fx.therapistB.id;
    const target = {therapistId:id,date};
    await client.login(fx,fx.admin);
    const editor = client.screen("pages/admin/batch-slots/index"); editor.onLoad({});
    await editor.onShow(); assert.equal(editor.data.error,"");
    editor.selectPeople(change([fx.therapistA.id,id])); editor.pickDays(change([String(weekday)]));
    editor.selectProjects(change([project]));
    while (editor.data.ranges.length) editor.removeRange(tap({index:0}));
    editor.addRange();
    editor.setTime(tapAndValue({index:0,field:"endTime"}, editor.data.times.indexOf("14:00")));
    await editor.save();
    const rule = (await fx.api("/api/admin/schedules/weekly/"+id+"?weekday="+weekday,fx.admin)).body.data;
    assert.deepEqual(rule.ranges,[{startTime:"09:00",endTime:"14:00"}]);
    const adminDay = await client.grid(target);
    adminDay.tapPoint(tap({time:"12:00",viewVersion:adminDay.data.viewVersion}));
    await adminDay.applyDay(tap({action:"close",viewVersion:adminDay.data.viewVersion}));
    assert.ok(adminDay.data.day.closed.includes("12:00"));
    await client.login(fx,fx.customer);
    const list = client.screen("pages/booking/index"); list.onLoad(); await list.onShow();
    assert.ok(list.data.therapists.some(x=>x.id===id));
    list.openDay(tap({id})); assert.match(client.navigation.at(-1),/schedule-day/);
    let day = await client.grid(target);
    day.tapPoint(tap({viewVersion:day.data.viewVersion,time:"09:00"})); day.tapPoint(tap({viewVersion:day.data.viewVersion,time:"10:30"}));
    assert.equal(day.data.nextReady,true);
    async function confirm(note) {
      assert.equal(day.data.error,""); assert.equal(day.data.nextReady,true);
      day.pickItem(tapAndValue({viewVersion:day.data.viewVersion},[day.data.items[0].id])); day.inputNote(tapAndValue({viewVersion:day.data.viewVersion},note)); day.submit();
      await settle(()=>day.data.saved || day.data.notice);
      assert.equal(day.data.saved,true, day.data.notice);
      return day;
    }
    let form = await confirm("首次提交"); form.returnToAppointments(); form.stop(); form._attached = false;
    const my = async (user)=> (await fx.api("/api/appointments/my?status=all",user)).body.data.appointments;
    const [first] = await my(fx.customer); assert.equal(first.note,"首次提交");
    await client.login(fx,fx.other);
    let other = await client.grid(target);
    other.tapPoint(tap({viewVersion:other.data.viewVersion,time:"09:00"})); assert.equal(other.data.start,"");
    other.tapPoint(tap({viewVersion:other.data.viewVersion,time:"10:30"})); other.tapPoint(tap({viewVersion:other.data.viewVersion,time:"12:00"}));
    assert.equal(other.data.duration,90,"an appointment may end at the start of a closed cell");
    const signed = await fx.api("/api/therapist/appointments/"+first.id+"/check-in",fx.staff,"PATCH");
    assert.equal(signed.status,200);
    await client.login(fx,fx.customer);
    const source = client.screen("pages/my-appointments/index"); source.data.canBook = true;
    source.cardAction({detail:{type:"modify",appointment:first}});
    assert.ok(client.navigation.at(-1).includes("appointmentId="+first.id));
    day = await client.grid({...target,appointmentId:first.id});
    assert.equal(day.data.fixed,"09:00"); day.tapPoint(tap({viewVersion:day.data.viewVersion,time:"11:00"}));
    client.stack.push(source,{route:"pages/schedule-day/index"});
    form = await confirm("已续时"); form.returnToAppointments();
    assert.equal(client.navigation.at(-1),1); form.stop(); form._attached = false;
    for (const rows of [await my(fx.customer),
      (await fx.api("/api/therapist/appointments?status=all",fx.staff)).body.data.appointments,
      (await fx.api("/api/admin/appointments?status=all",fx.admin)).body.data.appointments]) {
      assert.equal(rows.length,1); assert.equal(rows[0].id,first.id); assert.equal(rows[0].endTime,"11:00");
      assert.equal(rows[0].status,"checked_in"); assert.equal(rows[0].note,"已续时");
    }
    const history = (await fx.api("/api/admin/appointments/"+first.id,fx.admin)).body.data.history;
    assert.equal(history.length,1); assert.equal(history[0].before.endTime,"10:30");
    await fx.api("/api/admin/appointments/"+first.id+"/uncheck-in",fx.admin,"PATCH");
    assert.equal((await fx.api("/api/appointments/"+first.id+"/cancel",fx.customer,"PATCH")).status,200);
    other = await client.grid(target);
    other.tapPoint(tap({viewVersion:other.data.viewVersion,time:"09:00"})); assert.equal(other.data.start,"09:00","cancellation releases its own range");
  });
});
function tapAndValue(dataset,value) { return {currentTarget:{dataset},detail:{value}}; }

test("sorted weekly edits and gap insertion persist through actual HTTP while keeping per-admin prefill", {
  skip: process.env.RUN_DB_TESTS !== "1"
}, async t => {
  const isolated = require("./audit-2026-10-20/isolated");
  await isolated.withDatabase(async fx => {
    const client = miniProgram(fx.origin);
    await client.login(fx, fx.admin);
    const editor = client.screen("pages/admin/batch-slots/index"); editor.onLoad({}); await editor.onShow();
    editor.selectPeople(change([fx.therapistA.id, fx.therapistB.id]));
    editor.pickDays(change(["1", "2"])); editor.selectProjects(change([fx.projects[0].id]));
    const [morning, afternoon, lateAfternoon, evening] = editor.data.ranges;
    const edit = (key, field, time) => editor.setTime(tapAndValue({ key, index: 99, field }, editor.data.times.indexOf(time)));
    edit(evening.key, "endTime", "08:00"); // Auto-adjust its start to 06:30, then sort.
    assert.equal(editor.data.ranges[0].key, evening.key);
    editor.addRange(tap({ key: morning.key, index: 0 })); // Fill the short 12:00–12:30 gap; merge on save.
    const inserted = editor.data.ranges.find(r => ![morning.key, afternoon.key, lateAfternoon.key, evening.key].includes(r.key));
    assert.equal(inserted.startTime, "12:00"); assert.equal(inserted.endTime, "12:30");
    editor.removeRange(tap({ key: afternoon.key, index: 0 }));
    edit(afternoon.key, "startTime", "15:00"); // Late event for a deleted row must not edit a different row.
    edit(morning.key, "startTime", "10:00"); // Keeps its sufficiently long existing end.
    edit(inserted.key, "endTime", "13:00"); // Auto-adjusts start to 11:30, an overlap is not saved.
    await editor.save();
    assert.equal((await fx.pool.query("SELECT count(*)::int AS n FROM weekly_schedules")).rows[0].n, 0);
    edit(inserted.key, "startTime", "12:00"); // Repairs end to 13:30; adjacent groups merge on the server.
    await editor.save();
    assert.equal(editor.data.saving, false);
    const formRanges = JSON.parse(JSON.stringify(editor.data.ranges.map(({ startTime, endTime }) => ({ startTime, endTime }))));
    assert.deepEqual(formRanges, [
      { startTime: "06:30", endTime: "08:00" },
      { startTime: "10:00", endTime: "12:00" },
      { startTime: "12:00", endTime: "13:30" },
      { startTime: "15:30", endTime: "18:00" }
    ]);
    for (const id of [fx.therapistA.id, fx.therapistB.id]) for (const weekday of [1, 2]) {
      const rule = (await fx.api(`/api/admin/schedules/weekly/${id}?weekday=${weekday}`, fx.admin)).body.data;
      assert.deepEqual(rule.ranges, [{ startTime: "06:30", endTime: "08:00" }, { startTime: "10:00", endTime: "13:30" }, { startTime: "15:30", endTime: "18:00" }]);
      assert.equal(rule.minDuration, 90); assert.equal(rule.step, 30);
      assert.deepEqual(rule.serviceItemIds, [fx.projects[0].id]);
    }
    editor.onUnload();
    const reopened = client.screen("pages/admin/batch-slots/index"); reopened.onLoad({}); await reopened.onShow();
    assert.deepEqual(JSON.parse(JSON.stringify(reopened.data.ranges.map(({ startTime, endTime }) => ({ startTime, endTime })))), formRanges);
    assert.deepEqual(Array.from(reopened.data.selectedDays), [1, 2]);
    const oldMinimum = formEvents.formEvent(reopened, change("180"));
    const oldProjects = formEvents.formEvent(reopened, change([fx.projects[1].id]));
    const oldSelectAll = formEvents.formEvent(reopened);
    await fx.pool.query("UPDATE users SET role='admin' WHERE id=$1", [fx.other.id]);
    await client.login(fx, fx.other); await reopened.onShow();
    reopened.setMinimum(oldMinimum); reopened.selectProjects(oldProjects);
    reopened.allPeople(oldSelectAll); reopened.allDays(oldSelectAll); await reopened.save(oldSelectAll);
    assert.equal(reopened.data.therapistIds.length, 0);
    assert.equal(reopened.data.selectedDays.length, 0);
    assert.equal(reopened.data.minDuration, "90"); assert.equal(reopened.data.projectIds.length, 0);
    assert.equal(reopened.data.ranges[0].startTime, "09:00");
    reopened.selectPeople(change([fx.therapistB.id])); reopened.pickDays(change(["3"]));
    reopened.setMinimum(change("120")); reopened.selectProjects(change([fx.projects[0].id]));
    await reopened.save();
    const otherRule = (await fx.api(`/api/admin/schedules/weekly/${fx.therapistB.id}?weekday=3`, fx.other)).body.data;
    assert.equal(otherRule.minDuration, 120); assert.deepEqual(otherRule.serviceItemIds, [fx.projects[0].id]);
    edit(morning.key, "startTime", "11:00");
    await client.login(fx, fx.admin); await reopened.onShow();
    assert.deepEqual(JSON.parse(JSON.stringify(reopened.data.ranges.map(({ startTime, endTime }) => ({ startTime, endTime })))), formRanges);
    assert.equal(reopened.data.minDuration, "90");
    await client.login(fx, fx.other); await reopened.onShow();
    assert.equal(reopened.data.minDuration, "120"); assert.deepEqual(Array.from(reopened.data.selectedDays), [3]);
  });
});

test("single therapist multi-day drafts save distinct changes through real frontend services and HTTP", {
  skip: process.env.RUN_DB_TESTS !== "1"
}, async () => {
  await require("./audit-2026-10-20/isolated").withDatabase(async fx => {
    const client = miniProgram(fx.origin), id = fx.therapistB.id;
    await client.login(fx, fx.admin);
    const editor = client.screen("pages/admin/batch-slots/index"); editor.onLoad({ therapistId: id }); await editor.onShow();
    assert.equal(editor.data.ranges.length, 0); await editor.save();
    assert.equal((await fx.pool.query("SELECT count(*)::int AS n FROM weekly_schedules")).rows[0].n, 0);
    editor.addRange(); editor.selectProjects(change([fx.projects[0].id]));
    const oldMonday = formEvents.formEvent(editor, change("180"));
    await editor.pickWeekday(tap({ day: 3 })); editor.addRange(); editor.setStep(change("15"));
    editor.setMinimum(change("105")); editor.selectProjects(change([fx.projects[1].id]));
    editor.setTime(tapAndValue({ key: editor.data.ranges[0].key, field: "startTime" }, editor.data.times.indexOf("14:00")));
    assert.equal(editor.data.ranges[0].endTime, "15:45");
    await editor.pickWeekday(tap({ day: 7 })); // Read only: never submit this day.
    await editor.pickWeekday(tap({ day: 1 })); editor.setMinimum(oldMonday);
    assert.equal(editor.data.minDuration, "90"); assert.deepEqual(Array.from(editor.data.dirtyDays), [1, 3]);
    await editor.save(); assert.equal(editor.data.saving, false); assert.equal(editor.data.weekNotice, "");
    assert.equal(editor.data.dirtyDays.length, 0);
    const { rows } = await fx.pool.query('SELECT weekday,step,min_duration AS "minDuration",ranges,service_item_ids AS "items" FROM weekly_schedules WHERE therapist_id=$1 ORDER BY weekday', [id]);
    assert.deepEqual(rows, [
      { weekday: 1, step: 30, minDuration: 90, ranges: [{ startTime: "09:00", endTime: "12:00" }], items: [fx.projects[0].id] },
      { weekday: 3, step: 15, minDuration: 105, ranges: [{ startTime: "14:00", endTime: "15:45" }], items: [fx.projects[1].id] }
    ]);
    await editor.save(); assert.equal((await fx.pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='update_weekly_schedule_days'")).rows[0].n, 1);
    editor.onUnload();
    const again = client.screen("pages/admin/batch-slots/index"); again.onLoad({ therapistId: id }); await again.onShow();
    await again.pickWeekday(tap({ day: 3 })); assert.equal(again.data.minDuration, "105"); assert.equal(again.data.ranges[0].startTime, "14:00");
    const bulk = client.screen("pages/admin/batch-slots/index"); bulk.onLoad({}); await bulk.onShow();
    assert.equal(bulk.data.therapistIds.length, 0); assert.equal(bulk.data.selectedDays.length, 0); assert.equal(bulk.data.minDuration, "90");
  });
});

test("multi-day HTTP updates validate all inputs, roll back later failures, update date bases and recheck authority", {
  skip: process.env.RUN_DB_TESTS !== "1"
}, async () => {
  await require("./audit-2026-10-20/isolated").withDatabase(async fx => {
    const id = fx.therapistB.id, url = `/api/admin/schedules/weekly/${id}`;
    const initial = { step: 30, minDuration: 90, ranges: [{ startTime: "09:00", endTime: "17:00" }] };
    const original = await fx.api("/api/admin/schedules/weekly", fx.admin, "PUT", {
      therapistIds: [id], weekdays: [1, 2, 3, 4, 5, 6, 7], schedule: initial, serviceItemIds: [fx.projects[0].id]
    });
    assert.equal(original.status, 200);
    const frozen = await fx.api(`/api/admin/schedules/day/${id}`, fx.admin, "PATCH", { date: fx.tomorrow, expectedStep: 30, close: ["09:00"] });
    assert.equal(frozen.status, 200);
    const day1 = new Date(fx.tomorrow).getUTCDay() || 7, day2 = day1 % 7 + 1;
    const body = { days: [
      { weekday: day1, schedule: { step: 30, minDuration: 90, ranges: [{ startTime: "10:00", endTime: "12:00" }, { startTime: "12:00", endTime: "13:00" }] }, serviceItemIds: [fx.projects[0].id] },
      { weekday: day2, schedule: { step: 15, minDuration: 105, ranges: [{ startTime: "14:00", endTime: "18:00" }] }, serviceItemIds: [fx.projects[1].id] }
    ] };
    const state = async () => (await fx.pool.query("SELECT * FROM weekly_schedules ORDER BY therapist_id,weekday")).rows;
    const baseline = await state(), snapshot = (await fx.pool.query("SELECT * FROM schedule_days")).rows;
    const auditCount = async () => (await fx.pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='update_weekly_schedule_days'")).rows[0].n;
    for (const invalid of [null, {}, { days: [] }, { days: [body.days[0], body.days[0]] }, { days: [{ ...body.days[0], weekday: 8 }] },
      { days: [{ ...body.days[0], extra: true }] }, { days: [{ ...body.days[0], serviceItemIds: undefined }] },
      { days: [body.days[0], { ...body.days[1], schedule: { ...body.days[1].schedule, minDuration: 91 } }] }]) {
      const response = await fx.api(url, fx.admin, "PUT", invalid);
      assert.equal(response.status, 400);
      assert.deepEqual(await state(), baseline);
    }
    const badProject = await fx.api(url, fx.admin, "PUT", { days: [body.days[0], { ...body.days[1], serviceItemIds: ["99999999-0000-4000-8000-000000000001"] }] });
    assert.equal(badProject.status, 409); assert.match(badProject.body.message, /周[一二三四五六日]/);
    for (const actor of [fx.customer, fx.staff]) assert.equal((await fx.api(url, actor, "PUT", body)).status, 403);
    assert.deepEqual(await state(), baseline); assert.equal(await auditCount(), 0);

    // Force the later sorted write to fail, after an earlier weekday was updated.
    const failingDay = Math.max(day1, day2);
    await fx.pool.query(`CREATE FUNCTION reject_weekly_test_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.weekday=${failingDay} THEN RAISE EXCEPTION 'injected weekly write failure'; END IF; RETURN NEW; END $$`);
    await fx.pool.query("CREATE TRIGGER reject_weekly_test_write BEFORE INSERT OR UPDATE ON weekly_schedules FOR EACH ROW EXECUTE FUNCTION reject_weekly_test_write()");
    const rejected = await fx.api(url, fx.admin, "PUT", body);
    assert.equal(rejected.status, 500); assert.deepEqual(await state(), baseline); assert.equal(await auditCount(), 0);
    assert.deepEqual((await fx.pool.query("SELECT * FROM schedule_days")).rows, snapshot);
    await fx.pool.query("DROP TRIGGER reject_weekly_test_write ON weekly_schedules");

    const success = await fx.api(url, fx.admin, "PUT", body);
    assert.equal(success.status, 200); assert.equal(success.body.data.updated, 2);
    assert.deepEqual(success.body.data.days.find(d => d.weekday === day1).schedule.ranges, [{ startTime: "10:00", endTime: "13:00" }]);
    assert.deepEqual((await state()).filter(d => ![day1, day2].includes(d.weekday)), baseline.filter(d => ![day1, day2].includes(d.weekday)));
    const updatedDay = (await fx.pool.query("SELECT * FROM schedule_days WHERE therapist_id=$1 AND date=$2", [id, fx.tomorrow])).rows[0];
    assert.deepEqual(updatedDay.ranges, [{ startTime: "10:00", endTime: "13:00" }]);
    assert.deepEqual(updatedDay.manual_closed_ranges, snapshot[0].manual_closed_ranges);
    assert.equal(await auditCount(), 1);

    // Middleware saw an administrator, but the transaction must recheck after waiting.
    const beforeRevoke = await state(), guard = await fx.pool.connect();
    let pending;
    try {
      await guard.query("BEGIN"); await guard.query("SELECT pg_advisory_xact_lock(582302)");
      pending = fx.api(url, fx.admin, "PUT", { days: [{ ...body.days[0], serviceItemIds: [] }] });
      let waiting = false;
      for (let i = 0; i < 150; i++) {
        const result = await fx.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'");
        if (result.rowCount) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true);
      await guard.query("UPDATE users SET role='user' WHERE id=$1", [fx.admin.id]); await guard.query("COMMIT");
      const denied = await pending; assert.equal(denied.status, 403);
      assert.deepEqual(await state(), beforeRevoke); assert.equal(await auditCount(), 1);
    } finally {
      await guard.query("ROLLBACK"); guard.release();
      if (pending) await pending;
    }
  });
});
