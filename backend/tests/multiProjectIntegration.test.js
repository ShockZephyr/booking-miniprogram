const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("multi-project HTTP lifecycle, history, filters and protections use isolated PostgreSQL", { skip: process.env.RUN_DB_TESTS !== "1" }, async t => {
  const { withDatabase, cleanup } = require("./audit-2026-10-20/isolated");
  try { await withDatabase(async ({ pool, api, admin, customer, staff, other, therapistB, projects, tomorrow, configureWeek, addAppointment, bookingTime }) => {
    await configureWeek(tomorrow, therapistB);
    const ids = projects.slice(0, 2).map(p => p.id);
    let booking;
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*) FROM appointments) AS bookings,
      (SELECT count(*) FROM appointment_revisions) AS revisions,
      (SELECT count(*) FROM appointment_service_items) AS projects`)).rows[0];
    await t.test("migration backfills legacy records without changing IDs or historical names", async () => {
      await pool.query("DROP TRIGGER appointment_project_initial ON appointments; DROP FUNCTION initialize_appointment_project(); DROP TABLE appointment_service_items");
      const legacy = await addAppointment(bookingTime({ therapist: therapistB }), { status: "cancelled" });
      await pool.query(fs.readFileSync(path.join(__dirname, "../migrations/022_appointment_projects.sql"), "utf8"));
      const result = await api(`/api/appointments/${legacy.id}?includeHistory=1`, customer);
      assert.equal(result.status, 200);
      assert.equal(result.body.data.appointment.serviceItems[0].id, legacy.service_item_id);
      assert.equal(result.body.data.appointment.serviceItems[0].name, legacy.service_item_name);
      assert.deepEqual(result.body.data.history, []);
    });
    await t.test("one invalid project rolls back booking, associations and date freeze", async () => {
      const before = await counts();
      const bad = await api("/api/appointments", customer, "POST", { therapistId: therapistB.id, date: tomorrow,
        startTime: "09:00", endTime: "10:30", serviceItemIds: [ids[0], "00000000-0000-4000-8000-000000000009"] });
      assert.equal(bad.status, 404); assert.deepEqual(await counts(), before);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM schedule_days")).rows[0].n, 0);
    });
    await t.test("one interval contains two projects; second-project filters never duplicate rows", async () => {
      const result = await api("/api/appointments", customer, "POST", { therapistId: therapistB.id, date: tomorrow,
        startTime: "09:00", endTime: "10:30", serviceItemIds: ids, note: "原备注" });
      assert.equal(result.status, 200, JSON.stringify(result.body)); booking = result.body.data.appointment;
      assert.deepEqual([...booking.serviceItemIds].sort(), [...ids].sort());
      for (const [route, user] of [["/api/appointments/my", customer], ["/api/admin/appointments", admin], ["/api/therapist/appointments", staff]]) {
        const list = await api(`${route}?serviceItemIds=${ids.join(",")}&fromDate=${tomorrow}&toDate=${tomorrow}`, user);
        assert.equal(list.status, 200); assert.equal(list.body.data.pagination.total, 1);
        assert.equal(list.body.data.appointments.length, 1);
        const secondary = await api(`${route}?serviceItemIds=${booking.serviceItemIds[1]}&fromDate=${tomorrow}&toDate=${tomorrow}`, user);
        assert.equal(secondary.body.data.appointments[0].id, booking.id);
      }
      const day = await api(`/api/schedules/${therapistB.id}?date=${tomorrow}`, admin);
      assert.equal(day.body.data.appointments[0].serviceItemName, booking.serviceItemName);
      assert.equal((await api(`/api/appointments/${booking.id}?includeHistory=1`, other)).status, 404);
    });
    await t.test("secondary projects are protected from removal and legacy edits cannot erase the selection", async () => {
      const before = await counts();
      const remove = await api(`/api/admin/projects/${booking.serviceItemIds[1]}`, admin, "DELETE");
      assert.equal(remove.body.code, "PROJECT_HAS_APPOINTMENTS");
      const day = await api(`/api/admin/schedules/day/${therapistB.id}`, admin, "PATCH", { date: tomorrow, serviceItemIds: [booking.serviceItemIds[0]] });
      assert.equal(day.body.code, "SCHEDULE_PROJECT_IN_USE");
      const legacy = await api(`/api/appointments/${booking.id}/modify`, customer, "PATCH", { serviceItemId: ids[0], version: booking.version });
      assert.equal(legacy.body.code, "CLIENT_UPDATE_REQUIRED");
      const orderOnly = await api(`/api/appointments/${booking.id}/modify`, customer, "PATCH", { serviceItemIds: [...ids].reverse(), version: booking.version });
      assert.equal(orderOnly.status, 200); assert.equal(orderOnly.body.data.appointment.version, booking.version);
      assert.deepEqual(await counts(), before);
    });
    await t.test("revision failure rolls back all projects, then successful edits expose safe history to each owner", async () => {
      const before = await counts();
      await pool.query("ALTER TABLE business_logs ADD CONSTRAINT reject_multi_edit CHECK(action<>'modify_appointment') NOT VALID");
      const patch = { serviceItemIds: [ids[1]], note: "新备注", version: booking.version };
      const failed = await api(`/api/appointments/${booking.id}/modify`, customer, "PATCH", patch);
      assert.equal(failed.status, 500); assert.deepEqual(await counts(), before);
      assert.deepEqual((await api(`/api/appointments/${booking.id}`, customer)).body.data.appointment.serviceItems, booking.serviceItems);
      await pool.query("ALTER TABLE business_logs DROP CONSTRAINT reject_multi_edit");
      const changed = await api(`/api/appointments/${booking.id}/modify`, customer, "PATCH", patch);
      assert.equal(changed.status, 200); assert.equal(changed.body.data.appointment.createdAt, booking.createdAt);
      for (const [route, user] of [["/api/appointments", customer], ["/api/therapist/appointments", staff], ["/api/admin/appointments", admin]]) {
        const result = await api(`${route}/${booking.id}?includeHistory=1`, user);
        assert.equal(result.status, 200);
        assert.equal(result.body.data.history[0].before.serviceItemName, booking.serviceItemName);
        assert.equal(result.body.data.history[0].before.serviceItems.length, 2);
        if (user !== admin) assert.equal(result.body.data.history[0].before.userId, undefined);
      }
      booking = changed.body.data.appointment;
    });
    await t.test("cancellation keeps project snapshots and frees the entire interval", async () => {
      const cancelled = await api(`/api/appointments/${booking.id}/cancel`, customer, "PATCH");
      assert.equal(cancelled.status, 200); assert.deepEqual(cancelled.body.data.appointment.serviceItems, booking.serviceItems);
      const next = await api("/api/appointments", customer, "POST", { therapistId: therapistB.id, date: tomorrow,
        startTime: "09:00", endTime: "10:30", serviceItemIds: ids });
      assert.equal(next.status, 200);
      await api(`/api/appointments/${next.body.data.appointment.id}/cancel`, customer, "PATCH");
    });
    await t.test("renaming and purging a secondary historical project keeps snapshots and inactive filters readable", async () => {
      const secondary = ids[1];
      await pool.query("UPDATE service_items SET name='已改名的合成项目' WHERE id=$1", [secondary]);
      const stored = (await api(`/api/appointments/${booking.id}?includeHistory=1`, customer)).body.data;
      assert.equal(stored.appointment.serviceItemName, booking.serviceItemName);
      assert.equal(stored.history[0].before.serviceItems.find(item => item.id === secondary).name, projects[1].name);
      assert.equal((await api(`/api/admin/projects/${secondary}`, admin, "DELETE")).status, 200);
      const inactive = await api(`/api/appointments/my?includeInactiveServiceItems=true&fromDate=${tomorrow}&toDate=${tomorrow}`, customer);
      assert.equal(inactive.status, 200);
      assert.equal(inactive.body.data.pagination.total, 2);
      assert.equal(new Set(inactive.body.data.appointments.map(item => item.id)).size, 2);
      assert.equal((await api("/api/admin/projects/purge", admin, "POST", { ids: [secondary] })).status, 200);
      const purged = (await api(`/api/appointments/${booking.id}?includeHistory=1`, customer)).body.data;
      assert.equal(purged.appointment.serviceItemName, booking.serviceItemName);
      assert.equal(purged.appointment.serviceItems[0].imageUrl, "");
      assert.equal(purged.history[0].before.serviceItems.length, 2);
    });
  }); } finally { cleanup(); }
});
