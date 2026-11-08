process.env.NODE_TEST_CONTEXT = "1";
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAppointmentService } = require("../src/services/appointmentService");

const projectId = "22222222-2222-4222-8222-222222222222";
const therapistId = "33333333-3333-4333-8333-333333333333";
const booking = { therapistId, date: "2999-01-01", startTime: "09:00", endTime: "10:30", serviceItemId: projectId };
const memberUser = { id: "user_1", phone: "13800000000", role: "user", effectiveRole: "member" };

function createHarness(overrides = {}) {
  const calls = { createdPayloads: [], statusUpdates: [], revisions: [], freezes: 0, dayReads: [] };
  const original = overrides.original || {
    ...booking, id: "appointment_1", userId: memberUser.id, status: "booked", version: 1,
    serviceItemName: "舒缓芳香护理", createdAt: "2998-12-10 09:00:00"
  };
  const appointmentRepository = {
    create: async (payload) => {
      calls.createdPayloads.push(payload);
      return { id: "appointment_new", status: "booked", version: 1, ...payload };
    },
    findById: async () => original,
    findByIdForUpdate: async () => original,
    edit: async (id, patch) => ({ ...original, ...patch, id, version: original.version + 1 }),
    recordRevision: async (before, after) => { calls.revisions.push({ before, after }); },
    updateStatus: async (id, status, fields) => {
      calls.statusUpdates.push({ id, status, fields });
      return { id, status, ...fields };
    },
    uncheckIn: async (id, status, fields) => {
      calls.statusUpdates.push({ id, status, fields, uncheckIn: true });
      return { id, status, ...fields };
    }
  };
  const scheduleService = {
    bookableDay: async (input) => {
      calls.dayReads.push(input);
      return { date: input.date, therapistId, therapistName: "测试芳疗师",
        step: 30, minDuration: 90, serviceItemIds: [projectId], closed: [], busy: [],
        ranges: [{ startTime: "09:00", endTime: "12:00" }, { startTime: "13:00", endTime: "19:00" }],
        ...overrides.day };
    },
    freezeDay: async () => { calls.freezes++; }
  };
  const service = createAppointmentService({
    appointmentRepository, scheduleService,
    serviceItemRepository: { findById: async (id) => ({ id, status: "active", name: "当前项目名称" }) },
    userRepository: { findById: async () => overrides.currentUser || memberUser },
    accessService: { enrichUser: async (user) => user },
    acquireIdentityLock: async () => {},
    now: () => overrides.now || new Date("2999-01-01T00:00:00Z"),
    memberService: { isActiveMember: async () => overrides.isMember !== false },
    transaction: async (handler) => handler({}),
    logService: { business: async () => ({}) },
    auditService: { record: async () => ({}) },
    metrics: { incrementAppointment: () => {} }
  });
  return { service, calls };
}

test("check-in verification reads only the current customer's original appointment without requiring membership", async () => {
  const own = createHarness({ isMember: false });
  const appointment = await own.service.getOwnAppointment("appointment_1", { user: memberUser });
  assert.equal(appointment.id, "appointment_1");
  assert.deepEqual(own.calls.statusUpdates, []);
  const other = createHarness({ original: { id: "other", userId: "someone-else" } });
  await assert.rejects(() => other.service.getOwnAppointment("other", { user: memberUser }), { code: "APPOINTMENT_NOT_FOUND" });
  for (const currentUser of [{ ...memberUser, role: "admin" }, { ...memberUser, therapistId: "staff" }]) {
    const h = createHarness({ currentUser });
    await assert.rejects(() => h.service.getOwnAppointment("appointment_1", { user: memberUser }), { code: "BOOKING_NOT_ALLOWED" });
  }
  const stale = createHarness({ currentUser: { ...memberUser, sessionVersion: 2 } });
  await assert.rejects(() => stale.service.getOwnAppointment("appointment_1", { user: { ...memberUser, sessionVersion: 1 } }), { code: "INVALID_SESSION" });
});

test("unselected projects cannot be booked or used when modifying", async () => {
  for (const serviceItemIds of [[], ["service_other"]]) {
    const { service, calls } = createHarness({ day: { serviceItemIds } });
    const input = booking;
    await assert.rejects(() => service.createAppointment(input, { user: memberUser }), { code: "SERVICE_ITEM_NOT_ALLOWED" });
    await assert.rejects(() => service.modifyAppointment("appointment_1", { serviceItemId: input.serviceItemId }, { user: memberUser }), { code: "SERVICE_ITEM_NOT_ALLOWED" });
    assert.equal(calls.createdPayloads.length, 0);
    assert.equal(calls.statusUpdates.length, 0);
  }
});

test("non-whitelist user cannot create appointment", async () => {
  const { service, calls } = createHarness({ isMember: false });
  await assert.rejects(
    () => service.createAppointment(booking, { user: memberUser }),
    { code: "NOT_MEMBER" }
  );
  assert.equal(calls.createdPayloads.length, 0);
});

test("active whitelist member can create an appointment", async () => {
  const { service, calls } = createHarness();
  const appointment = await service.createAppointment(
    { ...booking, note: "安静一点" },
    { user: memberUser, requestId: "req_test" }
  );
  assert.equal(appointment.status, "booked");
  assert.equal(calls.createdPayloads[0].endTime, "10:30");
  assert.equal(calls.freezes, 1);
  assert.equal(calls.createdPayloads[0].date, "2999-01-01");
});

test("administrator and therapist accounts cannot create or modify customer appointments", async () => {
  for (const user of [
    { ...memberUser, role: "admin" },
    { ...memberUser, therapistId: "33333333-3333-4333-8333-333333333333" },
    { ...memberUser, role: "admin", therapistId: "33333333-3333-4333-8333-333333333333" }
  ]) {
    const { service, calls } = createHarness({ currentUser: user });
    await assert.rejects(
      () => service.createAppointment(booking, { user }),
      { code: "BOOKING_NOT_ALLOWED" }
    );
    await assert.rejects(
      () => service.modifyAppointment("appointment_1", { serviceItemId: projectId }, { user }),
      { code: "BOOKING_NOT_ALLOWED" }
    );
    assert.equal(calls.createdPayloads.length, 0);
    assert.equal(calls.statusUpdates.length, 0);
  }
});

test("a stale customer request is rejected after the database account becomes staff", async () => {
  for (const currentUser of [
    { ...memberUser, role: "admin" },
    { ...memberUser, therapistId: "33333333-3333-4333-8333-333333333333" }
  ]) {
    const { service, calls } = createHarness({ currentUser });
    const staleContext = { user: memberUser, requestId: "req_stale" };
    await assert.rejects(
      () => service.createAppointment(booking, staleContext),
      { code: "BOOKING_NOT_ALLOWED" }
    );
    await assert.rejects(
      () => service.modifyAppointment("appointment_1", { serviceItemId: projectId }, staleContext),
      { code: "BOOKING_NOT_ALLOWED" }
    );
    assert.equal(calls.createdPayloads.length, 0);
  }
});

test("staff cannot use generic customer cancellation or check-in operations", async () => {
  for (const currentUser of [
    { ...memberUser, role: "admin" },
    { ...memberUser, therapistId: "33333333-3333-4333-8333-333333333333" }
  ]) {
    const { service, calls } = createHarness({ currentUser });
    const staleContext = { user: memberUser, requestId: "req_stale" };
    await assert.rejects(() => service.cancelAppointment("appointment_1", staleContext), { code: "BOOKING_NOT_ALLOWED" });
    await assert.rejects(() => service.checkInAppointment("appointment_1", staleContext), { code: "BOOKING_NOT_ALLOWED" });
    assert.equal(calls.statusUpdates.length, 0);
  }
});

test("future selection observes the daily grid, short gaps, closures, and the actual current cell", async () => {
  for (const [patch, day, now, code] of [
    [{ startTime: "09:15" }, {}, null, "INVALID_TIME_RANGE"],
    [{ endTime: "10:00" }, {}, null, "INVALID_TIME_RANGE"],
    [{ startTime: "11:30", endTime: "13:30" }, {}, null, "TIME_UNAVAILABLE"],
    [{}, { closed: ["10:00"] }, null, "TIME_UNAVAILABLE"],
    [{}, { busy: [{ startTime: "10:00", endTime: "11:30" }] }, null, "APPOINTMENT_CONFLICT"],
    [{}, {}, "2999-01-01T09:30:00+08:00", "START_TIME_EXPIRED"],
    [{}, {}, "2999-01-01T10:30:00+08:00", "APPOINTMENT_ENDED"]
  ]) {
    const h = createHarness({ day, now: now && new Date(now) });
    await assert.rejects(h.service.createAppointment({ ...booking, ...patch }, { user: memberUser }), { code });
    assert.equal(h.calls.freezes, 0);
  }
  const h = createHarness({ now: new Date("2999-01-01T09:29:59.999+08:00"),
    day: { closed: ["10:30"], busy: [{ startTime: "08:00", endTime: "09:00" }] } });
  assert.equal((await h.service.createAppointment(booking, { user: memberUser })).startTime, "09:00");
});

test("editing a checked-in booking preserves its identity and check-in, even when extending into a short gap", async () => {
  const original = { ...booking, id: "appointment_1", userId: memberUser.id, version: 4, status: "checked_in",
    createdAt: "2998-12-31 18:00:00", checkedInAt: "2999-01-01 08:30:00", serviceItemName: "原项目名" };
  const h = createHarness({ original, now: new Date("2999-01-01T10:15:00+08:00"),
    day: { busy: [{ startTime: "11:00", endTime: "12:00" }] } });
  const edited = await h.service.modifyAppointment(original.id, { endTime: "11:00", version: 4 }, { user: memberUser });
  assert.equal(edited.id, original.id);
  assert.equal(edited.createdAt, original.createdAt);
  assert.equal(edited.checkedInAt, original.checkedInAt);
  assert.equal(edited.serviceItemName, "原项目名");
  assert.equal(edited.status, "checked_in");
  assert.equal(h.calls.dayReads[0].appointmentId, original.id);
  assert.deepEqual(h.calls.revisions, [{ before: original, after: edited }]);
  for (const [change, code] of [
    [{ startTime: "09:30", endTime: "11:00" }, "START_TIME_LOCKED"],
    [{ endTime: "10:00" }, "INVALID_TIME_RANGE"],
    [{ endTime: "11:30" }, "APPOINTMENT_CONFLICT"],
    [{ note: "过期资料", version: 3 }, "APPOINTMENT_VERSION_CONFLICT"]
  ]) {
    await assert.rejects(h.service.modifyAppointment(original.id, change, { user: memberUser }), { code });
  }
  const atEnd = createHarness({ original, now: new Date("2999-01-01T10:30:00+08:00") });
  await assert.rejects(atEnd.service.modifyAppointment(original.id, { endTime: "11:00" }, { user: memberUser }), { code: "APPOINTMENT_ENDED" });
  const later = createHarness({ original: { ...original, endTime: "12:00" }, now: new Date("2999-01-01T11:00:00+08:00") });
  await assert.rejects(later.service.modifyAppointment(original.id, { endTime: "11:00" }, { user: memberUser }), { code: "APPOINTMENT_ENDED" });
});

test("a future appointment can move into another continuous group on its original day", async () => {
  const h = createHarness();
  const result = await h.service.modifyAppointment("appointment_1", { startTime: "13:30", endTime: "15:00" }, { user: memberUser });
  assert.equal(result.startTime, "13:30");
  assert.equal(result.date, booking.date);
  assert.equal(result.therapistId, therapistId);
  assert.equal(result.version, 2);
});

test("cancel and check-in work from booked state", async () => {
  const { service, calls } = createHarness();
  await service.cancelAppointment("appointment_1", { user: memberUser, requestId: "req_test" });
  await service.checkInAppointment("appointment_1", { user: memberUser, requestId: "req_test" });
  assert.equal(calls.statusUpdates[0].status, "cancelled");
  assert.equal(calls.statusUpdates[1].status, "checked_in");
});

test("no_show appointments can be cancelled or checked in", async () => {
  const original = {
    id: "appointment_1",
    userId: "user_1",
    slotId: "slot_old",
    serviceItemId: projectId,
    date: "2999-01-01",
    startTime: "08:00",
    endTime: "09:00",
    status: "no_show",
    slotStatus: "open"
  };
  const { service, calls } = createHarness({ original });
  await service.cancelAppointment("appointment_1", { user: memberUser, requestId: "req_test" });
  await service.checkInAppointment("appointment_1", { user: memberUser, requestId: "req_test" });
  assert.equal(calls.statusUpdates[0].status, "cancelled");
  assert.equal(calls.statusUpdates[1].status, "checked_in");
});

test("a checked-in timestamp uses the appointment's own time on a booking with no slot", async () => {
  const h = createHarness();
  await h.service.checkInAppointment("appointment_1", { user: memberUser });
  assert.equal(h.calls.statusUpdates[0].status, "checked_in");
});

test("administrator uncheck-in returns future appointment to booked", async () => {
  const original = {
    id: "appointment_1",
    userId: "user_1",
    slotId: "slot_old",
    serviceItemId: projectId,
    date: "2999-01-01",
    startTime: "08:00",
    endTime: "09:00",
    status: "checked_in"
  };
  const { service, calls } = createHarness({ original, currentUser: { ...memberUser, role: "admin" } });
  const updated = await service.uncheckInAppointment(
    "appointment_1",
    { user: { ...memberUser, role: "admin" }, requestId: "req_test" },
    { admin: true }
  );
  assert.equal(updated.status, "booked");
  assert.equal(calls.statusUpdates[0].uncheckIn, true);
});

test("administrator uncheck-in returns expired appointment to no_show", async () => {
  const original = {
    id: "appointment_1",
    userId: "user_1",
    slotId: "slot_old",
    serviceItemId: projectId,
    date: "2000-01-01",
    startTime: "08:00",
    endTime: "09:00",
    status: "checked_in"
  };
  const { service, calls } = createHarness({ original, currentUser: { ...memberUser, role: "admin" } });
  const updated = await service.uncheckInAppointment(
    "appointment_1",
    { user: { ...memberUser, role: "admin" }, requestId: "req_test" },
    { admin: true }
  );
  assert.equal(updated.status, "no_show");
  assert.ok(calls.statusUpdates[0].fields.noShowAt instanceof Date);
});

test("customers cannot cancel check-in through the service", async () => {
  const original = {
    id: "appointment_1",
    userId: "user_1",
    slotId: "slot_old",
    serviceItemId: projectId,
    date: "2999-01-01",
    startTime: "08:00",
    endTime: "09:00",
    status: "checked_in"
  };
  const { service, calls } = createHarness({ original });
  await assert.rejects(
    () => service.uncheckInAppointment("appointment_1", { user: memberUser, requestId: "req_test" }),
    { code: "NOT_ADMIN", status: 403 }
  );
  assert.equal(calls.statusUpdates.length, 0);
});

test("therapists can check in only their own appointments after check-in opens", async () => {
  const therapistId = "33333333-3333-4333-8333-333333333333";
  const context = { user: { id: "therapist_user", role: "user", therapistId }, requestId: "req_test" };
  const original = {
    id: "appointment_1", userId: "customer", slotId: "slot_old", serviceItemId: projectId,
    therapistId, date: "2000-01-01", startTime: "08:00", endTime: "09:00", status: "no_show", slotStatus: "open"
  };
  const own = createHarness({ original, currentUser: context.user });
  await own.service.therapistCheckInAppointment("appointment_1", context);
  assert.equal(own.calls.statusUpdates[0].status, "checked_in");

  const other = createHarness({ currentUser: context.user, original: { ...original, therapistId: "44444444-4444-4444-8444-444444444444" } });
  await assert.rejects(() => other.service.therapistCheckInAppointment("appointment_1", context), { code: "APPOINTMENT_NOT_FOUND" });

  const future = createHarness({ currentUser: context.user, original: { ...original, date: "2999-01-01", status: "booked" }, now: new Date("2026-10-20T00:00:00Z") });
  await assert.rejects(() => future.service.therapistCheckInAppointment("appointment_1", context), { code: "CHECK_IN_TOO_EARLY" });
});

test("all identities share the inclusive one-hour check-in boundary, including midnight", async () => {
  const therapistId = "33333333-3333-4333-8333-333333333333";
  const actors = [
    { user: memberUser, options: {} },
    { user: { id: "staff", role: "user", therapistId }, therapist: true },
    { user: { id: "admin", role: "admin" }, options: { admin: true } },
    { user: { id: "admin", role: "admin", therapistId }, options: { admin: true } }
  ];
  for (const [date, startTime] of [["2026-10-20", "14:00"], ["2026-10-21", "00:30"]]) {
    const boundary = new Date(`${date}T${startTime}:00+08:00`).getTime() - 3600000;
    for (const actor of actors) {
      for (const offset of [-1, 0, 1, 7200000]) {
        const original = {
          id: "appointment_1", userId: memberUser.id, slotId: "slot_old", serviceItemId: projectId,
          therapistId, date, startTime, endTime: "23:59", status: "booked", slotStatus: "open"
        };
        const now = new Date(boundary + offset);
        const { service, calls } = createHarness({ original, now, currentUser: actor.user });
        const context = { user: actor.user };
        const operation = actor.therapist
          ? service.therapistCheckInAppointment("appointment_1", context)
          : service.checkInAppointment("appointment_1", context, actor.options);
        if (offset < 0) {
          await assert.rejects(operation, { code: "CHECK_IN_TOO_EARLY", status: 409 });
          assert.equal(calls.statusUpdates.length, 0);
        } else {
          await operation;
          assert.equal(calls.statusUpdates[0].status, "checked_in");
          assert.equal(calls.statusUpdates[0].fields.checkedInAt.getTime(), now.getTime());
        }
      }
    }
  }
});
