process.env.NODE_TEST_CONTEXT = "1";
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../src/config/db");
const serviceItems = require("../src/repositories/serviceItemRepository");
const therapists = require("../src/repositories/therapistRepository");
const users = require("../src/repositories/userRepository");
const appointments = require("../src/repositories/appointmentRepository");
const audits = require("../src/services/auditService");
const logs = require("../src/services/logService");
const projectService = require("../src/services/projectService");
const therapistService = require("../src/services/therapistService");
const cleanupService = require("../src/services/recycleBinCleanupService");
const currentActor = require("../src/services/currentActorService");

// These unit fixtures model authorized catalog operations. Session revocation
// and role changes are exercised through real HTTP/transactions separately.
test.beforeEach((t) => t.mock.method(currentActor, "load", async () => ({ id: "admin", role: "admin" })));

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const THERAPIST_A = "33333333-3333-4333-8333-333333333333";
const THERAPIST_B = "44444444-4444-4444-8444-444444444444";

function patch(target, key, value, restores) {
  const original = target[key];
  target[key] = value;
  restores.push(() => { target[key] = original; });
}

function context() {
  return { user: { id: "admin" }, requestId: "request", ip: "127.0.0.1" };
}

test("restored projects are appended to the active catalog in selected order", async () => {
  const restores = [];
  const writes = [];
  const auditActions = [];
  try {
    patch(db, "transaction", async (handler) => handler({}), restores);
    patch(db, "query", async () => ({ rows: [] }), restores);
    patch(serviceItems, "listInactiveByIdsForUpdate", async () => [
      { id: PROJECT_B, name: "项目乙", status: "inactive" },
      { id: PROJECT_A, name: "项目甲", status: "inactive" }
    ], restores);
    patch(serviceItems, "maxActiveSortOrder", async () => 7, restores);
    patch(serviceItems, "restore", async (id, sortOrder) => {
      writes.push({ id, sortOrder });
      return { id, name: id === PROJECT_A ? "项目甲" : "项目乙", status: "active", sortOrder };
    }, restores);
    patch(audits, "record", async ({ action, resourceId }) => auditActions.push({ action, resourceId }), restores);

    const result = await projectService.restore([PROJECT_A, PROJECT_B], context());

    assert.deepEqual(writes, [
      { id: PROJECT_A, sortOrder: 8 },
      { id: PROJECT_B, sortOrder: 9 }
    ]);
    assert.equal(result.restored, 2);
    assert.deepEqual(result.items.map((item) => item.id), [PROJECT_A, PROJECT_B]);
    assert.deepEqual(auditActions, [
      { action: "restore_project", resourceId: PROJECT_A },
      { action: "restore_project", resourceId: PROJECT_B }
    ]);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test("select-all recovery accepts recycle bins larger than 100 records", async () => {
  const restores = [];
  const ids = Array.from({ length: 101 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
  );
  try {
    patch(db, "transaction", async (handler) => handler({}), restores);
    patch(db, "query", async () => ({ rows: [] }), restores);
    patch(serviceItems, "listInactiveByIdsForUpdate", async () => ids.map((id) => ({ id, status: "inactive" })), restores);
    patch(serviceItems, "maxActiveSortOrder", async () => 0, restores);
    patch(serviceItems, "restore", async (id, sortOrder) => ({ id, status: "active", sortOrder }), restores);
    patch(therapists, "listDeletedByIdsForUpdate", async () => ids.map((id) => ({ id, status: "deleted", phone: null, userId: null })), restores);
    patch(therapists, "maxActiveSortOrder", async () => 0, restores);
    patch(therapists, "restore", async (id, input) => ({ id, status: "active", phone: null, userId: null, sortOrder: input.sortOrder }), restores);
    patch(audits, "record", async () => {}, restores);

    assert.equal((await projectService.restore(ids, context())).restored, 101);
    assert.equal((await therapistService.restore(ids, context())).restored, 101);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test("project recovery rejects a stale selection before changing any record", async () => {
  const restores = [];
  let writes = 0;
  try {
    patch(db, "transaction", async (handler) => handler({}), restores);
    patch(db, "query", async () => ({ rows: [] }), restores);
    patch(serviceItems, "listInactiveByIdsForUpdate", async () => [{ id: PROJECT_A }], restores);
    patch(serviceItems, "restore", async () => { writes += 1; }, restores);

    await assert.rejects(
      () => projectService.restore([PROJECT_A, PROJECT_B], context()),
      { code: "PROJECT_RECYCLE_BIN_CHANGED", status: 409 }
    );
    assert.equal(writes, 0);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test("manual project purge is audited and removes every selected recycle-bin record", async () => {
  const restores = [];
  const purged = [];
  const auditActions = [];
  try {
    patch(db, "transaction", async (handler) => handler({}), restores);
    patch(db, "query", async () => ({ rows: [] }), restores);
    patch(serviceItems, "listInactiveByIdsForUpdate", async () => [
      { id: PROJECT_A, name: "项目甲", status: "inactive" },
      { id: PROJECT_B, name: "项目乙", status: "inactive" }
    ], restores);
    patch(serviceItems, "purge", async (id) => {
      purged.push(id);
      return { id, name: `已永久删除项目-${id}`, status: "inactive" };
    }, restores);
    patch(audits, "record", async ({ action, resourceId }) => auditActions.push({ action, resourceId }), restores);

    const result = await projectService.purge([PROJECT_A, PROJECT_B], context());

    assert.deepEqual(purged, [PROJECT_A, PROJECT_B]);
    assert.deepEqual(auditActions, [
      { action: "purge_project", resourceId: PROJECT_A },
      { action: "purge_project", resourceId: PROJECT_B }
    ]);
    assert.equal(result.purged, 2);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test("restored therapists are appended and safely rebound by current phone ownership", async () => {
  const restores = [];
  const writes = [];
  const sessionBumps = [];
  try {
    patch(db, "transaction", async (handler) => handler({}), restores);
    patch(db, "query", async () => ({ rows: [] }), restores);
    patch(therapists, "listDeletedByIdsForUpdate", async () => [
      { id: THERAPIST_B, name: "乙", phone: "13900139000", userId: null, status: "deleted" },
      { id: THERAPIST_A, name: "甲", phone: "13800138000", userId: "old-user", status: "deleted" }
    ], restores);
    patch(therapists, "maxActiveSortOrder", async () => 4, restores);
    patch(therapists, "findActiveByPhone", async () => null, restores);
    patch(users, "findByPhone", async (phone) => phone === "13800138000" ? { id: "current-user" } : null, restores);
    patch(therapists, "findActiveByUserId", async () => null, restores);
    patch(therapists, "restore", async (id, input) => {
      writes.push({ id, ...input });
      return {
        id,
        name: id === THERAPIST_A ? "甲" : "乙",
        phone: id === THERAPIST_A ? "13800138000" : "13900139000",
        userId: input.userId,
        status: "active",
        sortOrder: input.sortOrder
      };
    }, restores);
    patch(users, "incrementSessionVersion", async (id) => { sessionBumps.push(id); }, restores);
    patch(appointments, "listFutureEffectiveByUser", async () => [], restores);
    patch(audits, "record", async () => {}, restores);

    const result = await therapistService.restore([THERAPIST_A, THERAPIST_B], context());

    assert.deepEqual(writes, [
      { id: THERAPIST_A, sortOrder: 5, userId: "current-user" },
      { id: THERAPIST_B, sortOrder: 6, userId: null }
    ]);
    assert.deepEqual(sessionBumps, ["old-user", "current-user"]);
    assert.equal(result.restored, 2);
    assert.deepEqual(result.therapists.map((item) => item.id), [THERAPIST_A, THERAPIST_B]);
    assert.equal(result.therapists[0].phone, undefined);
    assert.equal(result.therapists[0].userId, undefined);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test("therapist recovery stops when an active therapist already owns the phone", async () => {
  const restores = [];
  let writes = 0;
  try {
    patch(db, "transaction", async (handler) => handler({}), restores);
    patch(db, "query", async () => ({ rows: [] }), restores);
    patch(therapists, "listDeletedByIdsForUpdate", async () => [
      { id: THERAPIST_A, name: "甲", phone: "13800138000", userId: null, status: "deleted" }
    ], restores);
    patch(therapists, "maxActiveSortOrder", async () => 4, restores);
    patch(therapists, "findActiveByPhone", async () => ({ id: THERAPIST_B }), restores);
    patch(therapists, "restore", async () => { writes += 1; }, restores);

    await assert.rejects(
      () => therapistService.restore([THERAPIST_A], context()),
      { code: "THERAPIST_PHONE_EXISTS", status: 409 }
    );
    assert.equal(writes, 0);
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});

test("automatic cleanup permanently removes only records due at the 30-day cutoff", async () => {
  const restores = [];
  const purgedProjects = [];
  const purgedTherapists = [];
  let projectCutoff;
  let therapistCutoff;
  try {
    patch(db, "transaction", async (handler) => handler({}), restores);
    patch(db, "query", async () => ({ rows: [] }), restores);
    patch(serviceItems, "listInactiveDueForPurge", async (cutoff) => {
      projectCutoff = cutoff;
      return [{ id: PROJECT_A }];
    }, restores);
    patch(therapists, "listDeletedDueForPurge", async (cutoff) => {
      therapistCutoff = cutoff;
      return [{ id: THERAPIST_A }];
    }, restores);
    patch(serviceItems, "purge", async (id) => { purgedProjects.push(id); }, restores);
    patch(therapists, "purge", async (id) => { purgedTherapists.push(id); }, restores);
    patch(logs, "business", async () => {}, restores);

    const now = new Date("2026-10-16T03:00:00.000Z");
    const result = await cleanupService.purgeExpired({ now, retentionDays: 30 });

    assert.equal(projectCutoff.toISOString(), "2026-09-16T03:00:00.000Z");
    assert.equal(therapistCutoff.toISOString(), "2026-09-16T03:00:00.000Z");
    assert.deepEqual(purgedProjects, [PROJECT_A]);
    assert.deepEqual(purgedTherapists, [THERAPIST_A]);
    assert.deepEqual(result, {
      projects: 1,
      therapists: 1,
      retentionDays: 30,
      cutoff: "2026-09-16T03:00:00.000Z"
    });
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
});
