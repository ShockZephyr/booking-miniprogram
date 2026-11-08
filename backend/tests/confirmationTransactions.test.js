const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");

// Two separate HTTP transactions must be queued in order at the actual identity
// lock, so the second operation sees the first one's committed schedule.
async function queued(pool, first, second) {
  const guard = await pool.connect();
  const requests = [];
  try {
    await guard.query("BEGIN");
    await guard.query("SELECT pg_advisory_xact_lock(582302)");
    for (const request of [first, second]) {
      requests.push(request());
      let waiting = 0;
      for (let attempt = 0; attempt < 150 && waiting < requests.length; attempt++) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name=current_setting('application_name') AND wait_event_type='Lock'
          AND query LIKE 'SELECT pg_advisory_xact_lock%'`);
        waiting = rows[0].n;
        if (waiting < requests.length) await delay(10);
      }
      assert.ok(waiting >= requests.length, "both operations must wait for the held lock");
    }
    await guard.query("COMMIT");
    return await Promise.all(requests);
  } finally {
    await guard.query("ROLLBACK");
    guard.release();
    await Promise.allSettled(requests);
  }
}

test("schedule snapshots, ownership and concurrent mutations on isolated PostgreSQL",
  { skip: process.env.RUN_DB_TESTS !== "1" }, async t => {
    const { withDatabase, cleanup } = require("./audit-2026-10-20/isolated");
    try {
      await withDatabase(async f => {
        const { api, pool, admin, customer, staff, other, projects, therapistA: a, therapistB: b } = f;
        await pool.query("INSERT INTO member_whitelist(phone,status) VALUES ($1,'active')", [other.phone]);
        const { todayString } = require("../src/utils/date");
        const date = n => todayString(new Date(Date.now() + n * 86400000));
        const day1 = date(1), day2 = date(2), day3 = date(3);
        const weekdays = [1, 2, 3, 4, 5, 6, 7];
        const rule = (from, to) => ({ step: 30, minDuration: 90, ranges: [{ startTime: from, endTime: to }] });
        const week = (schedule, therapistIds = [a.id, b.id]) => api("/api/admin/schedules/weekly", admin, "PUT",
          { therapistIds, weekdays, schedule, serviceItemIds: projects.slice(0, 2).map(item => item.id) });
        const apply = (id, body) => api(`/api/admin/schedules/day/${id}`, admin, "PATCH", body);
        const read = (id, date, user = customer, edit) => api(`/api/schedules/${id}?date=${date}${edit ? '&appointmentId='+edit : ''}`, user);
        const create = (person, date, startTime, endTime, user = customer) => api("/api/appointments", user, "POST",
          { therapistId: person.id, date, startTime, endTime, serviceItemId: projects[0].id });
        const frozen = async (id, date) => (await pool.query("SELECT 1 FROM schedule_days WHERE therapist_id=$1 AND date=$2", [id, date])).rowCount;
        const ok = response => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data; };

        await t.test("bulk day confirmation compares the observed grid and complete targets under the write lock", async sub => {
          const targetDate = date(6);
          const coarse = rule("09:00", "12:00");
          const fine = { ...coarse, step: 15 };
          const halfHours = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"];
          const quarters = ["09:00", "09:15", "09:30", "09:45", "10:00", "10:15",
            "10:30", "10:45", "11:00", "11:15", "11:30", "11:45"];
          const snapshot = async () => {
            const { step, ranges } = ok(await read(b.id, targetDate, admin));
            return { step, ranges };
          };
          const conflict = response => {
            assert.equal(response.status, 409);
            assert.equal(response.body.code, "SCHEDULE_DAY_CHANGED");
          };
          ok(await week(coarse, [b.id]));
          const coarseGrid = await snapshot();
          const [updated, staleClose] = await queued(pool, () => week(fine, [b.id]),
            () => apply(b.id, { date: targetDate, expectedGrid: coarseGrid, close: halfHours }));
          ok(updated); conflict(staleClose);
          assert.equal(await frozen(b.id, targetDate), 0, "an obsolete confirmation must not freeze the date");
          const fineGrid = await snapshot();
          ok(await week(coarse, [b.id]));
          conflict(await apply(b.id, { date: targetDate, expectedGrid: fineGrid, close: quarters }));
          ok(await week(rule("09:00", "13:00"), [b.id]));
          conflict(await apply(b.id, { date: targetDate, expectedGrid: coarseGrid, close: halfHours }));
          assert.equal(await frozen(b.id, targetDate), 0);

          ok(await week(coarse, [b.id]));
          ok(await apply(b.id, { date: targetDate, expectedStep: 30, close: ["09:00"] }));
          const openGrid = await snapshot();
          const [closed, staleOpen] = await queued(pool, () => apply(b.id, { date: targetDate, expectedStep: 30, close: ["10:00"] }),
            () => apply(b.id, { date: targetDate, expectedGrid: openGrid, open: ["09:00"] }));
          ok(closed); conflict(staleOpen);
          assert.deepEqual(ok(await read(b.id, targetDate, admin)).closed, ["09:00", "10:00"]);
          ok(await apply(b.id, { date: targetDate, expectedGrid: await snapshot(), open: ["09:00", "10:00"] }));
          ok(await apply(b.id, { date: targetDate, expectedGrid: await snapshot(), close: halfHours }));
          assert.deepEqual(ok(await read(b.id, targetDate, admin)).closed, halfHours);

          // A booking can change the complete target set even when the weekly grid is identical.
          ok(await week(coarse, [a.id]));
          const booking = ok(await create(a, targetDate, "09:00", "10:30")).appointment;
          conflict(await apply(a.id, { date: targetDate, expectedGrid: coarseGrid, close: halfHours }));
          ok(await api(`/api/appointments/${booking.id}/cancel`, customer, "PATCH"));
          conflict(await apply(a.id, { date: targetDate, expectedGrid: coarseGrid, close: halfHours.slice(3) }));
          assert.deepEqual(ok(await read(a.id, targetDate, admin)).closed, []);

          // At the boundary the first interval is over; a confirmation that already excluded it remains valid.
          sub.mock.timers.enable({ apis: ["Date"], now: new Date(targetDate + "T09:30:00+08:00") });
          conflict(await apply(a.id, { date: targetDate, expectedGrid: coarseGrid, close: halfHours }));
          ok(await apply(a.id, { date: targetDate, expectedGrid: coarseGrid, close: halfHours.slice(1) }));
          assert.deepEqual(ok(await read(a.id, targetDate, admin)).closed, halfHours.slice(1));
        });

        ok(await week(rule("09:00", "17:00")));
        let booked;
        await t.test("failed requests, reads and unchanged overrides do not freeze; the first booking and template update serialize", async () => {
          ok(await read(a.id, day1));
          ok(await apply(a.id, { date: day1, expectedStep: 30, open: ["09:00"] }));
          assert.equal((await create(a, day1, "08:00", "09:30")).status, 409);
          assert.equal(await frozen(a.id, day1), 0);
          const [created, updated] = await queued(pool, () => create(a, day1, "09:00", "10:30"),
            () => week(rule("13:00", "17:00")));
          booked = ok(created).appointment;
          ok(updated);
          assert.equal(await frozen(a.id, day1), 1);
          assert.equal(ok(await read(a.id, day1)).ranges[0].startTime, "09:00");
          assert.equal(ok(await read(a.id, day2)).ranges[0].startTime, "13:00");
          assert.equal(ok(await read(b.id, day1)).ranges[0].startTime, "13:00");
          const day = ok(await read(a.id, day1, other));
          assert.deepEqual(day.busy, [{ startTime: "09:00", endTime: "10:30" }]);
          assert.equal(Object.hasOwn(day, "appointments"), false);
          assert.equal((await read(a.id, day1, staff)).status, 404);
          assert.equal((await read(a.id, day1, other, booked.id)).status, 404);
          const summary = ok(await read(a.id, day1, admin)).appointments[0];
          assert.equal(summary.id, booked.id);
          assert.equal(summary.userPhone, customer.phone);
          assert.equal(summary.note, null);
          for (const field of ["userId", "userAvatarUrl"]) assert.equal(Object.hasOwn(summary, field), false);
          assert.equal(ok(await read(a.id, day1, customer, booked.id)).busy.length, 0);
        });

        await t.test("an occupied cell and an in-use project are protected; existing dates survive a smaller calendar", async () => {
          assert.equal((await apply(a.id, { date: day1, expectedStep: 30, close: ["09:30"] })).body.code, "SCHEDULE_CELL_UNAVAILABLE");
          assert.equal((await apply(a.id, { date: day1, serviceItemIds: [projects[1].id] })).body.code, "SCHEDULE_PROJECT_IN_USE");
          ok(await apply(a.id, { date: day1, expectedStep: 30, close: ["10:30"], serviceItemIds: [projects[0].id] }));
          assert.equal((await create(a, day1, "10:30", "12:00", other)).status, 409);
          ok(await api("/api/admin/schedules/settings", admin, "PATCH", { daysVisible: 1 }));
          assert.equal((await read(a.id, day1)).body.code, "DATE_OUT_OF_RANGE");
          ok(await read(a.id, day1, customer, booked.id));
          assert.equal((await read(a.id, day1, other, booked.id)).status, 404);
          const revision = ok(await api(`/api/appointments/${booked.id}/modify`, customer, "PATCH", { note: "已确认" })).appointment;
          assert.equal(revision.id, booked.id);
          ok(await api(`/api/appointments/${booked.id}/cancel`, customer, "PATCH"));
          assert.equal(await frozen(a.id, day1), 1);
          ok(await api("/api/admin/schedules/settings", admin, "PATCH", { daysVisible: 7 }));
          assert.deepEqual(ok(await read(a.id, day1)).closed, ["10:30"]);
          ok(await apply(a.id, { date: day1, expectedStep: 30, open: ["10:30"] }));
        });

        await t.test("closing an empty cell first blocks booking; booking first protects its cells", async () => {
          const [closed, denied] = await queued(pool,
            () => apply(a.id, { date: day2, expectedStep: 30, close: ["13:30"] }), () => create(a, day2, "13:00", "14:30"));
          ok(closed);
          assert.equal(denied.status, 409);
          assert.equal((await pool.query("SELECT 1 FROM appointments WHERE therapist_id=$1 AND date=$2", [a.id, day2])).rowCount, 0);
          const [created, rejected] = await queued(pool, () => create(a, day3, "13:00", "14:30"),
            () => apply(a.id, { date: day3, expectedStep: 30, close: ["14:00"] }));
          ok(created);
          assert.equal(rejected.body.code, "SCHEDULE_CELL_UNAVAILABLE");
          assert.deepEqual(ok(await read(a.id, day3)).closed, []);
          const [extended, competing] = await queued(pool,
            () => api(`/api/appointments/${created.body.data.appointment.id}/modify`, customer, "PATCH", {endTime: "15:00"}),
            () => create(a, day3, "14:30", "16:00", other));
          assert.equal(ok(extended).appointment.endTime, "15:00");
          assert.equal(competing.body.code, "APPOINTMENT_CONFLICT");
          ok(await create(a, day3, "15:00", "16:30", other));
          ok(await create(b, day3, "13:00", "14:30", other));
          const summary = ok(await read(b.id, day3, staff)).appointments[0];
          assert.equal(summary.userPhone, "139****0004");
          assert.equal(ok(await api(`/api/therapist/appointments/${summary.id}`, staff)).appointment.userPhone, "139****0004");
        });

        await t.test("direct writes are constrained by therapist and member even across groups", async () => {
          const insert = (user, therapist) => pool.query(`INSERT INTO appointments
            (user_id,therapist_id,service_item_id,date,start_time,end_time) VALUES ($1,$2,$3,$4,'13:00','14:30')`,
            [user, therapist, projects[0].id, day3]);
          await assert.rejects(() => insert(admin.id, a.id), { code: "23P01", constraint: "no_overlapping_appointments_per_therapist" });
          const c = (await pool.query("INSERT INTO therapists(name) VALUES('临时芳疗师') RETURNING id")).rows[0];
          await assert.rejects(() => insert(customer.id, c.id), { code: "23P01", constraint: "no_overlapping_appointments_per_user" });
        });

        await t.test("extending an appointment and closing that exact cell serialize in either arrival order", async () => {
          const day4 = date(4);
          const original = ok(await create(a, day4, "13:00", "14:30")).appointment;
          const extend = () => api(`/api/appointments/${original.id}/modify`, customer, "PATCH", { endTime: "15:00", version: original.version });
          const close = () => apply(a.id, { date: day4, expectedStep: 30, close: ["14:30"] });
          const [closed, blockedEdit] = await queued(pool, close, extend);
          ok(closed);
          assert.equal(blockedEdit.body.code, "TIME_UNAVAILABLE");
          assert.equal(ok(await api(`/api/appointments/${original.id}`, customer)).appointment.endTime, "14:30");
          ok(await apply(a.id, { date: day4, expectedStep: 30, open: ["14:30"] }));
          const [edited, blockedClose] = await queued(pool, extend, close);
          assert.equal(ok(edited).appointment.endTime, "15:00");
          assert.equal(blockedClose.body.code, "SCHEDULE_CELL_UNAVAILABLE");
          assert.deepEqual(ok(await read(a.id, day4)).closed, []);
        });

        await t.test("check-in and editing the same appointment see the preceding commit in either order", async sub => {
          const serviceDay = date(5);
          sub.mock.timers.enable({ apis: ["Date"], now: new Date(serviceDay + "T12:30:00+08:00") });
          for (const signFirst of [true, false]) {
            const person = signFirst ? a : b, owner = signFirst ? customer : other;
            const original = ok(await create(person, serviceDay, "13:00", "14:30", owner)).appointment;
            const sign = () => api(`/api/admin/appointments/${original.id}/check-in`, admin, "PATCH");
            const edit = () => api(`/api/appointments/${original.id}/modify`, owner, "PATCH",
              { endTime: "15:00", version: original.version });
            const results = signFirst ? await queued(pool, sign, edit) : await queued(pool, edit, sign);
            ok(results[0]);
            if (signFirst) assert.equal(results[1].body.code, "APPOINTMENT_VERSION_CONFLICT");
            else ok(results[1]);
            const { appointment, history } = ok(await api(`/api/admin/appointments/${original.id}`, admin));
            assert.equal(appointment.id, original.id);
            assert.equal(appointment.status, "checked_in");
            assert.ok(appointment.checkedInAt);
            assert.equal(appointment.endTime, signFirst ? "14:30" : "15:00");
            assert.equal(history.length, signFirst ? 0 : 1);
          }
        });

        await t.test("own detail remains readable without membership; retired slot routes reject writes", async () => {
          await pool.query("UPDATE member_whitelist SET status='inactive' WHERE phone=$1", [customer.phone]);
          const route = `/api/appointments/${booked.id}`;
          ok(await api(route, customer));
          assert.equal((await api(route, other)).status, 404);
          assert.equal((await api(route, admin)).status, 403);
          assert.equal((await api(route, staff)).status, 403);
          assert.equal((await api("/api/admin/slots/batch-create", admin, "POST", {})).status, 404);
          assert.equal((await api("/api/slots?date="+day1, customer)).status, 404);
        });
      });
    } finally { cleanup(); }
  });
