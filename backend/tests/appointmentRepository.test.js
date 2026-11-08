process.env.NODE_TEST_CONTEXT = "1";
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/config/db");
const appointmentRepository = require("../src/repositories/appointmentRepository");
const { parseAppointmentFilters } = require("../src/utils/appointmentFilters");

async function withQueryStub(stub, fn) {
  const original = db.query;
  db.query = stub;
  try {
    return await fn();
  } finally {
    db.query = original;
  }
}

test("status update clears stale lifecycle timestamps", async () => {
  let sql = "";
  await withQueryStub(
    async (text) => {
      if (/UPDATE appointments/.test(text)) sql = text;
      return {
        rows: [{
          id: "appointment_1",
          user_id: "user_1",
          service_item_id: "service_1",
          service_item_name: "服务",
          date: "2999-01-01",
          start_time: "09:00",
          end_time: "10:00",
          status: "checked_in"
        }]
      };
    },
    async () => {
      await appointmentRepository.updateStatus(
        "appointment_1",
        "checked_in",
        { checkedInAt: new Date("2999-01-01T01:00:00Z") }
      );
    }
  );
  assert.match(sql, /cancelled_at = CASE[\s\S]*ELSE NULL[\s\S]*checked_in_at = CASE/);
  assert.match(sql, /no_show_at = CASE[\s\S]*ELSE NULL/);
});

test("admin appointment list is paginated and maps whitelist remark", async () => {
  const calls = [];
  await withQueryStub(
    async (text, params) => {
      calls.push({ text, params });
      if (/COUNT/.test(text)) return { rows: [{ count: 21 }] };
      return {
        rows: [{
          id: "appointment_1",
          user_id: "user_1",
          service_item_id: "service_1",
          service_item_name: "深度放松课程",
          date: "2999-01-01",
          start_time: "09:00",
          end_time: "10:00",
          status: "booked",
          user_phone: "13900000000",
          whitelist_remark_name: "小王"
        }]
      };
    },
    async () => {
      const result = await appointmentRepository.listForAdmin({ status: "pending", page: 2, pageSize: 50 });
      assert.equal(result.appointments[0].whitelistRemarkName, "小王");
      assert.equal(result.pagination.pageSize, 20);
      assert.equal(result.pagination.hasMore, false);
    }
  );
  assert.deepEqual(calls[0].params[0], ["booked", "no_show"]);
  assert.equal(calls[1].params[1], 20);
  assert.equal(calls[1].params[2], 20);
});

test("staff appointment filters are applied in SQL before pagination", async () => {
  const calls = [];
  const serviceItemId = "22222222-2222-4222-8222-222222222222";
  const therapistId = "33333333-3333-4333-8333-333333333333";
  await withQueryStub(async (text, params) => {
    calls.push({ text, params });
    return /COUNT/.test(text) ? { rows: [{ count: 0 }] } : { rows: [] };
  }, async () => appointmentRepository.listForAdmin({
    status: "all", page: 1, pageSize: 20,
    serviceItemIds: [serviceItemId], therapistIds: [therapistId],
    fromDate: "2026-10-04", toDate: "2026-10-24", startTime: "09:00", endTime: "18:00"
  }));
  assert.match(calls[0].text, /ap\.service_item_id = ANY\(\$2::uuid\[\]\)/);
  assert.match(calls[0].text, /a\.therapist_id = ANY\(\$3::uuid\[\]\)/);
  assert.match(calls[0].text, /a\.date >= \$4/);
  assert.match(calls[0].text, /a\.date <= \$5/);
  assert.match(calls[0].text, /a\.start_time >= \$6/);
  assert.match(calls[0].text, /a\.end_time <= \$7/);
  assert.deepEqual(calls[0].params.slice(1), [[serviceItemId], [therapistId], "2026-10-04", "2026-10-24", "09:00", "18:00"]);
  assert.equal(calls[1].params.at(-2), 20);
  assert.equal(calls[1].params.at(-1), 0);
});

test("future customer appointments are locked and include booked and checked-in states", async () => {
  let sql = "";
  await withQueryStub(async (text) => { sql = text; return { rows: [] }; },
    async () => appointmentRepository.listFutureEffectiveByUser("user_1"));
  assert.match(sql, /status IN \('booked', 'checked_in'\)/);
  assert.match(sql, /AT TIME ZONE 'Asia\/Shanghai' > clock_timestamp\(\)/);
  assert.match(sql, /FOR UPDATE OF a/);
});

test("user appointment list paginates and excludes replaced from all", async () => {
  const calls = [];
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: `appointment_${index}`,
    user_id: "user_1",
    slot_id: `slot_${index}`,
    service_item_id: "service_1",
    service_item_name: "深度放松课程",
    date: "2999-01-01",
    start_time: "09:00",
    end_time: "10:00",
    status: "booked",
    user_phone: "13900000000"
  }));
  await withQueryStub(
    async (text, params) => {
      calls.push({ text, params });
      if (/COUNT/.test(text)) return { rows: [{ count: 42 }] };
      return { rows };
    },
    async () => {
      const result = await appointmentRepository.listByUser(
        "user_1",
        { status: "all", page: 2, pageSize: 50 }
      );
      assert.equal(result.appointments.length, 20);
      assert.equal(result.pagination.page, 2);
      assert.equal(result.pagination.pageSize, 20);
      assert.equal(result.pagination.total, 42);
      assert.equal(result.pagination.hasMore, true);
    }
  );
  assert.deepEqual(calls[0].params[1], ["booked", "no_show", "checked_in", "cancelled"]);
  assert.deepEqual(calls[1].params[1], ["booked", "no_show", "checked_in", "cancelled"]);
  assert.equal(calls[1].params[2], 20);
  assert.equal(calls[1].params[3], 20);
});

test("user appointment filters are applied before pagination", async () => {
  const calls = [];
  const serviceItemId = "11111111-1111-4111-8111-111111111111";
  const therapistId = "22222222-2222-4222-8222-222222222222";
  await withQueryStub(
    async (text, params) => {
      calls.push({ text, params });
      return /COUNT/.test(text) ? { rows: [{ count: 0 }] } : { rows: [] };
    },
    async () => appointmentRepository.listByUser("user_1", {
      status: "all", page: 1, pageSize: 20,
      serviceItemIds: [serviceItemId], therapistIds: [therapistId],
      includeInactiveServiceItems: true, includeInactiveTherapists: true,
      fromDate: "2026-10-04", toDate: "2026-10-24",
      startTime: "09:00", endTime: "18:00"
    })
  );
  assert.match(calls[0].text, /ap\.service_item_id = ANY\(\$3::uuid\[\]\)/);
  assert.match(calls[0].text, /a\.therapist_id = ANY\(\$4::uuid\[\]\)/);
  assert.match(calls[0].text, /NOT EXISTS \([\s\S]*FROM service_items p[\s\S]*p\.status='active'/);
  assert.match(calls[0].text, /NOT EXISTS \([\s\S]*FROM therapists filter_t[\s\S]*filter_t\.status = 'active'/);
  assert.match(calls[0].text, /a\.date >= \$5/);
  assert.match(calls[0].text, /a\.date <= \$6/);
  assert.match(calls[0].text, /a\.start_time >= \$7/);
  assert.match(calls[0].text, /a\.end_time <= \$8/);
  assert.deepEqual(calls[0].params.slice(2), [
    [serviceItemId], [therapistId], "2026-10-04", "2026-10-24", "09:00", "18:00"
  ]);
  assert.equal(calls[1].params.at(-2), 20);
  assert.equal(calls[1].params.at(-1), 0);
});

test("appointment filter options include scoped inactive historical records", async () => {
  const calls = [];
  await withQueryStub(async (text, params) => {
    calls.push({ text, params });
    if (/FROM service_items si/.test(text)) {
      return { rows: [
        { id: "p-active", name: "在用项目", inactive: false },
        { id: "p-old", name: "历史项目", inactive: true }
      ] };
    }
    return { rows: [
      { id: "t-active", name: "在用芳疗师", inactive: false },
      { id: "t-old", name: "历史芳疗师", inactive: true }
    ] };
  }, async () => {
    const result = await appointmentRepository.listFilterOptions({ id: "user-1", role: "user" });
    assert.equal(result.supportsInactiveFilters, true);
    assert.equal(result.serviceItems[1].inactive, true);
    assert.equal(result.therapists[1].inactive, true);
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /a\.user_id = \$1/);
  assert.match(calls[1].text, /a\.user_id = \$1/);
  assert.deepEqual(calls[0].params, ["user-1"]);
  assert.match(calls[0].text, /ap\.name_snapshot AS snapshot_name/);
  assert.match(calls[1].text, /a\.therapist_name AS snapshot_name/);
});

test("therapist filter options are scoped to the therapist and omit the therapist selector", async () => {
  const calls = [];
  await withQueryStub(async (text, params) => {
    calls.push({ text, params });
    return { rows: [] };
  }, async () => {
    const result = await appointmentRepository.listFilterOptions({ id: "user-1", role: "user", therapistId: "therapist-1" });
    assert.deepEqual(result.therapists, []);
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /a\.therapist_id = \$1/);
  assert.deepEqual(calls[0].params, ["therapist-1"]);
});

test("appointment filters reject oversized id lists before querying", () => {
  const ids = Array.from({ length: 51 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
  );
  assert.throws(
    () => parseAppointmentFilters({ serviceItemIds: ids }),
    { code: "INVALID_FILTER", status: 400 }
  );
});

test("appointment filters accept explicit inactive catalog flags and reject ambiguous values", () => {
  const filters = parseAppointmentFilters({
    includeInactiveServiceItems: "1",
    includeInactiveTherapists: "true"
  });
  assert.equal(filters.includeInactiveServiceItems, true);
  assert.equal(filters.includeInactiveTherapists, true);
  assert.throws(
    () => parseAppointmentFilters({ includeInactiveServiceItems: "yes" }),
    { code: "INVALID_FILTER", status: 400 }
  );
  assert.equal(parseAppointmentFilters({ includeInactiveTherapists: "1" }, { therapists: false }).includeInactiveTherapists, false);
});

test("appointment filters reject unknown status values", () => {
  assert.throws(
    () => parseAppointmentFilters({ status: "unknown" }),
    { code: "INVALID_FILTER", status: 400 }
  );
  assert.equal(parseAppointmentFilters({}).status, "all");
});

test("calendar status excludes replaced appointments", async () => {
  let sql = "";
  await withQueryStub(
    async (text) => {
      sql = text;
      return { rows: [] };
    },
    async () => {
      await appointmentRepository.calendarStatusByUser("user_1", "2999-01-01", "2999-01-31");
    }
  );
  assert.match(sql, /status IN \('booked', 'no_show', 'checked_in', 'cancelled'\)/);
  assert.doesNotMatch(sql, /replaced/);
});

test("appointment timestamps are formatted in Shanghai timezone", () => {
  const appointment = appointmentRepository.mapAppointment({
    id: "appointment_1",
    user_id: "user_1",
    slot_id: "slot_1",
    service_item_id: "service_1",
    service_item_name: "深度放松课程",
    date: "2026-08-18",
    start_time: "09:00",
    end_time: "10:00",
    status: "cancelled",
    created_at: new Date("2026-08-17T16:42:00.000Z"),
    updated_at: new Date("2026-08-17T16:42:00.000Z"),
    cancelled_at: new Date("2026-08-17T16:42:00.000Z")
  });
  assert.equal(appointment.createdAt, "2026-08-18 00:42:00");
  assert.equal(appointment.updatedAt, "2026-08-18 00:42:00");
  assert.equal(appointment.cancelledAt, "2026-08-18 00:42:00");
});
