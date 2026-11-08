const test = require("node:test");
const assert = require("node:assert/strict");

test("free-time booking and edits commit atomically on isolated PostgreSQL", { skip: process.env.RUN_DB_TESTS !== "1" }, async (t) => {
  // This helper only accepts an explicitly named local audit database and creates a fresh schema.
  const { withDatabase, cleanup } = require("./audit-2026-10-20/isolated");
  try {
    await withDatabase(async ({ pool, api, customer, other, admin, staff, therapistA, therapistB, projects, addAppointment, bookingTime }) => {
      const { rows: [{ date }] } = await pool.query("SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date + 1)::text AS date");
      const project = projects[0].id;
      const ranges = [{ startTime: "09:00", endTime: "12:00" }, { startTime: "13:00", endTime: "19:00" }];
      for (const therapist of [therapistA, therapistB]) {
        await pool.query(`INSERT INTO weekly_schedules(therapist_id,weekday,step,min_duration,ranges,service_item_ids)
          VALUES($1,extract(isodow from $2::date),30,90,$3::jsonb,$4)`,
        [therapist.id, date, JSON.stringify(ranges), projects.map(item => item.id)]);
      }
      await pool.query("INSERT INTO member_whitelist(phone,status) VALUES($1,'active')", [other.phone]);
      const reserve = (user, therapistId, startTime, endTime) => api("/api/appointments", user, "POST", {
        therapistId, date, startTime, endTime, serviceItemId: project
      });
      const edit = (id, user, patch) => api(`/api/appointments/${id}/modify`, user, "PATCH", patch);
      let booking, owner, spectator, independent;

      await t.test("two customers race for overlapping intervals; a different therapist and an adjacent start remain bookable", async () => {
        const attempts = await Promise.all([
          reserve(customer, therapistB.id, "09:00", "10:30"), reserve(other, therapistB.id, "09:00", "10:30")
        ]);
        assert.deepEqual(attempts.map(item => item.status).sort(), [200, 409]);
        assert.equal(attempts.find(item => item.status === 409).body.code, "APPOINTMENT_CONFLICT");
        booking = attempts.find(item => item.status === 200).body.data.appointment;
        owner = booking.userId === customer.id ? customer : other;
        spectator = owner === customer ? other : customer;
        const conflict = await reserve(owner, therapistA.id, "09:30", "11:00");
        assert.equal(conflict.body.code, "APPOINTMENT_CONFLICT");
        assert.equal((await pool.query("SELECT 1 FROM schedule_days WHERE therapist_id=$1", [therapistA.id])).rowCount, 0);
        const parallel = await reserve(spectator, therapistA.id, "09:00", "10:30");
        assert.equal(parallel.status, 200);
        independent = parallel.body.data.appointment;
        const adjacent = await reserve(spectator, therapistB.id, "10:30", "12:00");
        assert.equal(adjacent.status, 200);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM schedule_days")).rows[0].n, 2);
      });

      await t.test("PostgreSQL rejects both kinds of overlapping direct writes, even without application checks", async () => {
        const insert = (userId, therapistId, start, end) => pool.query(`INSERT INTO appointments
          (user_id,therapist_id,service_item_id,date,start_time,end_time)
          VALUES($1,$2,$3,$4,$5,$6)`, [userId, therapistId, project, date, start, end]);
        await assert.rejects(insert(admin.id, therapistB.id, "09:00", "10:00"), { code: "23P01", constraint: "no_overlapping_appointments_per_therapist" });
        // Keep the destination therapist free to isolate the same-customer exclusion.
        const { rows: [third] } = await pool.query("INSERT INTO therapists(name,phone) VALUES('合成人员','13900000009') RETURNING id");
        await assert.rejects(insert(owner.id, third.id, "09:00", "10:00"), { code: "23P01", constraint: "no_overlapping_appointments_per_user" });
      });

      await t.test("foreign customer and therapist requests do not read or wait for another person's locked booking", async () => {
        const conn = await pool.connect();
        const db = require("../src/config/db");
        try {
          await conn.query("BEGIN");
          await conn.query("SELECT 1 FROM appointments WHERE id=$1 FOR UPDATE", [booking.id]);
          const actions = require("../src/services/appointmentService").createAppointmentService({
            transaction: handler => db.transaction(async client => {
              await client.query("SET LOCAL lock_timeout='200ms'");
              return handler(client);
            })
          });
          await assert.rejects(actions.cancelAppointment(booking.id, { user: spectator }), { code: "APPOINTMENT_NOT_FOUND" });
          await assert.rejects(actions.therapistCheckInAppointment(booking.id, {
            user: { ...admin, therapistId: therapistA.id }
          }), { code: "APPOINTMENT_NOT_FOUND" });
        } finally { await conn.query("ROLLBACK"); conn.release(); }
      });

      await t.test("a binding transaction never cancels a customer appointment that started after its transaction began", async () => {
        const conn = await pool.connect();
        try {
          await conn.query("BEGIN");
          // Represent the boundary at SQL precision so the test need not wait for the next whole minute.
          const { rows: [instant] } = await pool.query(`SELECT
            (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date AS date,
            (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::time AS time`);
          await conn.query(`INSERT INTO appointments(user_id,therapist_id,service_item_id,date,start_time,end_time)
            VALUES($1,$2,$3,$4,$5::time,LEAST('23:59:59.999999'::time,$5::time + interval '1 second'))`,
          [owner.id,therapistA.id,project,instant.date,instant.time]);
          const rows = await require("../src/repositories/appointmentRepository").listFutureEffectiveByUser(owner.id, conn);
          assert.ok(rows.every(row => row.date !== instant.date));
        } finally { await conn.query("ROLLBACK"); conn.release(); }
      });

      await t.test("serialized same-version edits retain ID and checked-in timestamp and write exactly one revision", async () => {
        await pool.query("UPDATE appointments SET status='checked_in',checked_in_at=clock_timestamp() WHERE id=$1", [booking.id]);
        const own = await api(`/api/appointments/${booking.id}`, owner);
        const base = own.body.data.appointment;
        // The original date stays editable after it falls outside the new public visibility range.
        await pool.query("UPDATE schedule_settings SET days_visible=1");
        assert.equal((await reserve(owner, therapistB.id, "15:00", "16:30")).body.code, "DATE_OUT_OF_RANGE");
        const next = await Promise.all(["第一份修改", "另一份修改"].map(note => edit(booking.id, owner, {
          startTime: "13:30", endTime: "15:00", serviceItemId: projects[1].id, note, version: base.version
        })));
        assert.deepEqual(next.map(row => row.status).sort(), [200, 409]);
        assert.equal(next.find(row => row.status === 409).body.code, "APPOINTMENT_VERSION_CONFLICT");
        const updated = next.find(row => row.status === 200).body.data.appointment;
        assert.equal(updated.id, booking.id);
        assert.equal(updated.createdAt, base.createdAt);
        assert.equal(updated.checkedInAt, base.checkedInAt);
        assert.equal(updated.status, "checked_in");
        assert.equal(updated.serviceItemName, projects[1].name);
        assert.equal(updated.version, base.version + 1);
        const detail = await api(`/api/admin/appointments/${booking.id}`, admin);
        assert.deepEqual(detail.body.data.history.map(rev => [rev.before.startTime, rev.after.startTime]), [["09:00", "13:30"]]);
        assert.equal(detail.body.data.history[0].after.note, updated.note);
        assert.equal((await api(`/api/appointments/${booking.id}`, spectator)).status, 404);
        const staffView = await api(`/api/therapist/appointments/${booking.id}`, staff);
        assert.equal(staffView.body.data.appointment.userId, undefined);
        assert.match(staffView.body.data.appointment.userPhone, /\*{4}/);
        assert.equal(staffView.body.data.history, undefined, "quick check-in reads do not request history");
        const historyPath = id => `/api/therapist/appointments/${id}?includeHistory=1`;
        const staffHistory = (await api(historyPath(booking.id), staff)).body.data.history;
        const [revision] = detail.body.data.history;
        assert.deepEqual(staffHistory, [{ id: revision.id, createdAt: revision.createdAt, before: {
          date: base.date, startTime: base.startTime, endTime: base.endTime, note: base.note, serviceItemName: base.serviceItemName,
          serviceItems: base.serviceItems.map(({ id, name }) => ({ id, name }))
        } }]);
        const sameCustomer = await addAppointment(bookingTime({ therapist: therapistB }), { user: owner, status: "cancelled" });
        assert.deepEqual((await api(historyPath(sameCustomer.id), staff)).body.data.history, []);
        assert.equal((await api(historyPath(independent.id), staff)).status, 404);
        assert.equal((await api(historyPath(booking.id), owner)).status, 403);
        assert.equal((await api("/api/appointments/my", owner)).body.data.appointments.find(item => item.id === booking.id).startTime, "13:30");
        assert.equal((await api("/api/admin/appointments", admin)).body.data.appointments.find(item => item.id === booking.id).startTime, "13:30");
        assert.equal((await api("/api/therapist/appointments", staff)).body.data.appointments.find(item => item.id === booking.id).startTime, "13:30");
        booking = updated;
      });

      await t.test("failure after writing an edit and its revision rolls the row, revision and business log back together", async () => {
        await pool.query("ALTER TABLE business_logs ADD CONSTRAINT reject_next_edit CHECK (action <> 'modify_appointment') NOT VALID");
        const failed = await edit(booking.id, owner, { note: "必须回滚的修改", version: booking.version });
        assert.equal(failed.status, 500);
        const saved = await api(`/api/admin/appointments/${booking.id}`, admin);
        assert.equal(saved.body.data.appointment.note, booking.note);
        assert.equal(saved.body.data.appointment.version, booking.version);
        assert.equal(saved.body.data.history.length, 1);
        const logs = await pool.query("SELECT 1 FROM business_logs WHERE resource_id=$1 AND action='modify_appointment'", [booking.id]);
        assert.equal(logs.rowCount, 1);
      });

      await t.test("concurrent customer and administrator check-ins apply only once at the exact opening boundary", async () => {
        const actions = require("../src/services/appointmentService").createAppointmentService({
          transaction: require("../src/config/db").transaction,
          now: () => new Date(`${date}T08:00:00+08:00`)
        });
        const ownerContext = { user: spectator, requestId: "customer-check-in" };
        const adminContext = { user: admin, requestId: "admin-check-in" };
        const results = await Promise.allSettled([
          actions.checkInAppointment(independent.id, ownerContext),
          actions.checkInAppointment(independent.id, adminContext, { admin: true })
        ]);
        assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
        assert.equal(results.find(result => result.status === "rejected").reason.code, "APPOINTMENT_ALREADY_CHECKED_IN");
        const saved = (await pool.query("SELECT status,version,checked_in_at FROM appointments WHERE id=$1", [independent.id])).rows[0];
        assert.equal(saved.status, "checked_in");
        assert.equal(saved.version, independent.version + 1);
        assert.equal(saved.checked_in_at.toISOString(), new Date(`${date}T08:00:00+08:00`).toISOString());
      });

      await t.test("moving a booking races a new booking; a losing edit retains its old times and revision count", async () => {
        await pool.query("ALTER TABLE business_logs DROP CONSTRAINT reject_next_edit");
        await pool.query("UPDATE schedule_settings SET days_visible=7");
        const attempts = await Promise.all([
          edit(booking.id, owner, { startTime: "16:00", endTime: "17:30", version: booking.version }),
          reserve(spectator, therapistB.id, "16:30", "18:00")
        ]);
        assert.deepEqual(attempts.map(item => item.status).sort(), [200, 409]);
        assert.equal(attempts.find(item => item.status === 409).body.code, "APPOINTMENT_CONFLICT");
        const moved = attempts[0].status === 200;
        const detail = (await api(`/api/admin/appointments/${booking.id}`, admin)).body.data;
        assert.equal(detail.appointment.startTime, moved ? "16:00" : booking.startTime);
        assert.equal(detail.history.length, moved ? 2 : 1);
        const occupants = await pool.query(`SELECT 1 FROM appointments WHERE date=$1 AND therapist_id=$2
          AND status IN ('booked','checked_in') AND start_time < '17:30' AND end_time > '16:30'`, [date, therapistB.id]);
        assert.equal(occupants.rowCount, 1);
      });
    });
  } finally { cleanup(); }
});
