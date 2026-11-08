const test = require("node:test");
const assert = require("node:assert/strict");

test("roster filters read effective date rules, personal conflicts and public options through HTTP/PostgreSQL without freezing dates", {
  skip: process.env.RUN_DB_TESTS !== "1"
}, async t => {
  const isolated = require("./audit-2026-10-20/isolated");
  t.after(isolated.cleanup);
  await isolated.withDatabase(async ({ pool, api, admin, customer, staff, therapistA, therapistB, projects, tomorrow: date }) => {
    // All rows are synthetic fixtures in the helper's fresh temporary schema.
    const projectIds = projects.map(item => item.id);
    for (const [person, minimum] of [[therapistA, 60], [therapistB, 90]]) {
      await pool.query(`INSERT INTO weekly_schedules(therapist_id,weekday,step,min_duration,ranges,service_item_ids)
        VALUES($1,extract(isodow from $2::date),30,$3,$4::jsonb,$5)`,
      [person.id, date, minimum, JSON.stringify([{ startTime: "09:00", endTime: "12:00" }]), projectIds]);
    }
    const read = (user, extra = "") => api(`/api/schedules?date=${date}&withFilters=1&startTime=10%3A00&endTime=11%3A00${extra}`, user);
    let result = await read(customer);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.therapists.map(p => p.id), [therapistA.id]);
    assert.equal(result.body.data.minDuration, 60);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM schedule_days")).rows[0].n, 0);
    const booking = await api("/api/appointments", customer, "POST", { therapistId: therapistB.id, date,
      startTime: "09:00", endTime: "10:30", serviceItemId: projects[0].id });
    assert.equal(booking.status, 200);
    result = await read(customer);
    assert.equal(result.body.data.therapists.length, 0, "the customer's B booking also blocks matching A starts");
    result = await read(admin);
    assert.deepEqual(result.body.data.therapists.map(p => p.id), [therapistA.id], "admin retains full staff view");
    result = await read(staff, `&therapistIds=${therapistA.id}`);
    assert.deepEqual(result.body.data.filterOptions.therapists.map(p => p.id), [therapistB.id]);
    await pool.query("UPDATE weekly_schedules SET min_duration=60 WHERE therapist_id=$1", [therapistB.id]);
    result = await read(admin, `&therapistIds=${therapistB.id}`);
    assert.equal(result.body.data.minDuration, 90, "a frozen date keeps its original minimum");
    assert.equal(result.body.data.appliedFilters.endTime, "11:30");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM schedule_days")).rows[0].n, 1, "reads do not freeze A");
    assert.doesNotMatch(JSON.stringify(result.body.data), /phone|openid|userId|userPhone/);
    const malformed = await api(`/api/schedules?date=${date}&therapistIds=invalid`, admin);
    assert.equal(malformed.status, 400); assert.equal(malformed.body.code, "INVALID_FILTER");
  });
});
