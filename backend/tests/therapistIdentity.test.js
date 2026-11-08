process.env.NODE_TEST_CONTEXT = "1";
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/config/db");
const therapistRepository = require("../src/repositories/therapistRepository");
const appointmentRepository = require("../src/repositories/appointmentRepository");
const serviceItemRepository = require("../src/repositories/serviceItemRepository");
const userRepository = require("../src/repositories/userRepository");
const auditService = require("../src/services/auditService");
const logService = require("../src/services/logService");
const imageService = require("../src/services/therapistImageService");
const therapistService = require("../src/services/therapistService");
const currentActor = require("../src/services/currentActorService");
const scheduleRepository = require("../src/repositories/scheduleRepository");

test.beforeEach((t) => t.mock.method(currentActor, "load", async () => ({ id: "admin", role: "admin" })));

test("public therapist data never exposes phone or linked account identifiers", () => {
  const item = therapistService.publicView({
    id: "t1", name: "甲", phone: "13800138000", userId: "u1", linkedAt: "now", accountLinked: true
  });
  assert.equal(item.name, "甲");
  assert.equal(item.phone, undefined);
  assert.equal(item.userId, undefined);
  assert.equal(item.accountLinked, undefined);
});

function patch(target, key, value, restores) {
  const original = target[key];
  target[key] = value;
  restores.push(() => { target[key] = original; });
}

test("specialties accept more than twelve active projects without weakening validation", async () => {
  const restores = [];
  const ids = Array.from({ length: 13 }, (_, index) => `project-${index}`);
  const payload = {
    name: "甲", phone: "13800138000", bio: "简介", serviceItemIds: ids,
    imageUrl: "/uploads/therapists/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png"
  };
  try {
    patch(serviceItemRepository, "listActive", async () => ids.map((id) => ({ id })), restores);
    assert.deepEqual((await therapistService.validate(payload)).serviceItemIds, ids);
    assert.equal((await therapistService.validate({ ...payload, serviceItemIds: [...ids, ids[0]] })).serviceItemIds.length, 13);
    for (const value of [null, "project-1", [{}], ["inactive-project"]]) {
      await assert.rejects(therapistService.validate({ ...payload, serviceItemIds: value }), { code: "INVALID_TAGS" });
    }
    const { serviceItemIds, ...profileOnly } = payload;
    await assert.rejects(therapistService.validate(profileOnly), { code: "INVALID_TAGS" });
    assert.equal((await therapistService.validate(profileOnly, null, { allowUnchangedSpecialties: true })).serviceItemIds, undefined);
    assert.deepEqual((await therapistService.validate({ ...payload, serviceItemIds: [] })).serviceItemIds, []);
  } finally { restores.reverse().forEach((restore) => restore()); }
});

test("login-side therapist binding cancels every future effective customer appointment", async () => {
  const restores = [];
  const updates = [];
  try {
    patch(therapistRepository, "findActiveByPhone", async () => ({ id: "t1", userId: null, status: "active" }), restores);
    patch(therapistRepository, "findActiveByUserId", async () => null, restores);
    patch(therapistRepository, "bindUser", async (id, userId) => ({ id, userId, status: "active" }), restores);
    patch(appointmentRepository, "listFutureEffectiveByUser", async () => [
      { id: "a1", date: "2999-01-01", startTime: "09:00", endTime: "10:00" },
      { id: "a2", date: "2999-01-02", startTime: "10:00", endTime: "11:00" }
    ], restores);
    patch(appointmentRepository, "updateStatus", async (id, status) => { updates.push({ id, status }); return { id, status }; }, restores);
    patch(logService, "business", async () => {}, restores);
    patch(userRepository, "incrementSessionVersion", async () => ({}), restores);
    const result = await therapistService.linkUserForPhone("13800138000", { id: "u1", role: "user" }, {}, { requestId: "req" });
    assert.equal(result.therapist.userId, "u1");
    assert.deepEqual(updates, [{ id: "a1", status: "cancelled" }, { id: "a2", status: "cancelled" }]);
  } finally { restores.reverse().forEach((restore) => restore()); }
});

test("administrator-created therapist binds an existing phone account and reports automatic cancellations", async () => {
  const restores = [];
  const weeks = [], client = {};
  let linkedTherapist = null;
  try {
    patch(db, "transaction", async (handler) => handler(client), restores);
    patch(scheduleRepository, "saveWeekly", async (id, weekday, rule, transaction) => {
      assert.equal(transaction, client, "weekly defaults share the therapist creation transaction");
      weeks.push({ id, weekday, rule });
    }, restores);
    patch(db, "query", async () => ({ rows: [] }), restores);
    patch(serviceItemRepository, "listActive", async () => [{ id: "p1" }], restores);
    patch(imageService, "assertExists", async () => {}, restores);
    patch(therapistRepository, "findActiveByPhone", async () => null, restores);
    patch(userRepository, "findByPhone", async () => ({ id: "u1", phone: "13800138000", role: "user" }), restores);
    patch(therapistRepository, "findActiveByUserId", async () => linkedTherapist, restores);
    patch(therapistRepository, "save", async (id, input) => ({ id: "t1", status: "active", ...input }), restores);
    patch(appointmentRepository, "listFutureEffectiveByUser", async () => [
      { id: "a1", date: "2999-01-01", startTime: "09:00", endTime: "10:00" }
    ], restores);
    patch(appointmentRepository, "updateStatus", async (id, status) => ({ id, status }), restores);
    patch(auditService, "record", async () => {}, restores);
    patch(userRepository, "incrementSessionVersion", async () => ({}), restores);
    const saved = await therapistService.save(null, {
      name: "测试芳疗师", phone: "13800138000", bio: "简介", serviceItemIds: ["p1"],
      imageUrl: "/uploads/therapists/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png"
    }, { user: { id: "admin" }, requestId: "req" });
    assert.equal(saved.userId, "u1");
    assert.equal(saved.cancelledAppointments, 1);
    assert.deepEqual(weeks, Array.from({ length: 7 }, (_, i) => ({ id: "t1", weekday: i + 1, rule: {
      step: 30, minDuration: 90, serviceItemIds: [], ranges: [
        { startTime: "09:00", endTime: "12:00" },
        { startTime: "14:00", endTime: "17:00" },
        { startTime: "19:00", endTime: "21:00" }
      ]
    } })));
    linkedTherapist = { id: "another-therapist" };
    await assert.rejects(() => therapistService.save(null, {
      name: "重复账号", phone: "13800138000", bio: "简介", serviceItemIds: ["p1"],
      imageUrl: "/uploads/therapists/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png"
    }, { user: { id: "admin" } }), { code: "THERAPIST_ACCOUNT_EXISTS" });
    assert.equal(weeks.length, 7, "a rejected duplicate cannot seed another week");
  } finally { restores.reverse().forEach((restore) => restore()); }
});

test("a changed authorized phone removes a stale therapist account binding", async () => {
  const restores = [];
  let unbound = "";
  try {
    patch(therapistRepository, "findActiveByUserId", async () => ({ id: "t-old", phone: "13800138000", userId: "u1", status: "active" }), restores);
    patch(therapistRepository, "findActiveByPhone", async () => null, restores);
    patch(therapistRepository, "unbindUser", async (id) => { unbound = id; return { id, userId: null }; }, restores);
    patch(logService, "business", async () => {}, restores);
    patch(userRepository, "incrementSessionVersion", async () => ({}), restores);
    const result = await therapistService.linkUserForPhone("13900139000", { id: "u1", role: "user" }, {}, { requestId: "req" });
    assert.equal(unbound, "t-old");
    assert.equal(result.therapist, null);
    assert.equal(result.cancelledAppointments.length, 0);
  } finally { restores.reverse().forEach((restore) => restore()); }
});
