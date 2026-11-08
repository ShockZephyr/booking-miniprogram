const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, flush } = require("./support/scheduleUI");

const event = date => ({ detail: { date } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("a real login or cold launch selects Shanghai today; a profile refresh and tab returns keep the selected day", async () => {
  const h = setup(), page = h.page("pages/booking"); page.onLoad(); await page.onShow();
  const selected = "2026-11-02";
  page.changeDate(event(selected)); await flush(); page.onHide(); await page.onShow();
  assert.equal(page.data.selectedDate, selected);
  h.app.refreshMe = async () => h.app.globalData.user; await page.onShow();
  assert.equal(page.data.selectedDate, selected);
  h.app._loginSessionVersion++; await page.onShow();
  assert.equal(page.data.selectedDate, h.day.today);
  page.changeDate(event(selected)); await flush();
  const fresh = h.page("pages/booking"); fresh.onLoad(); await fresh.onShow();
  assert.equal(fresh.data.selectedDate, h.day.today);
});

for (const fail of [false, true]) {
  test("stale roster " + (fail ? "failure" : "success") + " cannot overwrite another date or login", async () => {
    const h = setup(), page = h.page("pages/booking"); page.onLoad(); await page.onShow();
    const first = deferred();
    const response = h.deps.schedules.list;
    h.deps.schedules.list = date => date === "2026-11-01" ? first.promise : response(date);
    page.changeDate(event("2026-11-01"));
    h.app.globalData.user = { id: "admin", role: "admin" }; h.app._loginSessionVersion++;
    await page.onShow();
    if (fail) first.reject(new Error("stale error")); else first.resolve({ today: h.day.today, daysVisible: 7, therapists: [{ id: "obsolete" }] });
    await flush();
    assert.equal(page.data.therapists[0].id, "t"); assert.equal(page.data.error, ""); assert.equal(page.data.isAdmin, true);
  });
}

test("assigned therapist tab loads the therapist's day directly and never requests a list of other people", async () => {
  const h = setup(); h.app.globalData.user = { id: "staff", therapistId: "t2" };
  h.deps.schedules.list = () => assert.fail("private schedule should load directly");
  const page = h.page("pages/booking"); page.onLoad(); await page.onShow();
  assert.equal(page.data.target.therapistId, "t2"); assert.equal(page.data.target.date, h.day.today);
  page.windowLoaded({ detail: h.day }); page.changeDate(event("2026-11-01"));
  assert.equal(page.data.target.date, "2026-11-01"); assert.equal(page.data.therapists.length, 0);
});

test("the roster retries failures, clamps a shrunken booking window and keeps calendar dates bounded", async () => {
  const h = setup(), page = h.page("pages/booking"); page.onLoad(); await page.onShow();
  const response = h.deps.schedules.list;
  h.deps.schedules.list = async () => { throw new Error("排班读取失败"); };
  page.changeDate(event("2026-11-04")); await flush(); assert.equal(page.data.selectedDate, "2026-11-04");
  assert.match(page.data.error, /读取失败/);
  h.day.daysVisible = 1;
  h.deps.schedules.list = async date => {
    if (date !== h.day.today) throw Object.assign(new Error("日期已超出范围"), { code: "DATE_OUT_OF_RANGE", statusCode: 409 });
    return response(date);
  };
  await page.loadDay(); assert.equal(page.data.last, h.day.today); assert.equal(page.data.selectedDate, h.day.today);
  page.changeDate(event("2026-10-31")); assert.equal(page.data.selectedDate, h.day.today);
  h.day.daysVisible = 2147483647; await page.loadDay();
  assert.equal(page.data.last, "9999-12-31"); assert.ok(page.data.months.length <= 6);
});

test("a changed login invalidates a pending day read and its editing controls", async () => {
  const h = setup(), pending = deferred(); h.deps.schedules.day = () => pending.promise;
  const board = h.board(true);
  h.app.globalData.user = { id: "new", role: "admin" }; h.app._loginSessionVersion++;
  pending.resolve(h.day); await flush(); assert.equal(board.data.day, null);
  assert.equal(board.data.nextReady, false); assert.equal(board.data.note, "");
});
