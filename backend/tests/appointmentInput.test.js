process.env.NODE_TEST_CONTEXT = "1";
process.env.DATABASE_URL = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const { appointmentInput, calendarRange } = require("../src/utils/appointmentInput");
const controller = require("../src/controllers/appointmentController");

const therapistId = "11111111-1111-4111-8111-111111111111";
const serviceItemId = "22222222-2222-4222-8222-222222222222";
const booking = { therapistId, serviceItemId, date: "2999-01-01", startTime: "09:00", endTime: "10:30" };

test("appointment input rejects malformed bodies, invalid UUIDs and invalid notes", () => {
  for (const input of [undefined, null, [], "text", {}, { ...booking, serviceItemId: "bad" },
    { ...booking, slotId: therapistId }, { ...booking, therapistId: [therapistId] }, { ...booking, note: {} },
    { ...booking, endTime: "24:00" }, { ...booking, startTime: "11:00" }, { ...booking, note: "字".repeat(251) }]) {
    assert.throws(() => appointmentInput(input), (error) => error.status === 400);
  }
  assert.equal(appointmentInput({ ...booking, note: "字".repeat(250) }).note.length, 250);
  assert.equal(appointmentInput({ note: "仅修改备注" }, { partial: true }).note, "仅修改备注");
  for (const edit of [{ slotId: therapistId }, { therapistId }, { date: booking.date }, { version: 1 }, { note: "", version: -1 }]) {
    assert.throws(() => appointmentInput(edit, { partial: true }), { code: "INVALID_APPOINTMENT_INPUT" });
  }
});

test("invalid appointment ids and calendar dates are rejected before database access", async () => {
  const res = { json: () => assert.fail("invalid input cannot succeed") };
  for (const action of ["adminGet", "cancel", "checkIn", "modify", "adminCancel", "adminCheckIn", "adminUncheckIn"]) {
    await assert.rejects(() => controller[action]({ params: { id: "not-a-uuid" }, body: {}, user: {} }, res),
      { code: "APPOINTMENT_NOT_FOUND", status: 404 });
  }
  for (const [from, to] of [["not-a-date", "2026-10-18"], ["2026-02-30", "2026-03-01"],
    ["2026-10-19", "2026-10-18"], [["2026-10-17"], "2026-10-18"], [undefined, undefined]]) {
    await assert.rejects(() => controller.calendarStatus({ query: { from, to }, user: {} }, res),
      { code: "INVALID_DATE", status: 400 });
  }
  assert.deepEqual(calendarRange("2024-02-29", "2024-03-01"), { from: "2024-02-29", to: "2024-03-01" });
});

test("malformed JSON and oversized requests return client errors instead of server errors", () => {
  const errorHandler = require("../src/middleware/errorHandler");
  for (const [type, expectedStatus, code] of [
    ["entity.parse.failed", 400, "INVALID_JSON"], ["entity.too.large", 413, "REQUEST_TOO_LARGE"]
  ]) {
    let status, body;
    errorHandler({ type }, { requestId: "input-test", originalUrl: "/api/appointments" }, {
      status(value) { status = value; return this; }, json(value) { body = value; }
    }, () => {});
    assert.equal(status, expectedStatus);
    assert.equal(body.code, code);
  }
});
