process.env.NODE_TEST_CONTEXT = "1";
process.env.JWT_SECRET = "test-secret";
process.env.DATABASE_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTherapistPortalService } = require("../src/services/therapistPortalService");

const therapistId = "33333333-3333-4333-8333-333333333333";
const otherTherapistId = "44444444-4444-4444-8444-444444444444";
const slotId = "11111111-1111-4111-8111-111111111111";
const appointmentId = "55555555-5555-4555-8555-555555555555";
const otherAppointmentId = "66666666-6666-4666-8666-666666666666";

function harness() {
  const calls = { filters: null, checkIn: null, noShows: 0 };
  const service = createTherapistPortalService({
    transaction: async (run) => run({}),
    currentActorService: { load: async ({ user }) => user },
    appointmentRepository: {
      findById: async (id) => id === appointmentId
        ? {
          id,
          slotId,
          therapistId,
          therapistName: "甲",
          date: "2999-01-01",
          startTime: "09:00",
          endTime: "10:00",
          status: "cancelled",
          userId: "customer-user",
          userPhone: "13800138000"
        }
        : id === otherAppointmentId
          ? { id, slotId: "other", therapistId: otherTherapistId, userPhone: "13900139000" }
          : null,
      listForTherapist: async (id, filters) => {
        calls.filters = { id, filters };
        return { appointments: [{ id: "a1", therapistId, userPhone: "13800138000" }], pagination: { page: 1 } };
      },
      countByTherapistGrouped: async () => ({ booked: 1, all: 1 })
    },
    appointmentService: {
      therapistCheckInAppointment: async (id, context) => {
        calls.checkIn = { id, context };
        return { id, therapistId, userPhone: "13800138000", status: "checked_in" };
      }
    },
    noShowService: { markNoShows: async () => { calls.noShows++; } }
  });
  return { service, calls };
}

test("therapist appointment filters cannot select another therapist and check-in keeps the caller context", async () => {
  const { service, calls } = harness();
  const user = { id: "u", therapistId };
  const result = await service.listAppointments({
    status: "pending", therapistIds: otherTherapistId,
    serviceItemIds: "55555555-5555-4555-8555-555555555555",
    fromDate: "2999-01-01", toDate: "2999-01-02", startTime: "09:00", endTime: "18:00"
  }, user);
  assert.equal(calls.noShows, 1);
  assert.equal(calls.filters.id, therapistId);
  assert.deepEqual(calls.filters.filters.therapistIds, []);
  assert.equal(result.appointments[0].userPhone, "138****8000");
  const context = { user, requestId: "req" };
  await service.checkIn(appointmentId, context);
  assert.deepEqual(calls.checkIn, { id: appointmentId, context });
});

test("therapists can open any of their own appointment cards by appointment id", async () => {
  const { service } = harness();
  const user = { id: "u", therapistId };
  const detail = await service.appointment(appointmentId, user);
  assert.equal(detail.appointment.status, "cancelled");
  assert.equal(detail.appointment.userPhone, "138****8000");
  assert.equal(detail.appointment.userId, undefined);
  assert.deepEqual(Object.keys(detail), ["appointment"]);
  await assert.rejects(() => service.appointment(otherAppointmentId, user), { code: "APPOINTMENT_NOT_FOUND" });
});
