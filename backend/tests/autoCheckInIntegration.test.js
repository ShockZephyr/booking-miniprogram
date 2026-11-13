const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");

// Arrange competing real transactions at the shared identity lock in order.
async function queued(pool, ...operations) {
  const guard = await pool.connect(), pending = [];
  try {
    await guard.query("BEGIN");
    await guard.query("SELECT pg_advisory_xact_lock(582302)");
    for (const operation of operations) {
      pending.push(operation());
      let waiting = 0;
      for (let i = 0; i < 150 && waiting < pending.length; i++) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name=current_setting('application_name') AND wait_event_type='Lock'
          AND query LIKE 'SELECT pg_advisory_xact_lock%'`);
        waiting = rows[0].n;
        if (waiting < pending.length) await delay(10);
      }
      assert.ok(waiting >= pending.length, "operation must reach the actual database lock");
    }
    await guard.query("COMMIT");
    return await Promise.all(pending);
  } finally {
    await guard.query("ROLLBACK");
    guard.release();
    await Promise.allSettled(pending);
  }
}

test("expired auto check-in with isolated PostgreSQL and real HTTP", {
  skip: process.env.RUN_DB_TESTS !== "1"
}, async t => {
  const isolated = require("./audit-2026-10-20/isolated");
  try {
    await isolated.withDatabase(async h => {
      const { pool, api, admin, customer, other, staff, therapistA, therapistB, projects } = h;
      const { createAutoCheckInService } = require("../src/services/autoCheckInService");
      const repo = require("../src/repositories/autoCheckInRepository");
      const appointmentRepo = require("../src/repositories/appointmentRepository");
      const now = "2020-03-01T16:05:00.000Z"; // March 2 00:05 Shanghai; cutoff Feb 29.
      const job = (clock = now, deps = {}) => createAutoCheckInService({ now: () => clock, ...deps });
      const reset = async () => {
        // Only the helper-created schema, never development data.
        await pool.query("DELETE FROM appointment_revisions");
        await pool.query("DELETE FROM appointments");
        await pool.query("DELETE FROM appointment_auto_check_in_runs");
        await pool.query("DELETE FROM business_logs");
      };
      const add = async (date = "2020-02-29", status = "no_show", opts = {}) => {
        const a = await h.addAppointment(h.bookingTime({ date, start: opts.start || "09:00",
          end: opts.end || "10:30", therapist: opts.therapist || therapistA }), { status, user: opts.user || customer });
        if (status === "no_show") await pool.query("UPDATE appointments SET no_show_at=$2 WHERE id=$1", [a.id, "2020-02-29T02:30:00Z"]);
        if (status === "checked_in") await pool.query("UPDATE appointments SET checked_in_at=$2 WHERE id=$1", [a.id, "2020-02-29T01:01:00Z"]);
        return a;
      };
      const row = async a => (await pool.query("SELECT * FROM appointments WHERE id=$1", [a.id])).rows[0];
      const logs = async () => (await pool.query("SELECT * FROM business_logs WHERE action='auto_check_in_expired' ORDER BY created_at, id")).rows;
      const patch = (a, operation, user = admin) => api(`/api/admin/appointments/${a.id}/${operation}`, user, "PATCH");

      await t.test("date cutoff includes all of day-before-yesterday and older, not yesterday/today/future", async () => {
        await reset();
        const old = await add("2019-12-31");
        const target = await add("2020-02-29", "no_show", { start: "22:00", end: "23:30" });
        const overdueBooked = await add("2020-02-28", "booked");
        const excluded = [await add("2020-03-01"), await add("2020-03-02"), await add("2020-03-03"),
          await add("2020-02-27", "cancelled"), await add("2020-02-26", "checked_in")];
        const before = await Promise.all(excluded.map(row));
        assert.equal((await job().checkInExpired()).checkedIn, 3);
        for (const a of [old, target, overdueBooked]) {
          const after = await row(a);
          assert.equal(after.status, "checked_in");
          assert.equal(after.checked_in_at.toISOString(), now);
          assert.equal(after.no_show_at, null);
          assert.equal(after.version, a.version + 1);
        }
        assert.deepEqual(await Promise.all(excluded.map(row)), before);
        assert.equal((await logs()).length, 3);
      });

      await t.test("database clock uses Shanghai date and inclusive 00:05 with leap/year boundaries", async () => {
        for (const [instant, date, cutoff, due] of [
          ["2020-03-01T15:59:59Z", "2020-03-01", "2020-02-28", true],
          ["2020-03-01T16:00:00Z", "2020-03-02", "2020-02-29", false],
          ["2020-03-01T16:04:59.999Z", "2020-03-02", "2020-02-29", false],
          [now, "2020-03-02", "2020-02-29", true],
          ["2020-12-31T16:05:00Z", "2021-01-01", "2020-12-30", true]
        ]) {
          const window = await repo.windowForRun(null, instant);
          assert.equal(window.runDate, date); assert.equal(window.cutoffDate, cutoff); assert.equal(window.due, due);
        }
        const before = Date.now(), actual = await repo.windowForRun(null);
        assert.ok(actual.executedAt.getTime() >= before - 1000 && actual.executedAt.getTime() <= Date.now() + 1000);
        await reset(); await add();
        assert.equal((await job("2020-03-01T16:04:59Z").checkInExpired()).skipped, "not_due");
        assert.equal((await pool.query("SELECT * FROM appointment_auto_check_in_runs")).rowCount, 0);
        assert.equal((await job().checkInExpired()).checkedIn, 1);
      });

      await t.test("projects/history, original creation, unread version and existing read receipts are preserved", async () => {
        await reset();
        const a = await add("2020-02-29", "no_show", { therapist: therapistB });
        await pool.query("DELETE FROM appointment_service_items WHERE appointment_id=$1", [a.id]);
        for (const [position, project] of projects.slice(0, 2).entries()) {
          await pool.query(`INSERT INTO appointment_service_items(appointment_id,service_item_id,name_snapshot,position)
            VALUES($1,$2,$3,$4)`, [a.id, project.id, project.name, position]);
        }
        const current = await appointmentRepo.findById(a.id);
        await appointmentRepo.recordRevision(current, current, customer.id);
        await pool.query("INSERT INTO appointment_reads(user_id,appointment_id,version) SELECT $1,id,inbox_version FROM appointments WHERE id=$2", [admin.id, a.id]);
        const before = await row(a);
        const related = async () => ({
          history: (await pool.query("SELECT * FROM appointment_revisions WHERE appointment_id=$1", [a.id])).rows,
          projects: (await pool.query("SELECT * FROM appointment_service_items WHERE appointment_id=$1 ORDER BY position", [a.id])).rows,
          reads: (await pool.query("SELECT * FROM appointment_reads WHERE appointment_id=$1", [a.id])).rows
        });
        const associations = await related();
        await job().checkInExpired();
        const after = await row(a);
        for (const key of Object.keys(before)) {
          if (!["status", "checked_in_at", "no_show_at", "version", "updated_at"].includes(key)) assert.deepEqual(after[key], before[key], key);
        }
        assert.deepEqual(await related(), associations);
        const [entry] = await logs();
        assert.equal(entry.effective_role, "system"); assert.equal(entry.user_id, null);
        assert.equal(entry.metadata.checkedInAt, now);
        for (const [url, user] of [[`/api/appointments/${a.id}?includeHistory=1`, customer],
          [`/api/admin/appointments/${a.id}`, admin],
          [`/api/therapist/appointments/${a.id}?includeHistory=1`, staff]]) {
          const response = await api(url, user);
          assert.equal(response.status, 200);
          assert.equal(response.body.data.appointment.status, "checked_in");
          assert.equal(response.body.data.history.length, 1);
        }
        for (const [url, user] of [["/api/appointments/my", customer],
          ["/api/admin/appointments", admin], ["/api/therapist/appointments", staff]]) {
          const checked = await api(`${url}?status=checked_in`, user);
          assert.equal(checked.status, 200);
          assert.deepEqual(checked.body.data.appointments.map(item => item.id), [a.id]);
          const pending = await api(`${url}?status=pending`, user);
          assert.equal(pending.status, 200);
          assert.deepEqual(pending.body.data.appointments, []);
        }
      });

      await t.test("concurrent workers and same-day restarts commit one run and one log", async () => {
        await reset(); const a = await add();
        const results = await Promise.all([job().checkInExpired(), job().checkInExpired(), job().checkInExpired()]);
        assert.equal(results.filter(r => r.checkedIn === 1).length, 1);
        assert.equal(results.filter(r => r.skipped === "already_completed").length, 2);
        assert.equal((await logs()).length, 1);
        assert.equal((await row(a)).version, a.version + 1);
        assert.equal((await pool.query("SELECT * FROM appointment_auto_check_in_runs")).rowCount, 1);
      });

      await t.test("administrator uncheck is kept for this day and reprocessed on the next daily run", async () => {
        await reset(); const a = await add(); await job().checkInExpired();
        assert.equal((await patch(a, "uncheck-in")).status, 200);
        const unchecked = await row(a);
        assert.equal(unchecked.status, "no_show"); assert.equal(unchecked.checked_in_at, null);
        assert.equal((await job().checkInExpired()).skipped, "already_completed");
        assert.deepEqual(await row(a), unchecked);
        const next = "2020-03-02T16:05:00.000Z";
        assert.equal((await job(next).checkInExpired()).checkedIn, 1);
        assert.equal((await row(a)).checked_in_at.toISOString(), next);
      });

      await t.test("log failure rolls back appointment and daily marker; retry is safe", async () => {
        await reset(); const a = await add(), before = await row(a);
        await assert.rejects(job(now, { logService: { business: async () => { throw new Error("fixture write failure"); } } }).checkInExpired(), /fixture write failure/);
        assert.deepEqual(await row(a), before);
        assert.equal((await logs()).length, 0);
        assert.equal((await pool.query("SELECT * FROM appointment_auto_check_in_runs")).rowCount, 0);
        assert.equal((await job().checkInExpired()).checkedIn, 1);
      });

      await t.test("failure to commit run marker rolls back already written business logs too", async () => {
        await reset(); const a = await add(), before = await row(a);
        await assert.rejects(job(now, { repository: { ...repo, complete: async () => { throw new Error("fixture marker failure"); } } }).checkInExpired(), /fixture marker failure/);
        assert.deepEqual(await row(a), before); assert.equal((await logs()).length, 0);
        assert.equal((await pool.query("SELECT * FROM appointment_auto_check_in_runs")).rowCount, 0);
        assert.equal((await job().checkInExpired()).checkedIn, 1);
      });

      await t.test("historical overlaps are skipped without weakening constraints or blocking adjacent/other bookings", async () => {
        await reset();
        const active = await add("2020-02-29", "checked_in");
        const sameTherapist = await add("2020-02-29", "no_show", { user: other });
        const sameCustomer = await add("2020-02-29", "no_show", { therapist: therapistB });
        const adjacent = await add("2020-02-29", "no_show", { start: "10:30", end: "12:00" });
        const free = await add("2020-02-28");
        const activeBefore = await row(active);
        const result = await job().checkInExpired();
        assert.equal(result.checkedIn, 2); assert.equal(result.conflicts, 2);
        assert.deepEqual(await row(active), activeBefore);
        for (const a of [sameTherapist, sameCustomer]) assert.equal((await row(a)).status, "no_show");
        for (const a of [adjacent, free]) assert.equal((await row(a)).status, "checked_in");
        assert.equal((await logs()).filter(e => e.result === "skipped").length, 2);
        await assert.rejects(pool.query("UPDATE appointments SET status='checked_in' WHERE id=$1", [sameTherapist.id]), e => e.code === "23P01");
      });

      await t.test("two overlapping no-show records do not both become checked in", async () => {
        await reset(); const a = await add(), b = await add("2020-02-29", "no_show", { start: "10:00", end: "11:30" });
        const result = await job().checkInExpired();
        assert.equal(result.checkedIn, 1); assert.equal(result.conflicts, 1);
        assert.equal((await row(a)).status, "checked_in"); assert.equal((await row(b)).status, "no_show");
      });

      await t.test("cancellation and automatic check-in respect lock order in both directions", async () => {
        await reset(); let a = await add();
        let [cancelled, automatic] = await queued(pool, () => patch(a, "cancel"), () => job().checkInExpired());
        assert.equal(cancelled.status, 200); assert.equal(automatic.checkedIn, 0);
        assert.equal((await row(a)).status, "cancelled");
        await reset(); a = await add();
        [automatic, cancelled] = await queued(pool, () => job().checkInExpired(), () => patch(a, "cancel"));
        assert.equal(automatic.checkedIn, 1); assert.equal(cancelled.status, 409);
        assert.equal((await row(a)).status, "checked_in");
      });

      await t.test("manual check-in and automatic check-in do not overwrite each other's timestamps", async () => {
        await reset(); let a = await add();
        let [manual, automatic] = await queued(pool, () => patch(a, "check-in"), () => job().checkInExpired());
        assert.equal(manual.status, 200); assert.equal(automatic.checkedIn, 0);
        assert.notEqual((await row(a)).checked_in_at.toISOString(), now);
        await reset(); a = await add();
        [automatic, manual] = await queued(pool, () => job().checkInExpired(), () => patch(a, "check-in"));
        assert.equal(automatic.checkedIn, 1); assert.equal(manual.status, 409);
        assert.equal((await row(a)).checked_in_at.toISOString(), now);
      });

      await t.test("no-show marking and automatic check-in cannot revert checked-in records", async () => {
        for (const autoFirst of [false, true]) {
          await reset(); const a = await add("2020-02-29", "booked");
          const automatic = () => job().checkInExpired();
          const mark = () => require("../src/services/noShowService").markNoShows();
          await queued(pool, ...(autoFirst ? [automatic, mark] : [mark, automatic]));
          assert.equal((await row(a)).status, "checked_in");
          assert.equal((await logs()).length, 1);
        }
      });

      await t.test("clock is read after waiting for concurrent work, including crossing midnight", async () => {
        await reset(); const a = await add("2020-03-01");
        let time = now;
        const delayed = job(null, { now: () => time });
        const advance = () => h.db.transaction(async client => {
          await client.query("SELECT pg_advisory_xact_lock(582302)");
          time = "2020-03-02T16:05:00.000Z";
        });
        const [, result] = await queued(pool, advance, () => delayed.checkInExpired());
        assert.equal(result.runDate, "2020-03-03"); assert.equal(result.checkedIn, 1);
        assert.equal((await row(a)).checked_in_at.toISOString(), time);
      });
    });
  } finally { isolated.cleanup(); }
});
