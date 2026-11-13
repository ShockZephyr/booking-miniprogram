const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");

async function queued(pool, first, second) {
  const guard = await pool.connect(), pending = [];
  try {
    await guard.query("BEGIN"); await guard.query("SELECT pg_advisory_xact_lock(582302)");
    for (const action of [first, second]) {
      pending.push(action());
      let n = 0;
      for (let i = 0; i < 150 && n < pending.length; i++) {
        n = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name=current_setting('application_name') AND wait_event_type='Lock'
          AND query LIKE 'SELECT pg_advisory_xact_lock%'`)).rows[0].n;
        if (n < pending.length) await delay(10);
      }
      assert.ok(n >= pending.length, "both transactions must queue on the identity lock");
    }
    await guard.query("COMMIT");
    return await Promise.all(pending);
  } finally { await guard.query("ROLLBACK"); guard.release(); await Promise.allSettled(pending); }
}

test("staff batch check-in through isolated PostgreSQL and actual HTTP", { skip: process.env.RUN_DB_TESTS !== "1" }, async t => {
  const isolated = require("./audit-2026-10-20/isolated");
  try {
    await isolated.withDatabase(async h => {
      const { pool, api, customer, other, admin, staff, therapistA, therapistB, projects } = h;
      const { createBatchCheckInService } = require("../src/services/batchCheckInService");
      const { createAutoCheckInService } = require("../src/services/autoCheckInService");
      const reset = async () => {
        await pool.query("DELETE FROM appointment_revisions");
        await pool.query("DELETE FROM appointments");
        await pool.query("DELETE FROM audit_logs");
        await pool.query("DELETE FROM business_logs");
        await pool.query("DELETE FROM appointment_auto_check_in_runs");
        await pool.query("UPDATE service_items SET status='active'");
      };
      const add = (date = "2020-01-01", opts = {}) => h.addAppointment(h.bookingTime({ date,
        start: opts.start || "09:00", end: opts.end || "10:30", therapist: opts.therapist || therapistA }),
      { user: opts.user || customer, status: opts.status || "no_show" });
      const row = async a => (await pool.query("SELECT * FROM appointments WHERE id=$1", [a.id])).rows[0];
      const url = (isAdmin, suffix) => `/api/${isAdmin ? "admin" : "therapist"}/appointments/check-in-${suffix}`;
      const preview = (filters = {}, user = admin, isAdmin = true) => api(url(isAdmin, "preview"), user, "POST", { filters });
      const submit = (data, filters = {}, user = admin, isAdmin = true) => api(url(isAdmin, "batch"), user, "POST", { filters, confirmationVersion: data.confirmationVersion });
      const data = response => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data; };
      const system = at => createBatchCheckInService({ now: async () => new Date(at) });
      const context = { user: admin, requestId: "batch-fixture" };

      await t.test("admin including dual therapist signs all pages, excluding cancelled/checked-in/too-early", async () => {
        await reset(); const targets = [];
        for (let i = 1; i <= 25; i++) targets.push(await add(`2020-01-${String(i).padStart(2, "0")}`));
        targets.push(await add("2020-02-01", { therapist: therapistB, user: other }));
        const unchanged = [await add("2020-02-02", { status: "cancelled" }),
          await add("2020-02-03", { status: "checked_in" }), await add("2999-01-01", { status: "booked" })];
        const before = await Promise.all(unchanged.map(row));
        const targetBefore = await Promise.all(targets.map(row));
        const p = data(await preview({ page: 99, pageSize: 1, sort: "created_desc" }));
        assert.equal(p.count, 26); assert.match(p.confirmationVersion, /^[a-f0-9]{64}$/);
        assert.deepEqual(await Promise.all(targets.map(row)), targetBefore, "preview cannot sign or change unread/version");
        assert.equal(data(await submit(p)).checkedIn, 26);
        for (const a of targets) {
          const signed = await row(a);
          assert.equal(signed.status, "checked_in"); assert.ok(signed.checked_in_at);
          assert.equal(signed.version, a.version + 1); assert.equal(signed.inbox_version, a.inbox_version);
        }
        assert.deepEqual(await Promise.all(unchanged.map(row)), before);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='admin_check_in_user'")).rows[0].n, 26);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM business_logs WHERE metadata->>'batch'='true'")).rows[0].n, 26);
        const list = data(await api("/api/admin/appointments?status=checked_in&pageSize=20", admin));
        assert.equal(list.appointments.length, 20); assert.equal(list.pagination.total, 27);
        assert.equal((await submit(p)).body.code, "BATCH_CHECK_IN_CHANGED");
      });

      await t.test("therapist is restricted to assigned appointments and ordinary customers cannot call either endpoint", async () => {
        await reset(); const a = await add(), b = await add("2020-01-02", { therapist: therapistB });
        const filters = { therapistIds: [therapistA.id] };
        const p = data(await preview(filters, staff, false)); assert.equal(p.count, 1);
        assert.equal(data(await submit(p, filters, staff, false)).checkedIn, 1);
        assert.equal((await row(a)).status, "no_show"); assert.equal((await row(b)).status, "checked_in");
        assert.equal((await pool.query("SELECT * FROM audit_logs")).rowCount, 0);
        assert.equal((await pool.query("SELECT * FROM business_logs WHERE action='therapist_check_in_user'")).rowCount, 1);
        for (const mode of [true, false]) {
          assert.equal((await preview({}, customer, mode)).status, 403);
          assert.equal((await submit(p, {}, customer, mode)).status, 403);
        }
        assert.equal((await preview({}, staff, true)).status, 403);
      });

      await t.test("project union, inactive options, therapist and service date/time filters match list semantics", async () => {
        await reset();
        const a = await add(), b = await add("2020-01-02", { therapist: therapistB });
        const outsideTime = await add("2020-01-03", { end: "12:00" });
        const outsideDate = await add("2020-01-10");
        await pool.query("INSERT INTO appointment_service_items(appointment_id,service_item_id,name_snapshot,position) VALUES($1,$2,$3,1)", [a.id, projects[1].id, projects[1].name]);
        const filters = { serviceItemIds: [projects[1].id], therapistIds: [therapistA.id], fromDate: "2020-01-01", toDate: "2020-01-03", startTime: "09:00", endTime: "11:00" };
        const p = data(await preview(filters)); assert.equal(p.count, 1);
        const list = data(await api(`/api/admin/appointments?status=pending&serviceItemIds=${projects[1].id}&therapistIds=${therapistA.id}&fromDate=2020-01-01&toDate=2020-01-03&startTime=09:00&endTime=11:00`, admin));
        assert.deepEqual(list.appointments.map(a => a.id), [a.id]);
        assert.equal(data(await submit(p, filters)).checkedIn, 1);
        for (const untouched of [b, outsideTime, outsideDate]) assert.equal((await row(untouched)).status, "no_show");
        await pool.query("UPDATE service_items SET status='inactive' WHERE id=$1", [projects[0].id]);
        const inactive = { includeInactiveServiceItems: "1", fromDate: "2020-01-02", toDate: "2020-01-03" };
        assert.equal(data(await preview(inactive)).count, 2);
        assert.equal((await preview({ startTime: "12:00", endTime: "09:00" })).status, 400);
        assert.equal((await preview({ serviceItemIds: ["not-a-uuid"] })).status, 400);
      });

      await t.test("server clock enforces inclusive one-hour boundary and midnight, with no client time input", async () => {
        await reset(); await add("2020-01-02", { status: "booked" });
        let svc = system("2020-01-01T23:59:59Z"); // Shanghai Jan 2 07:59:59
        assert.equal((await svc.preview({}, context, { admin: true })).count, 0);
        svc = system("2020-01-02T00:00:00Z");
        const p = await svc.preview({}, context, { admin: true }); assert.equal(p.count, 1);
        assert.equal((await svc.submit(p, context, { admin: true })).checkedIn, 1);
        await reset(); await add("2020-01-02", { status: "booked", start: "00:30", end: "02:00" });
        assert.equal((await system("2020-01-01T15:29:59Z").preview({}, context, { admin: true })).count, 0);
        assert.equal((await system("2020-01-01T15:30:00Z").preview({}, context, { admin: true })).count, 1);
      });

      await t.test("changed targets, filters, modifications and newly eligible bookings invalidate old confirmation", async () => {
        for (const mutation of [async a => { data(await api(`/api/admin/appointments/${a.id}/cancel`, admin, "PATCH")); },
          async a => { data(await api(`/api/admin/appointments/${a.id}/check-in`, admin, "PATCH")); },
          async a => { await pool.query("UPDATE appointments SET version=version+1, note='fixture changed' WHERE id=$1", [a.id]); },
          async () => { await add("2020-01-02"); }]) {
          await reset(); const a = await add(), untouched = await add("2020-01-03"), p = data(await preview());
          await mutation(a);
          assert.equal((await submit(p)).body.code, "BATCH_CHECK_IN_CHANGED");
          assert.equal((await row(untouched)).status, "no_show");
        }
        await reset(); await add(); const p = data(await preview());
        assert.equal((await submit(p, { fromDate: "2020-01-01" })).body.code, "BATCH_CHECK_IN_CHANGED");
        assert.equal((await submit({ confirmationVersion: "invalid" })).status, 400);
        await reset(); await add("2020-01-02", { status: "booked" });
        const early = await system("2020-01-01T23:59:59Z").preview({}, context, { admin: true });
        await assert.rejects(system("2020-01-02T00:00:00Z").submit(early, context, { admin: true }), e => e.code === "BATCH_CHECK_IN_CHANGED");
      });

      await t.test("duplicate concurrent confirmations check in exactly once; later uncheck cannot reuse the old version", async () => {
        await reset(); const a = await add(), p = data(await preview());
        const results = await Promise.all([submit(p), submit(p)]);
        assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
        assert.equal((await row(a)).version, a.version + 1);
        data(await api(`/api/admin/appointments/${a.id}/uncheck-in`, admin, "PATCH"));
        assert.equal((await submit(p)).body.code, "BATCH_CHECK_IN_CHANGED");
        assert.equal((await row(a)).status, "no_show");
      });

      await t.test("any log failure or historical exclusion conflict rolls back the whole batch and audit", async () => {
        await reset(); const a = await add(), b = await add("2020-01-02"), p = data(await preview());
        let writes = 0;
        const logs = require("../src/services/logService");
        const failing = createBatchCheckInService({ logService: { business: async (...args) => {
          if (++writes === 2) throw new Error("fixture log failure"); return logs.business(...args);
        } } });
        await assert.rejects(failing.submit(p, context, { admin: true }), /fixture log failure/);
        for (const item of [a, b]) assert.equal((await row(item)).status, "no_show");
        assert.equal((await pool.query("SELECT * FROM audit_logs")).rowCount, 0);
        assert.equal((await pool.query("SELECT * FROM business_logs WHERE metadata->>'batch'='true'")).rowCount, 0);
        await add("2020-01-01", { status: "checked_in", user: other });
        const conflict = await submit(data(await preview()));
        assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "BATCH_CHECK_IN_CONFLICT");
        for (const item of [a, b]) assert.equal((await row(item)).status, "no_show");
        assert.equal((await pool.query("SELECT * FROM audit_logs")).rowCount, 0);
      });

      await t.test("queued permission revocation is rechecked before any bulk writes", async () => {
        await reset(); const a = await add(), p = data(await preview());
        const revoke = () => h.db.transaction(async client => {
          await client.query("SELECT pg_advisory_xact_lock(582302)");
          await client.query("UPDATE users SET role='user' WHERE id=$1", [admin.id]);
        });
        const [, response] = await queued(pool, revoke, () => submit(p));
        assert.equal(response.status, 403); assert.equal((await row(a)).status, "no_show");
        await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
      });

      await t.test("automatic nightly check-in and manual batch do not overwrite or double sign", async () => {
        for (const autoFirst of [false, true]) {
          await reset(); const a = await add(), p = data(await preview());
          const automatic = () => createAutoCheckInService({ now: () => new Date("2020-03-01T16:05:00Z") }).checkInExpired();
          const manual = () => submit(p);
          const result = await queued(pool, ...(autoFirst ? [automatic, manual] : [manual, automatic]));
          assert.equal(result[autoFirst ? 1 : 0].status, autoFirst ? 409 : 200);
          assert.equal(result[autoFirst ? 0 : 1].checkedIn, autoFirst ? 1 : 0);
          assert.equal((await row(a)).version, a.version + 1);
          assert.equal((await row(a)).status, "checked_in");
        }
      });
    });
  } finally { isolated.cleanup(); }
});
