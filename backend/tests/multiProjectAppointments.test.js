const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setup, flush, plain, inputEvent, tap, confirmLatest } = require("./support/scheduleUI");
const { appointmentInput } = require("../src/utils/appointmentInput");
const display = require("../../miniprogram/utils/appointmentDisplay");
const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";

test("multiple project input rejects empty, repeated, malformed and ambiguous values", () => {
  const base = { therapistId: a, date: "2026-12-01", startTime: "09:00", endTime: "10:30" };
  for (const serviceItemIds of [[], [a,a], [a,null], "a", [a,"bad"]]) {
    assert.throws(() => appointmentInput({ ...base, serviceItemIds }), { code: "INVALID_APPOINTMENT_INPUT" });
  }
  assert.throws(() => appointmentInput({ ...base, serviceItemId: a, serviceItemIds: [a,b] }));
  assert.doesNotThrow(() => appointmentInput({ ...base, serviceItemIds: [a,b] }));
  assert.doesNotThrow(() => appointmentInput({ ...base, serviceItemId: a }));
});

test("multiple projects submit as one booking and survive reload without time or note changes", async () => {
  const h = setup(); h.day.serviceItemIds = ["p", "q"];
  const board = h.board(); await flush();
  assert.deepEqual(plain(board.data.selectedItemIds), []);
  board.pickItem(inputEvent(board, ["q", "p"]));
  board.inputNote(inputEvent(board, "两个项目同一时段"));
  tap(board, "09:00"); tap(board, "10:30");
  await board.load();
  assert.deepEqual(plain(board.data.selectedItemIds), ["p", "q"]);
  board.submit();
  assert.match(h.calls.find(c => c[0] === "modal")[1].content, /项目：项目一、项目二/);
  await confirmLatest(h);
  const writes = h.calls.filter(c => c[0] === "create");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][1].serviceItemIds, ["p", "q"]);
  assert.equal(writes[0][1].endTime, "10:30");
  assert.equal(writes[0][1].serviceItemId, undefined);
  board.detach();
});

test("editing restores every project and removes only unavailable choices with a notice", async () => {
  const h = setup(); h.day.serviceItemIds = ["p", "q"];
  h.record.serviceItems = [{ id: "p", name: "项目一" }, { id: "q", name: "项目二" }];
  const board = h.board(true); await flush();
  assert.deepEqual(plain(board.data.selectedItemIds), ["p", "q"]);
  const old = inputEvent(board, ["p"]);
  h.day.serviceItemIds = ["q"]; await board.load();
  board.pickItem(old);
  assert.deepEqual(plain(board.data.selectedItemIds), ["q"]);
  assert.match(board.data.notice, /部分原选项目/);
  assert.equal(board.data.note, "原备注");
  board.detach();
});

test("explicit guest login carries all selected projects; account changes discard a stale selection", async () => {
  const h = setup(); h.day.serviceItemIds = ["p", "q"]; h.app.globalData.user = null; h.app.globalData.token = "";
  const board = h.board(); await flush();
  board.pickItem(inputEvent(board, ["p", "q"])); tap(board, "09:00"); tap(board, "10:30"); board.submit();
  await confirmLatest(h);
  assert.deepEqual(plain(h.app._loginReturn.bookingDraft.serviceItemIds), ["p", "q"]);
  const old = inputEvent(board, ["p"]);
  h.app.globalData.user = { id: "another", role: "user" }; h.app._loginSessionVersion++;
  board.activate(); await flush(); board.pickItem(old);
  assert.deepEqual(plain(board.data.selectedItemIds), []);
  board.detach();
});

test("customer details request only their appointment history and reject stale replies and hidden actions", async () => {
  const h = setup(); h.app.globalData.user.capabilities = { bookAppointment: true };
  h.deps.appointment.detail = async (id, options) => {
    assert.equal(options.includeHistory, true);
    return { appointment: plain(h.record), history: [{ id: 1, before: { serviceItemName: "项目一" } }] };
  };
  const page = h.page("pages/appointment-detail"); page.onLoad({ appointmentId: "a" }); page.onShow(); await flush();
  assert.equal(page.data.appointment.id, "a"); assert.equal(page.data.historyAppointments.length, 1);
  page.onHide(); page.action({ detail: { type: "modify" } }); assert.equal(h.calls.filter(c => c[0] === "navigate").length, 0);
  let resolve; h.deps.appointment.detail = () => new Promise(done => { resolve = done; });
  page.onShow(); await flush(); h.app.globalData.user = { id: "other", role: "user" };
  resolve({ appointment: h.record, history: [] }); await flush(); assert.equal(page.data.appointment, null);
  page.onUnload();
});

test("shared cards truncate by code point, isolate image callbacks and stop actions while busy", () => {
  const root = path.join(__dirname, "../../miniprogram"); let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, "components/appointment-card/index.js"), "utf8"), {
    Component: value => { definition = value; }, require: name => name.endsWith("appointmentDisplay") ? display
      : name.endsWith("imageFallback") ? require("../../miniprogram/utils/imageFallback") : { imageUrl: url => url || "" }
  });
  const host = { ...definition.methods, data: plain(definition.data), properties: { appointment: { id: "a" } },
    setData(value) { Object.assign(this.data, value); }, triggerEvent() { throw new Error("busy action escaped"); } };
  const bind = item => {
    host.properties.appointment = item;
    definition.observers.appointment.call(host, item);
  };
  bind({ id: "a", note: "😀".repeat(11), serviceItems: [{ id: "p", name: "字".repeat(18), imageUrl: "/same.png" }] });
  assert.equal(host.data.summary, "字".repeat(14) + "…");
  assert.equal(host.data.detailSummary, "字".repeat(10) + "…");
  assert.equal(host.data.adminDetailSummary, "字".repeat(8) + "…");
  assert.equal(host.data.noteSummary, "😀".repeat(10) + "…");
  const old = { currentTarget: { dataset: { attempt: host.data.imageAttempt } } };
  bind({ id: "b", serviceItems: [{ id: "p", name: "项目", imageUrl: "/same.png" }] });
  host.imageError(old); assert.equal(host.data.imageFailed, false);
  host.imageError({ currentTarget: { dataset: { attempt: host.data.imageAttempt } } });
  assert.equal(host.data.imageFailed, true); host.retryImage(); assert.equal(host.data.imageFailed, false);
  host.properties.busy = true; host.action({ currentTarget: { dataset: { type: "checkIn" } } });
});

test("phone is absent from list summaries and remains admin-only in details", () => {
  const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/components/appointment-card/index.wxml"), "utf8");
  assert.match(template, /detail \? \(actionMode === 'admin' \? adminDetailSummary : detailSummary\) : summary/);
  assert.doesNotMatch(template, /!detail && actionMode === 'admin'[^>]*>会员手机：/);
  assert.match(template, /wx:if="{{actionMode === 'admin'}}" class="info-row"><text class="row-label">会员手机/);
  assert.match(template, /wx:if="{{showMemberInfo}}" class="member-info"/);
});
