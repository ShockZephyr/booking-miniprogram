const test = require("node:test");
const assert = require("node:assert/strict");

const sorts = ["service_asc", "service_desc", "created_asc", "created_desc"];
function expectedOrder(rows, sort) {
  const service = sort.startsWith("service");
  const direction = sort.endsWith("asc") ? 1 : -1;
  return rows.slice().sort((a, b) => {
    for (const key of service ? ["date", "startTime", "createdKey", "id"] : ["createdKey", "id"]) {
      if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * direction;
    }
    return 0;
  }).map(row => row.id);
}

test("appointment sorting across pages, identities and filters uses isolated PostgreSQL and HTTP", { skip: process.env.RUN_DB_TESTS !== "1" }, async t => {
  const { withDatabase, cleanup } = require("./audit-2026-10-20/isolated");
  try {
    await withDatabase(async ({ pool, api, admin, customer, staff, other, therapistA, therapistB, projects, bookingTime, addAppointment }) => {
      const fixtures = [];
      // All data is fictional and confined to the helper's random temporary schema.
      // More than two pages, mixed dates, equal instants and sub-millisecond creation times.
      for (let index = 0; index < 51; index++) {
        const user = index === 49 ? other : customer;
        const therapist = index === 50 ? therapistA : therapistB;
        const date = `2020-01-${String(1 + (index * 7) % 9).padStart(2, "0")}`;
        const startTime = index % 3 ? "09:00" : "11:00";
        const projectId = projects[index % 2].id;
        const record = await addAppointment({ ...bookingTime({ date, therapist, start: startTime, end: "12:30" }), serviceItemId: projectId }, { user, status: "cancelled" });
        const createdKey = `2020-01-01T08:00:00.${String(Math.floor(index / 3)).padStart(6, "0")}Z`;
        await pool.query("UPDATE appointments SET created_at=$2::timestamptz WHERE id=$1", [record.id, createdKey]);
        fixtures.push({ id: record.id, userId: user.id, therapistId: therapist.id, date, startTime, projectId, createdKey });
      }
      const scopes = [
        { name: "customer", route: "/api/appointments/my", user: customer, rows: fixtures.filter(r => r.userId === customer.id) },
        { name: "therapist", route: "/api/therapist/appointments", user: staff, rows: fixtures.filter(r => r.therapistId === therapistB.id) },
        { name: "admin", route: "/api/admin/appointments", user: admin, rows: fixtures }
      ];
      async function allPages(scope, sort, filters = {}) {
        const seen = [];
        let cursor = "";
        for (let page = 1; page <= 10; page++) {
          const params = new URLSearchParams({ status: "cancelled", pageSize: "20", page: String(page), sort, ...filters });
          if (cursor) params.set("cursor", cursor);
          const response = await api(`${scope.route}?${params}`, scope.user);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const { appointments, pagination } = response.body.data;
          assert.ok(appointments.length <= 20);
          seen.push(...appointments.map(a => a.id));
          if (!pagination.hasMore) return seen;
          assert.ok(pagination.nextCursor);
          assert.notEqual(pagination.nextCursor, cursor);
          cursor = pagination.nextCursor;
        }
        assert.fail("pagination did not finish");
      }
      for (const scope of scopes) {
        await t.test(`${scope.name}: all four orders are global, stable and complete`, async () => {
          for (const sort of sorts) {
            const actual = await allPages(scope, sort);
            assert.deepEqual(actual, expectedOrder(scope.rows, sort), sort);
            assert.equal(new Set(actual).size, actual.length);
          }
          const asc = await allPages(scope, "service_asc");
          const desc = await allPages(scope, "service_desc");
          assert.equal(asc[0], desc.at(-1), "the former last-page item must become the first item");
        });
        await t.test(`${scope.name}: filters still run before sorting and pagination`, async () => {
          const filters = { serviceItemIds: projects[0].id, fromDate: "2020-01-03", toDate: "2020-01-08", startTime: "09:00", endTime: "13:00" };
          const rows = scope.rows.filter(r => r.projectId === projects[0].id && r.date >= filters.fromDate && r.date <= filters.toDate);
          for (const sort of sorts) assert.deepEqual(await allPages(scope, sort, filters), expectedOrder(rows, sort));
          const empty = await api(`${scope.route}?status=pending&sort=service_asc`, scope.user);
          assert.equal(empty.status, 200);
          assert.deepEqual(empty.body.data.appointments, []);
        });
        await t.test(`${scope.name}: another sort's cursor and unknown modes return explicit 400`, async () => {
          const response = await api(`${scope.route}?status=all&sort=service_asc`, scope.user);
          const cursor = response.body.data.pagination.nextCursor;
          for (const sort of ["service_desc", "created_asc", "created_desc"]) {
            const bad = await api(`${scope.route}?sort=${sort}&cursor=${cursor}`, scope.user);
            assert.equal(bad.status, 400); assert.equal(bad.body.code, "INVALID_CURSOR");
          }
          const bad = await api(`${scope.route}?sort=unknown`, scope.user);
          assert.equal(bad.status, 400); assert.equal(bad.body.code, "INVALID_SORT");
          const defaultList = await api(`${scope.route}?status=all`, scope.user);
          assert.deepEqual(defaultList.body.data.appointments.map(a => a.id), expectedOrder(scope.rows, "service_desc").slice(0, 20));
        });
      }
      await t.test("therapist sort never bypasses ownership even with another therapist filter", async () => {
        const scope = scopes[1];
        const result = await allPages(scope, "created_asc", { therapistIds: therapistA.id });
        assert.deepEqual(result, expectedOrder(scope.rows, "created_asc"));
        const forbidden = await api("/api/admin/appointments?sort=created_asc", customer);
        assert.equal(forbidden.status, 403);
      });
      await t.test("exactly full pages and empty results end correctly in all four orders", async () => {
        const scope = scopes[2];
        const boundaryId = "22222222-2222-4222-8222-222222222222";
        await pool.query("INSERT INTO service_items(id,name,duration_minutes) VALUES($1,'排序边界测试项目',90)", [boundaryId]);
        const chosen = fixtures.slice(0, 40);
        for (const row of chosen) {
          await pool.query("INSERT INTO appointment_service_items(appointment_id,service_item_id,name_snapshot,position) VALUES($1,$2,'排序边界测试项目',1)", [row.id, boundaryId]);
        }
        for (const size of [40, 20, 0]) {
          if (size < 40) {
            await pool.query("DELETE FROM appointment_service_items WHERE service_item_id=$1 AND appointment_id=ANY($2::uuid[])",
              [boundaryId, chosen.slice(size, size + 20).map(row => row.id)]);
          }
          for (const sort of sorts) {
            const first = await api(`${scope.route}?sort=${sort}&serviceItemIds=${boundaryId}`, admin);
            assert.equal(first.status, 200);
            assert.equal(first.body.data.pagination.total, size);
            assert.equal(first.body.data.appointments.length, Math.min(20, size));
            assert.equal(first.body.data.pagination.hasMore, size > 20);
            if (size <= 20) assert.equal(first.body.data.pagination.nextCursor, "");
            assert.deepEqual(await allPages(scope, sort, { serviceItemIds: boundaryId }), expectedOrder(chosen.slice(0, size), sort));
          }
        }
      });
      await t.test("legacy page-number pagination applies the same global sorting", async () => {
        for (const scope of scopes) {
          for (const sort of sorts) {
            const response = await api(`${scope.route}?sort=${sort}&page=2&pageSize=20`, scope.user);
            assert.equal(response.status, 200);
            assert.deepEqual(response.body.data.appointments.map(a => a.id), expectedOrder(scope.rows, sort).slice(20, 40));
          }
        }
      });
      await t.test("a newly inserted earlier row does not shift a cursor continuation", async () => {
        const scope = scopes[0];
        const first = await api(`${scope.route}?sort=created_asc`, customer);
        const cursor = first.body.data.pagination.nextCursor;
        const added = await addAppointment(bookingTime({ therapist: therapistB }), { status: "cancelled" });
        await pool.query("UPDATE appointments SET created_at='2019-01-01T00:00:00Z' WHERE id=$1", [added.id]);
        const second = await api(`${scope.route}?sort=created_asc&cursor=${cursor}&page=2`, customer);
        assert.equal(second.status, 200);
        assert.deepEqual(second.body.data.appointments.map(a => a.id), expectedOrder(scope.rows, "created_asc").slice(20, 40));
      });
    });
  } finally { cleanup(); }
});
