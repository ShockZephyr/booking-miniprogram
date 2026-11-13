const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../../miniprogram");
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));

function frontend(role = "admin", options = {}) {
  const user = { id: "account-a", role: role === "admin" ? "admin" : "user", therapistId: role === "therapist" ? "therapist-a" : null };
  const app = options.app || { globalData: { user, token: "session-a" }, _loginSessionVersion: 1 };
  const calls = [], listCalls = [], modals = [], toasts = [], receipts = [];
  const request = options => new Promise((resolve, reject) => calls.push({ ...options, resolve, reject }));
  const loginReturn = { sessionKey: () => app.globalData.token };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "services/batchCheckIn.js"), "utf8"), {
    module, require: name => name.endsWith("/request") ? request : loginReturn, getApp: () => app
  });
  const service = options.service || module.exports;
  const listRequest = query => new Promise((resolve, reject) => listCalls.push({ query: clone(query), resolve, reject }));
  const deps = {
    "../../services/admin": { appointments: listRequest },
    "../../services/therapistPortal": { appointments: listRequest },
    "../../services/batchCheckIn": service,
    "../../services/appointmentInbox": { acknowledge: async (viewId, entries) => {
      receipts.push({ viewId, entries }); return { acknowledged: entries };
    } },
    "../../utils/loginReturn": loginReturn,
    "../../utils/filterTime": require("../../miniprogram/utils/filterTime"),
    "../../utils/checkIn": { canCheckIn: () => true, startWatching() {}, stopWatching() {} },
    "../../utils/date": { today: () => "2026-11-13", isExpired: () => true }
  };
  let page, reloads = 0;
  vm.runInNewContext(fs.readFileSync(path.join(root, "pages/my-appointments/index.js"), "utf8"), {
    Page: value => { page = value; }, require: name => deps[name] || {}, getApp: () => app,
    wx: { showModal: options => modals.push(options), showToast: options => toasts.push(options.title), setNavigationBarTitle() {} }
  });
  page.data = clone(page.data);
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback(); };
  page.loadFilterOptions = () => {};
  const realLoad = page.load;
  page.load = options.realList ? (...args) => { reloads++; return realLoad.apply(page, args); }
    : () => { reloads++; page.data.loading = false; };
  page.onLoad({}); page.showForUser(app.globalData.user);
  if (!options.realList) Object.assign(page.data, { loading: false, appointments: [{ id: "only-first-page", status: "no_show" }], hasMore: true });
  const event = () => ({ currentTarget: { dataset: { filterVersion: page.data.filterVersion, sortVersion: page.data.sortVersion } } });
  return { page, app, calls, listCalls, modals, toasts, receipts, service, event, reloads: () => reloads };
}

for (const role of ["admin", "therapist"]) {
  test(`${role}: all-page count, filters and role API are used; success retains filters/sort`, async () => {
    const h = frontend(role);
    Object.assign(h.page.data, { filterServiceItemIds: ["project-a", "__inactive_projects__"],
      filterTherapistIds: ["therapist-b"], filterAllDates: false, filterFromDate: "2026-11-01", filterToDate: "2026-11-30",
      filterStartTime: "08:00", filterEndTime: "18:00", sort: "created_asc" });
    const work = h.page.checkInAll(h.event());
    assert.equal(h.page.data.bulkSigning, true);
    assert.equal(h.calls[0].url, `/api/${role}/appointments/check-in-preview`);
    const filters = clone(h.calls[0].data.filters);
    assert.deepEqual(filters.serviceItemIds, ["project-a"]);
    assert.equal(filters.includeInactiveServiceItems, "1");
    assert.deepEqual(filters.therapistIds, role === "admin" ? ["therapist-b"] : []);
    assert.equal(filters.startTime, "08:00"); assert.equal(filters.fromDate, "2026-11-01");
    assert.equal(filters.page, undefined);
    h.calls[0].resolve({ count: 25, confirmationVersion: "version-a" }); await flush();
    assert.match(h.modals[0].content, /25/); assert.match(h.modals[0].content, /其他分页/);
    h.modals[0].success({ confirm: true }); await flush();
    assert.equal(h.calls[1].url, `/api/${role}/appointments/check-in-batch`);
    assert.deepEqual(clone(h.calls[1].data.filters), filters);
    assert.equal(h.calls[1].data.confirmationVersion, "version-a");
    h.calls[1].resolve({ checkedIn: 25 }); await work;
    assert.equal(h.toasts.at(-1), "已签到 25 条"); assert.equal(h.page.data.bulkSigning, false);
    assert.equal(h.page.data.sort, "created_asc"); assert.deepEqual(h.page.data.filterServiceItemIds, ["project-a", "__inactive_projects__"]);
    assert.equal(h.reloads(), 2);
  });
}

test("ordinary users, non-pending tabs and stale control events cannot start a bulk action", async () => {
  for (const setup of [h => { h.page.data.active = "all"; }, h => { h.page.data.identityReady = false; },
    h => { h.page._confirmedAction = {}; }, h => { h.page.data.signing = true; }]) {
    const h = frontend(); setup(h); await h.page.checkInAll(h.event()); assert.equal(h.calls.length, 0);
  }
  const user = frontend("user"); await user.page.checkInAll(user.event()); assert.equal(user.calls.length, 0);
  const h = frontend(), old = h.event(); h.page.data.filterVersion++;
  await h.page.checkInAll(old); assert.equal(h.calls.length, 0);
});

test("double clicks, cancel and empty eligible set never produce extra submissions", async () => {
  const h = frontend();
  const work = h.page.checkInAll(h.event());
  await h.page.checkInAll(h.event()); assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ count: 2, confirmationVersion: "a" }); await flush();
  await h.page.checkInAll(h.event()); assert.equal(h.modals.length, 1);
  h.modals[0].success({ confirm: false }); await work;
  assert.equal(h.calls.length, 1); assert.equal(h.page.data.bulkSigning, false);
  const empty = h.page.checkInAll(h.event()); h.calls[1].resolve({ count: 0, confirmationVersion: "b" }); await empty;
  assert.equal(h.modals.length, 1); assert.equal(h.toasts.at(-1), "暂无可签到预约");
});

for (const phase of ["preview", "confirm"]) test(`stale ${phase}: hide/return, unload, tab/filter change and account replacement do not submit`, async () => {
  for (const change of [h => { h.page.onHide(); }, h => { h.page.onHide(); h.page.onShow(); },
    h => h.page.onUnload(), h => h.page.switchTab({ currentTarget: { dataset: { key: "checked_in" } } }),
    h => { h.page.data.filterStartTime = "10:00"; }, h => { h.app.globalData.token = "session-b"; },
    h => { h.app._loginSessionVersion++; }]) {
    const h = frontend(), work = h.page.checkInAll(h.event());
    if (phase === "confirm") { h.calls[0].resolve({ count: 1, confirmationVersion: "a" }); await flush(); }
    change(h);
    if (phase === "preview") h.calls[0].resolve({ count: 1, confirmationVersion: "a" });
    else h.modals[0].success({ confirm: true });
    await work;
    assert.equal(h.calls.length, 1); assert.equal(h.toasts.length, 0);
  }
});

test("confirmed write can finish after leaving but cannot toast/reload another account or clear its new busy state", async () => {
  const h = frontend(), old = h.page.checkInAll(h.event());
  h.calls[0].resolve({ count: 1, confirmationVersion: "a" }); await flush();
  h.modals[0].success({ confirm: true }); await flush();
  h.page.onHide(); h.app.globalData.token = "session-b"; h.page.onShow(); h.page.data.loading = false;
  const fresh = h.page.checkInAll(h.event());
  assert.equal(h.calls.length, 3);
  h.calls[1].resolve({ checkedIn: 1 }); await old;
  assert.equal(h.toasts.length, 0); assert.equal(h.page.data.bulkSigning, true);
  h.calls[2].resolve({ count: 0 }); await fresh;
  assert.equal(h.page.data.bulkSigning, false);
});

test("changed confirmation, network failure and modal failure release busy state without replaying writes", async () => {
  for (const code of ["BATCH_CHECK_IN_CHANGED", "NETWORK_ERROR"]) {
    const h = frontend(), work = h.page.checkInAll(h.event());
    h.calls[0].resolve({ count: 1, confirmationVersion: "a" }); await flush();
    h.modals[0].success({ confirm: true }); await flush();
    h.calls[1].reject({ code, message: "可签到预约已变化，请重新确认" }); await work;
    assert.equal(h.calls.length, 2); assert.equal(h.page.data.bulkSigning, false);
    assert.equal(h.reloads(), 2);
    if (code === "NETWORK_ERROR") assert.match(h.toasts.at(-1), /结果未确认/);
  }
  const h = frontend(), work = h.page.checkInAll(h.event());
  h.calls[0].resolve({ count: 1, confirmationVersion: "a" }); await flush();
  h.modals[0].fail({}); await work;
  assert.equal(h.calls.length, 1); assert.equal(h.page.data.bulkSigning, false);
});

test("frontend service coalesces identical pending writes only within their own session", async () => {
  const h = frontend();
  const a = h.service.submit(true, {}, "v"), duplicate = h.service.submit(true, {}, "v");
  assert.equal(a, duplicate); assert.equal(h.calls.length, 1);
  h.app._loginSessionVersion++;
  const b = h.service.submit(true, {}, "v"); assert.equal(h.calls.length, 2);
  h.calls[0].resolve({ checkedIn: 1 }); h.calls[1].resolve({ checkedIn: 0 }); await Promise.all([a, b]);
});

test("unread receipts wait while the batch confirmation covers the page and resume after cancel", async () => {
  for (const queuedBeforeClick of [false, true]) {
    const h = frontend();
    h.page.isReadConfirmationCurrent = () => true;
    h.page.data.appointments = [{ id: "unread", unreadKind: "created", unreadVersion: 1 }];
    h.page._readPending = [{ viewId: "view", entries: [{ id: "unread", version: 1 }] }];
    if (queuedBeforeClick) h.page.flushReadConfirmations();
    const work = h.page.checkInAll(h.event());
    h.page.flushReadConfirmations(); await flush();
    assert.equal(h.receipts.length, 0);
    h.calls[0].resolve({ count: 1, confirmationVersion: "a" }); await flush();
    assert.equal(h.receipts.length, 0);
    h.modals[0].success({ confirm: false }); await work; await flush();
    assert.equal(h.receipts.length, 1);
    assert.deepEqual(clone(h.receipts[0].entries), [{ id: "unread", version: 1 }]);
  }
});

const pendingAppointment = { id: "only-first-page", status: "no_show", date: "2026-11-11",
  startTime: "09:00", endTime: "10:30", note: "" };
const listResult = appointments => ({ appointments: clone(appointments), pagination: { page: 1, hasMore: false } });

async function loadedList(role, options = {}) {
  const h = frontend(role, { ...options, realList: true });
  h.listCalls[0].resolve(listResult([pendingAppointment])); await flush();
  return h;
}

async function confirmedBatch(h) {
  const work = h.page.checkInAll(h.event());
  h.calls[0].resolve({ count: 1, confirmationVersion: "version-a" }); await flush();
  h.modals[0].success({ confirm: true }); await flush();
  assert.equal(h.calls.length, 2);
  return { work };
}

for (const role of ["admin", "therapist"]) {
  for (const view of ["sort", "filter", "tab", "return"]) {
    test(`${role}: batch completion refreshes the current ${view} after a pre-commit list read`, async () => {
      const h = await loadedList(role);
      const { work } = await confirmedBatch(h);
      if (view === "sort") {
        h.page.toggleSortMenu(h.event());
        h.page.selectSort({ currentTarget: { dataset: { sortVersion: h.page.data.sortVersion, sort: "created_asc" } } });
      } else if (view === "filter") {
        h.page.openFilterDrawer(h.event());
        h.page.setData({ draftStartTime: "08:00", draftEndTime: "12:00" });
        h.page.confirmFilters(h.event());
      } else if (view === "tab") {
        h.page.switchTab({ currentTarget: { dataset: { key: "checked_in" } } });
      } else {
        h.page.onHide(); h.page.onShow();
      }
      assert.equal(h.listCalls.length, 2);
      const currentQuery = clone(h.listCalls[1].query);
      h.listCalls[1].resolve(listResult(view === "tab" ? [] : [pendingAppointment])); await flush();
      assert.equal(h.page.data.bulkSigning, true);
      await h.page.checkInAll(h.event());
      assert.equal(h.calls.length, 2, "a confirmed in-flight write still prevents a second batch");

      h.calls[1].resolve({ checkedIn: 1 }); await work;
      assert.equal(h.listCalls.length, 3, "completion must query after the write, regardless of view version");
      assert.deepEqual(h.listCalls[2].query, currentQuery, "retain the currently chosen status, sort and filters");
      h.listCalls[2].resolve(listResult(view === "tab" ? [{ ...pendingAppointment, status: "checked_in" }] : [])); await flush();
      assert.equal(h.page.data.appointments.some(item => item.status === "no_show"), false);
      assert.equal(h.page.data.bulkSigning, false);
      assert.equal(h.toasts.at(-1), "已签到 1 条");
      h.page.onUnload();
    });
  }

  test(`${role}: a late pre-commit read cannot overwrite the post-write refresh or an open filter draft`, async () => {
    const h = await loadedList(role), { work } = await confirmedBatch(h);
    h.page.switchTab({ currentTarget: { dataset: { key: "pending" } } });
    h.page.openFilterDrawer(h.event());
    h.page.setData({ draftStartTime: "10:00", draftEndTime: "14:00" });
    h.calls[1].resolve({ checkedIn: 1 }); await work;
    h.listCalls[2].resolve(listResult([])); await flush();
    h.listCalls[1].resolve(listResult([pendingAppointment])); await flush();
    assert.equal(h.page.data.appointments.length, 0);
    assert.equal(h.page.data.filterDrawerVisible, true);
    assert.equal(h.page.data.draftStartTime, "10:00");
    assert.equal(h.page.data.draftEndTime, "14:00");
    assert.equal(h.page.data.filterStartTime, "00:00", "unsaved draft must not become the query");
    h.page.onUnload();
  });

  test(`${role}: completion while hidden or waiting for identity refresh waits for the normal return load`, async () => {
    for (const identityPending of [false, true]) {
      const h = await loadedList(role), { work } = await confirmedBatch(h);
      h.page.onHide();
      let resolveIdentity;
      if (identityPending) {
        h.app.refreshMe = () => new Promise(resolve => { resolveIdentity = resolve; });
        h.page.onShow();
        assert.equal(h.page.data.identityReady, false);
      }
      h.calls[1].resolve({ checkedIn: 1 }); await work;
      assert.equal(h.listCalls.length, 1);
      assert.equal(h.toasts.length, 0);
      if (identityPending) { resolveIdentity(h.app.globalData.user); await flush(); }
      else h.page.onShow();
      assert.equal(h.listCalls.length, 2);
      h.listCalls[1].resolve(listResult([])); await flush();
      assert.equal(h.page.data.appointments.length, 0);
      assert.equal(h.page.data.bulkSigning, false);
      h.page.onUnload();
    }
  });

  test(`${role}: changed-view errors refresh for verification without replaying a write`, async () => {
    for (const code of ["NETWORK_ERROR", "BATCH_CHECK_IN_CHANGED"]) {
      const h = await loadedList(role), { work } = await confirmedBatch(h);
      h.page.onHide(); h.page.onShow();
      h.listCalls[1].resolve(listResult([pendingAppointment])); await flush();
      h.calls[1].reject({ code, message: "可签到预约已变化，请重新确认" }); await work;
      assert.equal(h.calls.length, 2, "an unknown outcome must not be resubmitted automatically");
      assert.equal(h.listCalls.length, 3);
      h.listCalls[2].resolve(listResult([])); await flush();
      assert.equal(h.page.data.bulkSigning, false);
      if (code === "NETWORK_ERROR") assert.match(h.toasts.at(-1), /结果未确认/);
      else assert.match(h.toasts.at(-1), /重新确认/);
      h.page.onUnload();
    }
  });

  test(`${role}: a recreated list waits for the original page's pending write and refreshes its own query`, async () => {
    for (const failure of [false, true]) {
      const old = await loadedList(role), { work } = await confirmedBatch(old);
      old.page.onUnload();
      const fresh = await loadedList(role, { service: old.service, app: old.app });
      assert.equal(fresh.page.data.bulkSigning, true);
      await fresh.page.checkInAll(fresh.event());
      assert.equal(old.calls.length, 2);
      if (failure) old.calls[1].reject({ code: "NETWORK_ERROR" });
      else old.calls[1].resolve({ checkedIn: 1 });
      await work; await flush();
      assert.equal(old.listCalls.length, 1, "the unloaded page never reloads");
      assert.equal(old.toasts.length, 0);
      assert.equal(fresh.listCalls.length, 2);
      fresh.listCalls[1].resolve(listResult([])); await flush();
      assert.equal(fresh.page.data.appointments.length, 0);
      assert.equal(fresh.page.data.bulkSigning, false);
      assert.equal(old.calls.length, 2);
      fresh.page.onUnload();
    }
  });
}

test("pending-list completion cannot affect another account, new login session or new busy action", async () => {
  for (const replaceSession of [h => { h.app.globalData.token = "session-b"; }, h => { h.app._loginSessionVersion++; }]) {
    const old = await loadedList("admin"), { work } = await confirmedBatch(old);
    old.page.onUnload();
    const fresh = await loadedList("admin", { service: old.service, app: old.app });
    fresh.page.onHide(); replaceSession(fresh); fresh.page.onShow();
    fresh.listCalls[1].resolve(listResult([pendingAppointment])); await flush();
    assert.equal(fresh.page.data.bulkSigning, false);
    const current = fresh.page.checkInAll(fresh.event());
    assert.equal(old.calls.length, 3);
    old.calls[1].resolve({ checkedIn: 1 }); await work; await flush();
    assert.equal(fresh.listCalls.length, 2);
    assert.equal(fresh.toasts.length, 0);
    assert.equal(fresh.page.data.bulkSigning, true);
    old.calls[2].resolve({ count: 0 }); await current;
    fresh.page.onUnload();
  }
});

test("toolbar limits bulk entry to staff pending, preserves non-overlapping flex flow and disables individual actions", () => {
  const markup = fs.readFileSync(path.join(root, "pages/my-appointments/index.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "pages/my-appointments/index.wxss"), "utf8");
  assert.match(markup, /wx:if="\{\{\(isAdminMode \|\| isTherapistMode\) && active === 'pending'\}\}"/);
  assert.ok(markup.indexOf('class="batch-check-in"') < markup.indexOf('class="sort-trigger'));
  assert.match(markup, /busy="\{\{signing \|\| cancelling \|\| bulkSigning\}\}"/);
  const rule = styles.match(/\.filter-toolbar \.batch-check-in \{([^}]+)\}/)[1];
  assert.match(rule, /width:auto !important/); assert.match(rule, /margin:0 !important/);
  assert.match(rule, /min-height:44px/); assert.doesNotMatch(rule, /position:|transform:|margin:-/);
  const visual = styles.match(/\.batch-check-in-visual \{([^}]+)\}/)[1];
  assert.match(visual, /padding:0/); assert.match(visual, /background:transparent/);
  assert.match(visual, /margin-left:8rpx/); assert.match(visual, /gap:8rpx/);
  assert.doesNotMatch(visual, /border|border-radius/);
  assert.match(markup, /class="batch-check-in-icon" src="\/assets\/icons\/appointment-action-checkin\.png"/);
  assert.match(markup, /aria-busy="\{\{bulkSigning\}\}"/);
});
