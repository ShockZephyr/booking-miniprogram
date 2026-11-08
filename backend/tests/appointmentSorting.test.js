process.env.NODE_TEST_CONTEXT = "1";
process.env.DATABASE_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const db = require("../src/config/db");
const repository = require("../src/repositories/appointmentRepository");
const { parseAppointmentFilters } = require("../src/utils/appointmentFilters");
const { appointmentOrder } = require("../src/utils/appointmentSort");
const { encodeCursor } = require("../src/utils/cursor");

const SORTS = ["service_asc", "service_desc", "created_asc", "created_desc"];
const position = ["2026-11-01", "09:00:00", "2026-10-31 12:00:00.123456+00", "11111111-1111-4111-8111-111111111111"];

test("only four explicit sort modes are accepted, with the original order as default", () => {
  assert.equal(parseAppointmentFilters({}).sort, "service_desc");
  for (const sort of SORTS) assert.equal(parseAppointmentFilters({ sort }).sort, sort);
  for (const sort of ["", null, [], {}, ["service_asc"], "date", "created_at DESC; SELECT 1"]) {
    assert.throws(() => parseAppointmentFilters({ sort }), { code: "INVALID_SORT", status: 400 });
  }
});

test("sort-bound cursors keep microseconds and reject another order, including legacy cursors", () => {
  for (const sort of SORTS) {
    const cursor = appointmentOrder(sort).cursor(position);
    assert.deepEqual(appointmentOrder(sort, cursor).position, position);
    for (const other of SORTS.filter(value => value !== sort)) {
      assert.throws(() => appointmentOrder(other, cursor), { code: "INVALID_CURSOR", status: 400 });
    }
  }
  const legacy = encodeCursor("appointments", position);
  assert.deepEqual(appointmentOrder(undefined, legacy).position, position);
});

test("every list uses the same safe SQL order and matching cursor comparison before LIMIT", async () => {
  const original = db.query;
  try {
    for (const sort of SORTS) {
      for (const read of [q => repository.listByUser("customer", q), q => repository.listForAdmin(q), q => repository.listForTherapist("staff", q)]) {
        const calls = [];
        db.query = async (sql, values) => {
          calls.push({ sql, values: values.slice() });
          return { rows: sql.includes("COUNT(*)") ? [{ count: 0 }] : [] };
        };
        await read({ sort, cursor: appointmentOrder(sort).cursor(position), page: 2 });
        const last = calls.at(-1);
        const direction = sort.endsWith("asc") ? "ASC" : "DESC";
        const columns = sort.startsWith("service") ? ["a.date", "a.start_time", "a.created_at", "a.id"] : ["a.created_at", "a.id"];
        assert.ok(last.sql.includes(`ORDER BY ${columns.map(c => `${c} ${direction}`).join(", ")}`));
        assert.ok(last.sql.includes(`(${columns.join(", ")}) ${direction === "ASC" ? ">" : "<"}`));
        assert.equal(last.values.at(-1), 0, "cursor pages must not also skip an offset");
        assert.equal(last.values.at(-2), 21);
        const expected = sort.startsWith("service") ? position : position.slice(2);
        assert.deepEqual(last.values.slice(-2 - expected.length, -2), expected);
      }
    }
  } finally { db.query = original; }
});

const root = path.join(__dirname, "../../miniprogram");
const flush = () => new Promise(resolve => setImmediate(resolve));
function frontend(role = "user") {
  const user = { id: "account-a", role: role === "admin" ? "admin" : "user", therapistId: role === "therapist" ? "staff-a" : null };
  const app = { globalData: { user, token: "session-a" }, _loginSessionVersion: 1 };
  const requests = [];
  const scrolls = [];
  const request = ({ url }) => new Promise((resolve, reject) => requests.push({ url, resolve, reject }));
  function service(file) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), {
      module, require: name => name.endsWith("/request") ? request : {}, getApp: () => app
    });
    return module.exports;
  }
  const deps = {
    "../../services/appointment": service("services/appointment.js"),
    "../../services/admin": service("services/admin.js"),
    "../../services/therapistPortal": service("services/therapistPortal.js"),
    "../../utils/filterTime": require("../../miniprogram/utils/filterTime"),
    "../../utils/checkIn": { canCheckIn: () => false, startWatching() {}, stopWatching() {} },
    "../../utils/date": { today: () => "2026-11-11", isExpired: () => true }
  };
  let page;
  vm.runInNewContext(fs.readFileSync(path.join(root, "pages/my-appointments/index.js"), "utf8"), {
    Page: value => { page = value; }, require: name => deps[name] || {}, getApp: () => app,
    wx: { setNavigationBarTitle() {}, showToast() {}, pageScrollTo: value => scrolls.push(value) }
  });
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback(); };
  page.onLoad({});
  page.loadFilterOptions = () => {};
  page.showForUser(user);
  const event = sort => ({ currentTarget: { dataset: { sort, sortVersion: page.data.sortVersion } } });
  const select = sort => { page.toggleSortMenu(event()); page.selectSort(event(sort)); };
  return { page, app, requests, scrolls, event, select };
}
function result(id, hasMore = false, nextCursor = "") {
  return { appointments: [{ id, status: "cancelled" }], pagination: { hasMore, nextCursor } };
}

for (const role of ["user", "therapist", "admin"]) {
  test(`${role} sort requests reach its own API and keep status and confirmed filters`, async () => {
    const { page, requests, select, event, scrolls } = frontend(role);
    assert.equal(new URL(requests[0].url, "http://local").searchParams.get("sort"), "service_desc");
    requests[0].resolve(result("old", true, "old-cursor")); await flush();
    Object.assign(page.data, { active: "cancelled", filterServiceItemIds: ["project-a"], filterAllDates: false,
      filterFromDate: "2026-11-01", filterToDate: "2026-11-30", selectedAppointmentId: "old", page: 3 });
    select("created_asc");
    const query = new URL(requests.at(-1).url, "http://local");
    assert.equal(query.pathname, role === "user" ? "/api/appointments/my" : `/api/${role}/appointments`);
    assert.equal(query.searchParams.get("sort"), "created_asc");
    assert.equal(query.searchParams.get("status"), "cancelled");
    assert.equal(query.searchParams.get("serviceItemIds"), "project-a");
    assert.equal(query.searchParams.get("fromDate"), "2026-11-01");
    assert.equal(query.searchParams.get("page"), "1");
    assert.equal(query.searchParams.has("cursor"), false);
    assert.equal(page.data.selectedAppointmentId, "");
    assert.equal(page.data.sortMenuVisible, false);
    assert.equal(scrolls.at(-1).scrollTop, 0);
    const length = requests.length;
    page.selectSort(event("service_asc")); assert.equal(requests.length, length, "closed menu rejects late selections");
    select("created_asc"); assert.equal(requests.length, length, "same choice does not reload");
    requests.at(-1).resolve(result("first", true, "new-cursor")); await flush();
    page.onReachBottom();
    const more = new URL(requests.at(-1).url, "http://local");
    assert.equal(more.searchParams.get("sort"), "created_asc");
    assert.equal(more.searchParams.get("cursor"), "new-cursor");
  });
}

test("late first-page and append results cannot override a new sort, and retry retains the chosen order", async () => {
  const { page, requests, select } = frontend();
  select("service_asc");
  requests[1].resolve(result("new-first", true, "cursor")); await flush();
  requests[0].resolve(result("stale-first")); await flush();
  assert.equal(page.data.appointments[0].id, "new-first");
  page.onReachBottom();
  select("created_desc");
  requests[3].reject(new Error("temporary")); await flush();
  requests[2].resolve(result("stale-append")); await flush();
  assert.equal(page.data.appointments.length, 0);
  assert.equal(page.data.listError, "temporary");
  page.retryAppointments();
  assert.equal(new URL(requests[4].url, "http://local").searchParams.get("sort"), "created_desc");
});

test("hidden, reopened, filter-open, and old-account menus reject delayed events", async () => {
  const { page, requests, select, event, app } = frontend();
  select("created_desc");
  page.toggleSortMenu(event());
  const stale = event("service_asc");
  page.onHide(); page.selectSort(stale);
  page.onShow(); page.selectSort(stale);
  assert.equal(page.data.sort, "created_desc");
  page.toggleSortMenu(event());
  page.selectSort(stale); assert.equal(page.data.sortMenuVisible, true);
  const beforeFilter = event("service_asc");
  page.openFilterDrawer({ currentTarget: { dataset: { filterVersion: page.data.filterVersion } } });
  assert.equal(page.data.sortMenuVisible, false);
  page.selectSort(beforeFilter); assert.equal(page.data.sort, "created_desc");
  page.closeFilterDrawer({ currentTarget: { dataset: { filterVersion: page.data.filterVersion } } });
  page.toggleSortMenu(event());
  const beforeAccount = event("service_asc");
  app.globalData = { user: { id: "account-b", role: "admin" }, token: "session-b" };
  const length = requests.length;
  page.selectSort(beforeAccount); assert.equal(requests.length, length);
  requests.at(-1).resolve(result("account-a")); await flush();
  assert.equal(page.data.appointments.length, 0);
  page.showForUser(app.globalData.user);
  assert.equal(page.data.sort, "service_desc");
  assert.equal(page.data.sortMenuVisible, false);
  assert.equal(page.data.filterServiceItemIds.length, 0);
});

test("sort persists through tabs and details, and outside dismissal does not change it", () => {
  const { page, select, event, requests } = frontend();
  select("created_asc");
  page.switchTab({ currentTarget: { dataset: { key: "all" } } });
  assert.equal(new URL(requests.at(-1).url, "http://local").searchParams.get("sort"), "created_asc");
  page.onHide(); page.onShow();
  assert.equal(page.data.sort, "created_asc");
  page.toggleSortMenu(event());
  const length = requests.length;
  page.closeSortMenu(event());
  assert.equal(page.data.sort, "created_asc");
  assert.equal(page.data.sortMenuVisible, false);
  assert.equal(requests.length, length);
});

test("confirming and resetting filters preserves sort and discards the previous page cursor", async () => {
  const { page, select, requests } = frontend();
  select("created_asc");
  requests.at(-1).resolve(result("page-one", true, "old-cursor")); await flush();
  page.onReachBottom();
  const oldPage = requests.at(-1);
  page.data.serviceItems = [{ id: "p1" }, { id: "p2" }];
  const filterEvent = value => ({ currentTarget: { dataset: { filterVersion: page.data.filterVersion } }, detail: { value } });
  page.openFilterDrawer(filterEvent());
  page.selectFilterProjects(filterEvent(["p1"]));
  page.confirmFilters(filterEvent());
  let query = new URL(requests.at(-1).url, "http://local").searchParams;
  assert.equal(query.get("sort"), "created_asc");
  assert.equal(query.get("serviceItemIds"), "p1");
  assert.equal(query.get("page"), "1");
  assert.equal(query.has("cursor"), false);
  requests.at(-1).resolve(result("filtered")); await flush();
  oldPage.resolve(result("unfiltered-old-page")); await flush();
  assert.deepEqual(Array.from(page.data.appointments, item => item.id), ["filtered"]);
  page.openFilterDrawer(filterEvent());
  page.resetFilterDraft(filterEvent());
  page.confirmFilters(filterEvent());
  query = new URL(requests.at(-1).url, "http://local").searchParams;
  assert.equal(query.get("sort"), "created_asc");
  assert.equal(query.has("serviceItemIds"), false);
});

test("failed continuation retries the same cursor and duplicate sort taps do not send twice", async () => {
  const { page, event, requests } = frontend();
  page.toggleSortMenu(event());
  const choice = event("service_asc");
  page.selectSort(choice);
  const count = requests.length;
  page.selectSort(choice);
  assert.equal(requests.length, count);
  requests.at(-1).resolve(result("first", true, "cursor-one")); await flush();
  page.onReachBottom();
  const failedUrl = requests.at(-1).url;
  requests.at(-1).reject(new Error("temporary")); await flush();
  assert.equal(page.data.appointments[0].id, "first");
  page.retryAppointments();
  assert.equal(requests.at(-1).url, failedUrl);
  requests.at(-1).resolve(result("second")); await flush();
  assert.deepEqual(Array.from(page.data.appointments, item => item.id), ["first", "second"]);
  assert.equal(page.data.hasMore, false);
});
