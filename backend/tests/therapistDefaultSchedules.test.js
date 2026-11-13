const test = require("node:test");
const assert = require("node:assert/strict");

test("new therapist weekly defaults are atomic and never replace edited or restored schedules", {
  skip: process.env.RUN_DB_TESTS !== "1"
}, async t => {
  const isolated = require("./audit-2026-10-20/isolated");
  t.after(isolated.cleanup);
  await isolated.withDatabase(async fx => {
    const images = require("../src/services/therapistImageService");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=";
    const uploaded = await images.upload(png);
    const payload = { name: "默认排班测试", phone: "13900000008", bio: "虚构测试资料",
      serviceItemIds: [fx.projects[0].id], ...uploaded };
    const expected = [
      { startTime: "09:00", endTime: "12:00" },
      { startTime: "12:30", endTime: "15:00" },
      { startTime: "15:30", endTime: "18:00" },
      { startTime: "18:30", endTime: "20:30" }
    ];
    const rows = async id => (await fx.pool.query(
      "SELECT weekday,step,min_duration,ranges,service_item_ids FROM weekly_schedules WHERE therapist_id=$1 ORDER BY weekday", [id]
    )).rows;
    const created = await fx.api("/api/admin/therapists", fx.admin, "POST", payload);
    assert.equal(created.status, 200);
    const id = created.body.data.therapist.id;
    assert.deepEqual(await rows(id), Array.from({ length: 7 }, (_, index) => ({
      weekday: index + 1, step: 30, min_duration: 90, ranges: expected, service_item_ids: []
    })));
    for (let weekday = 1; weekday <= 7; weekday++) {
      const read = await fx.api(`/api/admin/schedules/weekly/${id}?weekday=${weekday}`, fx.admin);
      assert.equal(read.status, 200);
      assert.deepEqual(read.body.data.ranges, expected);
      assert.deepEqual(read.body.data.serviceItemIds, [], "specialties must not become available projects implicitly");
    }
    assert.equal((await fx.pool.query("SELECT count(*)::int AS n FROM schedule_days")).rows[0].n, 0);
    assert.deepEqual(await rows(fx.therapistA.id), [], "existing therapists are not backfilled");

    for (const [weekday, schedule] of [
      [2, { step: 30, minDuration: 90, ranges: [] }],
      [3, { step: 15, minDuration: 105, ranges: [{ startTime: "10:15", endTime: "12:00" }] }]
    ]) {
      const edited = await fx.api("/api/admin/schedules/weekly", fx.admin, "PUT", {
        therapistIds: [id], weekdays: [weekday], schedule, serviceItemIds: [fx.projects[0].id]
      });
      assert.equal(edited.status, 200);
    }
    const beforeProfileEdit = await rows(id);
    const { serviceItemIds, ...profile } = payload;
    assert.equal((await fx.api(`/api/admin/therapists/${id}`, fx.admin, "PATCH", {
      ...profile, name: "仅更新资料"
    })).status, 200);
    assert.deepEqual(await rows(id), beforeProfileEdit, "profile edits preserve custom rules and rest days");

    assert.equal((await fx.api(`/api/admin/therapists/${id}`, fx.admin, "DELETE")).status, 200);
    const disabled = await rows(id);
    assert.ok(disabled.every(row => row.ranges.length === 0));
    assert.equal((await fx.api("/api/admin/therapists/restore", fx.admin, "PATCH", { ids: [id] })).status, 200);
    assert.deepEqual(await rows(id), disabled, "restoration still requires manually reopening schedules");
    const count = async table => (await fx.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    const totals = await Promise.all([count("therapists"), count("weekly_schedules"), count("audit_logs")]);
    assert.equal((await fx.api("/api/admin/therapists", fx.customer, "POST", payload)).status, 403);

    // A real database failure halfway through the seven inserts must roll back
    // the therapist, partial week, account binding and audit together.
    await fx.pool.query(`CREATE FUNCTION reject_default_week() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.weekday = 4 THEN RAISE EXCEPTION 'isolated weekly write failure'; END IF; RETURN NEW; END $$`);
    await fx.pool.query("CREATE TRIGGER reject_default_week BEFORE INSERT ON weekly_schedules FOR EACH ROW EXECUTE FUNCTION reject_default_week()");
    const userBefore = (await fx.pool.query("SELECT session_version FROM users WHERE id=$1", [fx.other.id])).rows[0];
    const failed = await fx.api("/api/admin/therapists", fx.admin, "POST", { ...payload, phone: fx.other.phone });
    assert.equal(failed.status, 500);
    assert.deepEqual(await Promise.all([count("therapists"), count("weekly_schedules"), count("audit_logs")]), totals);
    assert.equal((await fx.pool.query("SELECT count(*)::int AS n FROM therapists WHERE user_id=$1", [fx.other.id])).rows[0].n, 0);
    assert.deepEqual((await fx.pool.query("SELECT session_version FROM users WHERE id=$1", [fx.other.id])).rows[0], userBefore);
    await fx.pool.query("DROP TRIGGER reject_default_week ON weekly_schedules");
    const retry = await fx.api("/api/admin/therapists", fx.admin, "POST", { ...payload, phone: fx.other.phone });
    assert.equal(retry.status, 200, "failed initialization leaves no phone or partial-week conflict");
    assert.equal(retry.body.data.therapist.userId, fx.other.id);
    assert.equal((await rows(retry.body.data.therapist.id)).length, 7);
  });
});
