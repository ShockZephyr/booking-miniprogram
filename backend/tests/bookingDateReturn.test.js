const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, flush } = require("./support/scheduleUI");

const change = date => ({ detail: { date } });
const navigation = h => h.calls.filter(call => call[0] === "navigate").at(-1)[1];

async function scenario() {
  const h = setup(); h.day.today = "2026-10-31";
  h.setNow("2026-10-31T08:00:00+08:00");
  h.requestedDates = [];
  h.deps.schedules.list = async date => {
    h.requestedDates.push(date);
    return { today: h.day.today, daysVisible: 7, therapists: [{ id: "t", name: "测试人员", status: "available", scheduleDate: date }] };
  };
  h.roster = h.page("pages/booking"); h.roster.onLoad(); await h.roster.onShow();
  return h;
}

async function enter(h, channel = true) {
  h.roster.openDay({ detail: { therapist: h.roster.data.therapists[0] } });
  const nav = navigation(h);
  h.roster.onHide();
  const detail = h.page("pages/schedule-day");
  detail.getOpenerEventChannel = () => {
    if (!channel) throw new Error("unavailable");
    return { emit: (name, payload) => nav.events[name](payload) };
  };
  detail.onLoad(Object.fromEntries(new URLSearchParams(nav.url.split("?")[1])));
  await detail.onShow(); await detail.windowLoaded({ detail: h.day });
  return { detail, nav };
}

async function back(h, detail) {
  detail.onHide(); detail.onUnload();
  await h.roster.onShow();
}

function assertDate(h, date) {
  assert.equal(h.roster.data.selectedDate, date);
  assert.equal(h.roster.data.therapists[0].scheduleDate, date);
  assert.equal(h.requestedDates.at(-1), date);
  h.roster.openCalendar();
  assert.ok(h.roster.data.months.some(month => month.days.some(day => day.date === date && !day.disabled)));
  h.roster.closeCalendar();
}

for (const role of ["user", "admin"]) {
  test(`${role}: selecting October 31 and entering a therapist without any action keeps October 31 on return`, async () => {
    const h = await scenario();
    h.app.globalData.user.role = role;
    await h.roster.onShow();
    h.roster.changeDate(change("2026-11-02")); await flush();
    h.roster.changeDate(change("2026-10-31")); await flush();
    for (let visit = 0; visit < 3; visit++) {
      const { detail } = await enter(h);
      assert.equal(detail.data.target.date, "2026-10-31");
      await back(h, detail);
      assertDate(h, "2026-10-31");
    }
  });
}

test("returning without changing the daily schedule cannot reuse an earlier navigation's date", async () => {
  const h = await scenario();
  const first = await enter(h, false);
  first.detail.changeDate(change("2026-11-02"));
  await back(h, first.detail); assertDate(h, "2026-11-02");
  h.roster.changeDate(change("2026-10-31")); await flush();
  // A queued callback from the old page must not repopulate the return state.
  first.detail.notifyOpenerDate("2026-11-02");
  const second = await enter(h);
  assert.equal(second.detail.data.target.date, "2026-10-31");
  await back(h, second.detail);
  assertDate(h, "2026-10-31");
  h.roster.openDay({ detail: { therapist: h.roster.data.therapists[0] } });
  assert.match(navigation(h).url, /date=2026-10-31(?:&|$)/);
});

test("an old return event cannot overwrite the selected date or the new navigation", async () => {
  const h = await scenario(), first = await enter(h);
  await back(h, first.detail);
  h.roster.changeDate(change("2026-11-02")); await flush();
  first.nav.events.dateChange({ date: "2026-10-31" });
  assertDate(h, "2026-11-02");
  const second = await enter(h);
  first.nav.events.dateChange({ date: "2026-11-03" });
  await back(h, second.detail);
  assertDate(h, "2026-11-02");
});

for (const channel of [true, false]) {
  test(`the latest date returns once, including change-away-and-back (event channel: ${channel})`, async () => {
    const h = await scenario(), first = await enter(h, channel);
    first.detail.changeDate(change("2026-11-02"));
    first.detail.changeDate(change("2026-11-04"));
    await back(h, first.detail); assertDate(h, "2026-11-04");
    const second = await enter(h, channel);
    second.detail.changeDate(change("2026-11-03"));
    second.detail.changeDate(change("2026-11-04"));
    await back(h, second.detail); assertDate(h, "2026-11-04");
    const third = await enter(h, channel);
    await back(h, third.detail); assertDate(h, "2026-11-04");
  });
}

test("rapid double taps open one schedule, and a failed navigation permits a fresh visit", async () => {
  const h = await scenario();
  const open = () => h.roster.openDay({ detail: { therapist: h.roster.data.therapists[0] } });
  open(); const failed = navigation(h);
  open(); assert.equal(h.calls.filter(call => call[0] === "navigate").length, 1);
  failed.fail();
  const current = await enter(h);
  assert.notEqual(current.nav.url, failed.url);
  failed.events.dateChange({ date: "2026-11-02" });
  failed.fail();
  current.detail.changeDate(change("2026-11-03"));
  await back(h, current.detail); assertDate(h, "2026-11-03");
});

test("a previous schedule cannot return its date after a same-account relogin", async () => {
  const h = await scenario(), first = await enter(h);
  first.detail.changeDate(change("2026-11-02"));
  h.app._loginSessionVersion++;
  first.detail.changeDate(change("2026-11-03"));
  await back(h, first.detail); assertDate(h, "2026-10-31");
});

test("late date responses after a return cannot replace the roster or its navigation date", async () => {
  const h = await scenario(), response = h.deps.schedules.list;
  let resolve;
  h.deps.schedules.list = date => date === "2026-11-02" ? new Promise(yes => { resolve = yes; }) : response(date);
  const first = await enter(h);
  first.detail.changeDate(change("2026-11-02"));
  first.detail.onHide(); first.detail.onUnload();
  const returning = h.roster.onShow();
  const count = h.calls.filter(call => call[0] === "navigate").length;
  h.roster.openDay({ detail: { therapist: { id: "t" } } });
  assert.equal(h.calls.filter(call => call[0] === "navigate").length, count, "loading cannot open an old roster");
  h.roster.changeDate(change("2026-10-31")); await flush();
  first.nav.events.dateChange({ date: "2026-11-04" });
  resolve(await response("2026-11-02")); await returning;
  // The late result arrived after today's list. Check the displayed rows independently of the last network call.
  assert.equal(h.roster.data.selectedDate, "2026-10-31");
  assert.equal(h.roster.data.therapists[0].scheduleDate, "2026-10-31");
  h.roster.openDay({ detail: { therapist: h.roster.data.therapists[0] } });
  assert.match(navigation(h).url, /date=2026-10-31(?:&|$)/);
});

test("date taps during identity refresh cannot strand the booking page before it loads", async () => {
  const h = await scenario();
  let resume;
  h.app.refreshMe = () => new Promise(resolve => { resume = resolve; });
  const showing = h.roster.onShow();
  h.roster.changeDate(change("2026-11-02"));
  resume(); await showing;
  assert.equal(h.roster.data.visible, true);
  assert.equal(h.roster.data.loading, false);
  assertDate(h, "2026-10-31");
});
