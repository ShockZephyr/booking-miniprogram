const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const filterTime = require("../../miniprogram/utils/filterTime");
const { setup, flush, plain } = require("./support/scheduleUI");
const range = (startTime, endTime) => ({ startTime, endTime });

test("filter menus offer half-hour boundaries plus an end-only all-day option; malformed picker values are ignored", () => {
  assert.equal(filterTime.startLabels.length, 48);
  assert.equal(filterTime.endLabels.length, 49);
  for (let index = 0; index < 48; index++) {
    const expected = `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`;
    assert.equal(filterTime.startLabels[index], expected);
    assert.equal(filterTime.timeFromIndex(String(index), "startTime"), expected);
    assert.equal(filterTime.timeFromIndex(index, "endTime"), expected);
  }
  assert.equal(filterTime.endLabels[48], "全天结束（23:59）");
  assert.equal(filterTime.timeFromIndex("48", "endTime"), "23:59");
  assert.equal(filterTime.timeFromIndex(48, "startTime"), null);
  for (const value of [null, undefined, {}, [], [9, 0], true, "", "9:00", "1.5", -1, 49]) {
    assert.equal(filterTime.timeFromIndex(value, "endTime"), null);
  }
});

test("manual range linkage preserves valid bounds, rounds outward and never wraps or silently moves the chosen endpoint", () => {
  const edit = filterTime.editRange;
  assert.deepEqual(edit(range("09:00", "18:00"), "startTime", "10:00", 90), range("10:00", "18:00"));
  assert.deepEqual(edit(range("09:00", "18:00"), "endTime", "17:00", 90), range("09:00", "17:00"));
  for (const minimum of [90, 100, 105]) {
    const expectedEnd = minimum === 90 ? "11:00" : "11:30";
    const expectedStart = minimum === 90 ? "08:30" : "08:00";
    for (const oldEnd of ["09:00", "09:30", "10:00"]) {
      assert.deepEqual(edit(range("08:00", oldEnd), "startTime", "09:30", minimum), range("09:30", expectedEnd));
    }
    for (const oldStart of ["09:30", "10:00", "11:00"]) {
      assert.deepEqual(edit(range(oldStart, "12:00"), "endTime", "10:00", minimum), range(expectedStart, "10:00"));
    }
  }
  assert.deepEqual(edit(range("22:00", "23:00"), "startTime", "23:00", 45), range("23:00", "23:59"));
  assert.equal(edit(range("22:00", "23:00"), "startTime", "23:00", 60), null);
  assert.equal(edit(range("09:00", "10:30"), "endTime", "01:00", 90), null);
  assert.deepEqual(edit(range("09:00", "10:30"), "endTime", "01:30", 90), range("00:00", "01:30"));
  assert.deepEqual(edit(range("09:00", "10:30"), "endTime", "23:59", 90), range("09:00", "23:59"));
  // History filters do not inherit the shortest duration from scheduling rules.
  assert.deepEqual(edit(range("09:00", "10:00"), "startTime", "10:00", null), range("10:00", "10:30"));
  assert.deepEqual(edit(range("09:00", "10:00"), "endTime", "09:00", null), range("08:30", "09:00"));
  assert.deepEqual(edit(range("09:00", "10:00"), "startTime", "23:30", null), range("23:30", "23:59"));
  assert.equal(edit(range("09:00", "10:00"), "endTime", "00:00", null), null);
});

async function list(role = "admin") {
  const h = setup();
  h.app.globalData.user = { id: "synthetic", role: role === "admin" ? "admin" : "user",
    ...(role === "therapist" ? { therapistId: "t" } : {}) };
  const queries = [];
  const query = async (...args) => { queries.push(args); return { appointments: [], pagination: {} }; };
  Object.assign(h.deps.appointment, { my: query, filterOptions: async () => ({
    serviceItems: [{ id: "p", name: "项目" }], therapists: [{ id: "t", name: "芳疗师" }], supportsInactiveFilters: true
  }) });
  h.deps.admin = { appointments: query };
  h.deps.therapistPortal = { appointments: query };
  const p = h.page("pages/my-appointments"); p.onLoad({ status: "all" }); p.onShow(); await flush();
  p.openFilterDrawer(event(p));
  return { h, p, queries };
}
const event = (p, value, field) => ({ currentTarget: { dataset: { filterVersion: p.data.filterVersion, field } }, detail: { value } });
const pick = (p, field, time) => p[field === "startTime" ? "inputFilterStart" : "inputFilterEnd"](
  event(p, String(filterTime.indexFromTime(time, field))));

test("shared appointment drawer preserves confirmation, cancellation, all-time and pagination query semantics in every role", async () => {
  for (const role of ["admin", "therapist", "user"]) {
    const { p, queries } = await list(role);
    pick(p, "startTime", "09:00");
    assert.equal(p.data.draftEndTime, "23:59");
    pick(p, "endTime", "09:30");
    assert.equal(p.data.draftStartTime, "09:00", "a half-hour historical range is allowed");
    p.confirmFilters(event(p)); await flush();
    const query = queries.at(-1).at(-1);
    assert.equal(query.startTime, "09:00"); assert.equal(query.endTime, "09:30");
    assert.equal(query.status, "all"); assert.equal(p.data.activeFilterCount, 1);
    p.openFilterDrawer(event(p)); pick(p, "endTime", "08:30");
    assert.equal(p.data.draftStartTime, "08:00");
    p.closeFilterDrawer(event(p)); p.openFilterDrawer(event(p));
    assert.equal(p.data.draftStartTime, "09:00"); assert.equal(p.data.draftEndTime, "09:30");
    pick(p, "endTime", "00:00");
    assert.equal(p.data.draftStartTime, "09:00"); assert.equal(p.data.draftEndTime, "09:30");
    assert.equal(p.data.draftStartPickerValue, 18); assert.equal(p.data.draftEndPickerValue, 19);
    p.useAllTimesFilter(event(p)); p.confirmFilters(event(p)); await flush();
    assert.equal(p.data.activeFilterCount, 0);
    const all = queries.at(-1).at(-1);
    assert.equal(all.startTime, "00:00"); assert.equal(all.endTime, "23:59");
  }
});

test("delayed history picker callbacks cannot overwrite a reopened, hidden, reset or different-account draft", async () => {
  const { h, p } = await list();
  const stale = event(p, 20);
  p.closeFilterDrawer(event(p)); p.openFilterDrawer(event(p));
  p.inputFilterStart(stale); assert.equal(p.data.draftStartTime, "00:00");
  const beforeHide = event(p, 20);
  p.onHide(); p.inputFilterStart(beforeHide); assert.equal(p.data.draftStartTime, "00:00");
  p.onShow(); await flush(); p.inputFilterStart(beforeHide); assert.equal(p.data.draftStartTime, "00:00");
  pick(p, "startTime", "10:00"); assert.equal(p.data.draftStartTime, "10:00");
  const beforeReset = event(p, 25);
  p.resetFilterDraft(event(p)); p.inputFilterEnd(beforeReset); assert.equal(p.data.draftEndTime, "23:59");
  const beforeAccount = event(p, 20);
  h.app.globalData.user = { id: "another", role: "admin" }; h.app._loginSessionVersion++;
  const draft = plain(p.data);
  p.inputFilterStart(beforeAccount); assert.deepEqual(plain(p.data), draft);
  p.onShow(); await flush(); p.openFilterDrawer(event(p)); p.inputFilterStart(beforeAccount);
  assert.equal(p.data.draftStartTime, "00:00");
  pick(p, "startTime", "11:00"); assert.equal(p.data.draftStartTime, "11:00");
  const beforeUnload = event(p, 22); p.onUnload(); p.inputFilterEnd(beforeUnload);
  assert.equal(p.data.draftEndTime, "23:59");
});

test("both page templates bind separate start/end menus and carry picker event versions", () => {
  for (const page of ["booking", "my-appointments"]) {
    const template = fs.readFileSync(path.join(__dirname, `../../miniprogram/pages/${page}/index.wxml`), "utf8");
    for (const [side, label] of [["start", "开始"], ["end", "结束"]]) {
      assert.match(template, new RegExp(`<picker mode="selector" range="{{${side}TimeRange}}"[^>]*data-filter-(?:time-)?version=[^>]*aria-label="筛选${label}时间"`));
    }
  }
});

// Capture complete events before the lifecycle changes, as a delayed native control would.
const filterActions = [
  ["openFilterDrawer"], ["closeFilterDrawer"], ["selectAllProjects"], ["selectAllTherapists"],
  ["selectFilterProjects", ["p"]], ["selectFilterTherapists", ["t"]],
  ["inputFilterDate", "2026-11-01", "draftFromDate"],
  ["inputFilterDate", "2026-11-15", "draftToDate"],
  ["useDateFilter"], ["useAllDatesFilter"], ["inputFilterStart", 18], ["inputFilterEnd", 25],
  ["useAllTimesFilter"], ["resetFilterDraft"], ["confirmFilters"], ["retryFilterOptions"]
];

test("all history filter controls reject delayed events without changing a new draft or issuing requests", async t => {
  const transitions = {
    reopened: async ({ p }) => { p.closeFilterDrawer(event(p)); p.openFilterDrawer(event(p)); },
    hidden: async ({ p }) => { p.onHide(); },
    returned: async ({ p }) => { p.onHide(); p.onShow(); await flush(); },
    reset: async ({ p }) => { p.resetFilterDraft(event(p)); },
    allTimes: async ({ p }) => { p.useAllTimesFilter(event(p)); },
    allProjects: async ({ p }) => { p.selectAllProjects(event(p)); },
    allTherapists: async ({ p }) => { p.selectAllTherapists(event(p)); },
    datesEnabled: async ({ p }) => { p.useDateFilter(event(p)); },
    allDates: async ({ p }) => { p.useAllDatesFilter(event(p)); },
    accountBeforeShow: async ({ h }) => { h.app.globalData.user = { id: "other", role: "admin" }; },
    accountAfterShow: async ({ h, p }) => {
      h.app.globalData.user = { id: "other", role: "admin" }; h.app._loginSessionVersion++;
      p.onShow(); await flush(); p.openFilterDrawer(event(p));
      pick(p, "startTime", "11:00"); pick(p, "endTime", "13:00");
    },
    unloaded: async ({ p }) => { p.onUnload(); }
  };
  for (const [name, transition] of Object.entries(transitions)) {
    await t.test(name, async () => {
      const state = await list(), { h, p, queries } = state;
      pick(p, "startTime", "10:00"); pick(p, "endTime", "14:00");
      const events = filterActions.map(([handler, value, field]) => [handler, event(p, value, field)]);
      await transition(state);
      // A stale retry must not silently fetch options either.
      p.setData({ serviceItemsError: "项目加载失败" });
      let optionRequests = 0;
      h.deps.appointment.filterOptions = async () => { optionRequests++; return { serviceItems: [], therapists: [] }; };
      const expected = plain(p.data), queryCount = queries.length, callCount = h.calls.length;
      for (const [handler, oldEvent] of events) {
        p[handler](oldEvent);
        assert.deepEqual(plain(p.data), expected, handler);
      }
      await flush();
      assert.equal(queries.length, queryCount, "no stale confirmation may start a list request");
      assert.equal(optionRequests, 0);
      assert.equal(h.calls.length, callCount, "no stale navigation or toast");
    });
  }
});

test("current option/date/reset controls work for every role; only one confirmation applies the draft", async () => {
  for (const role of ["admin", "therapist", "user"]) {
    const { p, queries } = await list(role);
    const originalQueries = queries.length;
    p.selectFilterProjects(event(p, ["p"]));
    p.useDateFilter(event(p));
    p.inputFilterDate(event(p, "2026-11-01", "draftFromDate"));
    p.inputFilterDate(event(p, "2026-11-07", "draftToDate"));
    if (role !== "therapist") p.selectFilterTherapists(event(p, ["t"]));
    pick(p, "startTime", "09:00"); pick(p, "endTime", "09:30");
    assert.equal(queries.length, originalQueries, "draft edits do not query the list");
    const confirm = event(p);
    p.confirmFilters(confirm); p.confirmFilters(confirm); await flush();
    assert.equal(queries.length, originalQueries + 1);
    const query = queries.at(-1).at(-1);
    assert.deepEqual(plain(query.serviceItemIds), ["p"]);
    assert.deepEqual(plain(query.therapistIds), role === "therapist" ? [] : ["t"]);
    assert.equal(query.fromDate, "2026-11-01"); assert.equal(query.toDate, "2026-11-07");
    assert.equal(query.startTime, "09:00"); assert.equal(query.endTime, "09:30");
    p.openFilterDrawer(event(p)); p.resetFilterDraft(event(p));
    assert.equal(p.data.filterStartTime, "09:00", "reset is still only a draft change");
    p.closeFilterDrawer(event(p)); p.openFilterDrawer(event(p));
    assert.equal(p.data.draftStartTime, "09:00");
    assert.deepEqual(plain(p.data.draftFilterServiceItemIds), ["p"]);
    p.selectAllProjects(event(p)); p.selectAllTherapists(event(p)); p.useAllDatesFilter(event(p)); p.useAllTimesFilter(event(p));
    p.confirmFilters(event(p)); await flush();
    assert.equal(p.data.activeFilterCount, 0);
    assert.deepEqual(plain(queries.at(-1).at(-1).serviceItemIds), []);
    assert.deepEqual(plain(queries.at(-1).at(-1).therapistIds), []);
  }
});

test("same-session return preserves the draft; renewed login closes the old drawer and preserves confirmed filters", async () => {
  const { h, p } = await list();
  pick(p, "startTime", "09:00"); p.confirmFilters(event(p)); await flush();
  p.openFilterDrawer(event(p)); pick(p, "startTime", "11:00");
  p.selectFilterProjects(event(p, ["p"]));
  p.onHide(); p.onShow(); await flush();
  assert.equal(p.data.filterDrawerVisible, true);
  assert.equal(p.data.draftStartTime, "11:00");
  assert.deepEqual(plain(p.data.draftFilterServiceItemIds), ["p"]);
  assert.equal(p.data.serviceItems.find(item => item.id === "p").filterChecked, true);
  const oldConfirm = event(p);
  h.app.globalData.token = "another-synthetic-session"; h.app._loginSessionVersion++;
  p.onShow(); await flush();
  assert.equal(p.data.filterDrawerVisible, false);
  p.openFilterDrawer(event(p)); p.confirmFilters(oldConfirm);
  assert.equal(p.data.filterDrawerVisible, true);
  assert.equal(p.data.draftStartTime, "09:00", "unconfirmed changes from the old login are discarded");
  pick(p, "startTime", "12:00"); p.confirmFilters(event(p)); await flush();
  assert.equal(p.data.filterStartTime, "12:00", "new session remains usable");
});

test("stale header taps cannot reopen the drawer and malformed events cannot edit unrelated state", async () => {
  const { p } = await list();
  p.closeFilterDrawer(event(p)); const oldOpen = event(p);
  p.onHide(); p.onShow(); await flush();
  p.openFilterDrawer(oldOpen); assert.equal(p.data.filterDrawerVisible, false);
  p.openFilterDrawer(event(p)); assert.equal(p.data.filterDrawerVisible, true);
  const expected = plain(p.data);
  for (const [handler, value, field] of filterActions) {
    p[handler]({ currentTarget: { dataset: { field } }, detail: { value } });
  }
  p.inputFilterDate(event(p, "2026-11-01", "isAdminMode"));
  p.inputFilterDate(event(p, "not-a-date", "draftFromDate"));
  assert.deepEqual(plain(p.data), expected);
});

test("filter option retries preserve current drafts and discard results after account changes or unload", async t => {
  for (const transition of ["stay", "account", "unload"]) {
    await t.test(transition, async () => {
      const { h, p } = await list();
      let resolve, calls = 0;
      h.deps.appointment.filterOptions = () => { calls++; return new Promise(done => { resolve = done; }); };
      p.setData({ serviceItemsError: "项目加载失败" });
      const retry = event(p); p.retryFilterOptions(retry); p.retryFilterOptions(retry);
      assert.equal(calls, 1, "repeated clicks do not start parallel retries");
      pick(p, "startTime", "11:00"); p.selectFilterProjects(event(p, ["p"]));
      if (transition === "account") h.app.globalData.user = { id: "next", role: "user" };
      if (transition === "unload") p.onUnload();
      const before = plain(p.data);
      resolve({ serviceItems: [{ id: "p", name: "重新加载" }], therapists: [{ id: "t", name: "芳疗师" }], supportsInactiveFilters: true });
      await flush();
      if (transition !== "stay") assert.deepEqual(plain(p.data), before);
      else {
        assert.equal(p.data.serviceItemsError, "");
        assert.equal(p.data.serviceItemsLoading, false);
        assert.equal(p.data.draftStartTime, "11:00");
        assert.deepEqual(plain(p.data.draftFilterServiceItemIds), ["p"]);
        assert.equal(p.data.serviceItems.find(item => item.id === "p").filterChecked, true);
      }
    });
  }
});

test("every appointment filter control carries the drawer version in WXML", () => {
  const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/my-appointments/index.wxml"), "utf8");
  for (const handler of new Set(filterActions.map(([name]) => name))) {
    const controls = template.match(new RegExp(`<[^>]*bind(?:tap|change)="${handler}"[^>]*>`, "g")) || [];
    assert.ok(controls.length, handler);
    for (const control of controls) assert.match(control, /data-filter-version="{{filterVersion}}"/, handler);
  }
});
