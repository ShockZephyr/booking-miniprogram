const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const temporary = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "booking-filter-test-"));
const emptyEnvironment = path.join(temporary, "empty.env");
fs.writeFileSync(emptyEnvironment, "");
process.env.BOOKING_ENV_FILE = emptyEnvironment;
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "";
test.after(() => { fs.unlinkSync(emptyEnvironment); fs.rmdirSync(temporary); });
const { availability, parseRosterFilters, expandFilterRange } = require("../src/utils/schedule");
const filters = require("../../miniprogram/utils/bookingFilters");
const filterTime = require("../../miniprogram/utils/filterTime");
const { setup, flush, plain } = require("./support/scheduleUI");
const range = (startTime, endTime) => ({ startTime, endTime });
const ids = Array.from({ length: 5 }, (_, i) => `10000000-0000-4000-8000-00000000000${i + 1}`);

test("roster time matching uses legal grid starts and earliest ends, with inclusive endpoints and uninterrupted minimum duration", () => {
  for (const step of [10, 15, 30]) {
    const day = { date: "2034-04-04", step, minDuration: 90, serviceItemIds: [ids[3]],
      ranges: [range("09:00", "12:00"), range("14:00", "17:00")], closed: [], busy: [] };
    const now = new Date(day.date + "T09:05:00+08:00");
    assert.equal(availability(day, now, range("09:00", "10:30")), "available", "current cell can still start at 09:00");
    assert.equal(availability(day, now, range("09:01", "10:30")), "full", "filter start is rounded up to a legal grid point");
    assert.equal(availability(day, now, range("10:30", "12:00")), "available");
    assert.equal(availability(day, now, range("11:00", "14:30")), "full", "breaks cannot be bridged");
    assert.equal(availability({ ...day, closed: ["10:30"] }, now, range("09:00", "10:30")), "available", "a closed cell start can end the prior booking");
    assert.equal(availability({ ...day, closed: ["10:00"] }, now, range("09:00", "10:30")), "full");
    assert.equal(availability({ ...day, busy: [range("09:30", "10:00")] }, now, range("09:00", "11:00")), "full");
    assert.equal(availability({ ...day, busy: [range("09:00", "10:30")] }, now, range("10:30", "12:00")), "available");
    assert.equal(availability(day, new Date(now.getTime() + step * 60000), range("09:00", "10:30")), "full");
  }
});

test("filter parsing rejects malformed identifiers/time values; frontend and backend expand ranges consistently", () => {
  assert.deepEqual(parseRosterFilters({}), { serviceItemIds: [], therapistIds: [], startTime: "00:00", endTime: "23:59" });
  for (const query of [{ serviceItemIds: "bad" }, { therapistIds: {} }, { startTime: ["09:00"] },
    { startTime: "24:00" }, { endTime: "08:00", startTime: "09:00" }, { endTime: "09:00", startTime: "09:00" }]) {
    assert.throws(() => parseRosterFilters(query), { code: "INVALID_FILTER", status: 400 });
  }
  for (const duration of [10, 15, 30, 60, 90, 100, 105, 120, null]) {
    for (const window of [range("00:00", "00:01"), range("10:00", "10:10"), range("22:59", "23:59"), range("00:00", "23:59")]) {
      assert.deepEqual(expandFilterRange(window.startTime, window.endTime, duration), filters.adjustRange(window.startTime, window.endTime, duration));
    }
  }
  assert.deepEqual(filters.adjustRange("23:30", "23:59", 90), range("22:00", "23:59"));
  assert.deepEqual(filters.adjustRange("09:00", "10:00", 100), range("09:00", "11:00"));
  assert.deepEqual(filters.adjustRange("09:00", "18:00", 90), range("09:00", "18:00"));
});

function serviceFixture() {
  const date = "2999-01-01", client = {}, calls = [];
  const people = ids.slice(0, 3).map((id, i) => ({ id, name: `合成芳疗师${i}`, tags: ["不能用于匹配的标签"], phone: "private", userId: "private" }));
  const projects = ids.slice(3).map((id, i) => ({ id, name: `合成项目${i}` }));
  const rules = people.map((person, i) => ({ therapistId: person.id, step: 30, minDuration: i === 0 ? 60 : 90,
    ranges: i === 2 ? [] : [range("09:00", "12:00")], closed: [], serviceItemIds: [projects[i === 0 ? 0 : 1].id] }));
  const state = { occupied: [], actor: null };
  const repository = {
    settings: async () => ({ daysVisible: 7 }),
    activeTherapists: async selected => selected ? people.filter(p => selected.includes(p.id)) : people,
    filterProjects: async tx => { assert.equal(tx, client); return projects; },
    rulesForDate: async selected => plain(rules.filter(r => selected.includes(r.therapistId))),
    busy: async (day, selected, userId, exclude, tx) => { assert.equal(tx, client); calls.push(userId); return plain(state.occupied); }
  };
  const deps = { "../config/db": { transaction: async run => run(client), query: async () => ({ rows: [] }) },
    "../repositories/scheduleRepository": repository, "./currentActorService": { load: async () => state.actor },
    "./auditService": {}, "./noShowService": {}, "../utils/errors": require("../src/utils/errors"),
    "../utils/date": { ...require("../src/utils/date"), todayString: () => date },
    "../utils/phone": require("../src/utils/phone"), "../utils/schedule": require("../src/utils/schedule") };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/services/scheduleService.js"), "utf8"), { module, require: name => deps[name], Date });
  return { date, people, projects, rules, calls, state, service: module.exports,
    list: query => module.exports.list(date, state.actor, { withFilters: "1", ...query }).then(plain) };
}

test("service filters actual date projects, expands using candidate minimum before time matching, and preserves unfiltered rest days", async () => {
  const h = serviceFixture();
  let result = await h.list({});
  assert.equal(result.therapists.length, 3); assert.equal(result.minDuration, 60);
  result = await h.list({ startTime: "10:00", endTime: "11:00" });
  assert.deepEqual(result.therapists.map(p => p.id), [ids[0]]);
  assert.equal(result.minDuration, 60, "busy/time results must not change input minimum");
  result = await h.list({ therapistIds: ids[1], startTime: "10:00", endTime: "11:00" });
  assert.equal(result.appliedFilters.endTime, "11:30"); assert.equal(result.minDuration, 90);
  assert.deepEqual(result.therapists.map(p => p.id), [ids[1]]);
  result = await h.list({ serviceItemIds: ids[4] });
  assert.deepEqual(result.therapists.map(p => p.id), [ids[1]], "resting person with matching project is excluded by active filter");
  assert.equal(result.filterOptions.therapists.length, 3, "options are not narrowed by time results");
  result = await h.list({ serviceItemIds: ids[3], therapistIds: ids[1] });
  assert.equal(result.minDuration, null); assert.equal(result.therapists.length, 0);
  result = await h.list({ serviceItemIds: h.projects.map(p => p.id).join(","), therapistIds: h.people.map(p => p.id).join(",") });
  assert.equal(result.therapists.length, 3); assert.deepEqual(result.appliedFilters.serviceItemIds, []);
  const retired = "20000000-0000-4000-8000-000000000009";
  result = await h.list({ serviceItemIds: retired });
  assert.deepEqual(result.appliedFilters.serviceItemIds, [], "disappeared options cannot remain invisible restrictions");
  assert.equal(result.therapists.length, 3);
});

test("service respects current identity, personal conflicts, assigned scope and administrator priority without private DTO fields", async () => {
  const h = serviceFixture();
  h.state.actor = { id: "customer", role: "user" };
  h.state.occupied = [{ therapistId: ids[2], own: true, startTime: "09:00", endTime: "12:00" }];
  let result = await h.list({ startTime: "09:00", endTime: "10:30" });
  assert.equal(result.therapists.length, 0); assert.equal(h.calls.at(-1), "customer");
  h.state.occupied = [];
  h.state.actor = { id: "worker", role: "user", therapistId: ids[1] };
  result = await h.list({ therapistIds: ids[0] });
  assert.deepEqual(result.filterOptions.therapists.map(p => p.id), [ids[1]]);
  assert.deepEqual(result.therapists.map(p => p.id), [ids[1]]);
  h.state.actor = { id: "manager", role: "admin", therapistId: ids[1] };
  result = await h.list({}); assert.equal(result.therapists.length, 3); assert.equal(h.calls.at(-1), null);
  assert.doesNotMatch(JSON.stringify(result), /private|userId|openid|phone/);
});

test("half-hour filters still find ten-minute bookings and date minimum changes expand to selectable boundaries", async () => {
  const h = serviceFixture();
  Object.assign(h.rules[0], { step: 10, minDuration: 90, closed: ["09:00"] });
  let result = await h.list({ therapistIds: ids[0], startTime: "09:00", endTime: "11:00" });
  assert.deepEqual(result.therapists.map(p => p.id), [ids[0]], "09:10–10:40 remains legal within 09:00–11:00");
  assert.equal(result.filterOptions.therapists[0].minDuration, 90);
  Object.assign(h.rules[0], { minDuration: 100, closed: [] });
  result = await h.list({ therapistIds: ids[0], startTime: "09:00", endTime: "10:30" });
  assert.equal(result.appliedFilters.endTime, "11:00");
  assert.equal(result.filterOptions.therapists[0].minDuration, 100, "the actual booking minimum is not rounded");
  result = await h.list({ therapistIds: ids[0], startTime: "23:00", endTime: "23:59" });
  assert.equal(result.appliedFilters.startTime, "22:00");
  // Existing clients may submit minute-level filters. A valid range is not broadened.
  result = await h.list({ therapistIds: ids[0], startTime: "09:10", endTime: "10:50" });
  assert.equal(result.appliedFilters.startTime, "09:10"); assert.equal(result.appliedFilters.endTime, "10:50");
});

const event = (page, dataset = {}, value) => ({ currentTarget: { dataset: { filterVersion: page.data.filterVersion, ...dataset } }, detail: { value } });
const pick = (page, field, time) => page.inputRosterTime(event(page, { field }, String(filterTime.indexFromTime(time, field))));
async function roster() {
  const h = setup(); h.app.globalData.user.role = "admin";
  h.requests = [];
  h.catalog = { projects: [{ id: "p", name: "项目一" }, { id: "q", name: "项目二" }], therapists: [
    { id: "a", name: "甲", minDuration: 60, hasSchedule: true, serviceItemIds: ["p"] },
    { id: "b", name: "乙", minDuration: 90, hasSchedule: true, serviceItemIds: ["q"] }
  ] };
  h.response = (date, query) => ({ today: h.day.today, daysVisible: 7, filterOptions: plain(h.catalog), appliedFilters: plain(query),
    therapists: [{ id: "a", name: "甲", status: "available", scheduleDate: date }] });
  h.deps.schedules.list = async (date, query) => { h.requests.push([date, plain(query)]); return h.response(date, query); };
  h.page = h.page("pages/booking"); h.page.onLoad(); await h.page.onShow();
  return h;
}

test("drawer preserves a valid opposite endpoint, adjusts short ranges on the half-hour grid and rejects impossible manual edits", async () => {
  const h = await roster(), p = h.page; p.openFilterDrawer();
  assert.equal(p.data.draftMinimum, 60);
  pick(p, "startTime", "10:00");
  assert.equal(p.data.draftFilters.endTime, "23:59", "the first edit also retains a valid end");
  pick(p, "endTime", "13:00");
  pick(p, "startTime", "11:00");
  assert.equal(p.data.draftFilters.endTime, "13:00", "later starts do not shrink a longer manual range");
  pick(p, "endTime", "11:30");
  assert.equal(p.data.draftFilters.startTime, "10:30");
  p.selectRosterOptions(event(p, { kind: "therapists" }, ["b"]));
  assert.equal(p.data.draftMinimum, 90); assert.equal(p.data.draftFilters.endTime, "12:00");
  const previous = plain(p.data.draftFilters);
  pick(p, "startTime", "23:30");
  assert.deepEqual(plain(p.data.draftFilters), previous);
  pick(p, "endTime", "00:00");
  assert.deepEqual(plain(p.data.draftFilters), previous);
  assert.equal(h.calls.filter(call => call[0] === "toast").length, 2);
  p.useRosterAllTimes(event(p)); assert.equal(p.data.draftFilters.startTime, "00:00");
  p.selectRosterOptions(event(p, { kind: "projects" }, ["p"])); assert.equal(p.data.draftMinimum, null);
  p.resetRosterDraft(event(p)); assert.equal(p.data.draftMinimum, 60);
  p.selectRosterOptions(event(p, { kind: "projects", all: true }));
  p.selectRosterOptions(event(p, { kind: "projects", all: true }));
  assert.equal(p.data.draftFilters.serviceItemIds.length, 2);
  await p.confirmRosterFilters(event(p)); assert.equal(p.data.activeFilterCount, 0);
  assert.deepEqual(h.requests.at(-1)[1].serviceItemIds, []);
});

test("roster pickers round minimum repairs, preserve rejected selections and ignore stale picker events", async () => {
  const h = await roster(), p = h.page;
  h.catalog.therapists[0].minDuration = 100;
  await p.loadDay(); p.openFilterDrawer();
  p.selectRosterOptions(event(p, { kind: "projects" }, ["p"]));
  pick(p, "endTime", "10:00"); pick(p, "startTime", "09:00");
  assert.equal(p.data.draftFilters.endTime, "11:00");
  pick(p, "endTime", "10:30");
  assert.equal(p.data.draftFilters.startTime, "08:30");
  const oldPicker = event(p, { field: "startTime" }, 20);
  p.closeFilterDrawer(); p.openFilterDrawer();
  p.inputRosterTime(oldPicker); assert.equal(p.data.draftFilters.startTime, "00:00");
  for (const reset of ["useRosterAllTimes", "resetRosterDraft"]) {
    const beforeReset = event(p, { field: "startTime" }, 20);
    p[reset](event(p)); p.inputRosterTime(beforeReset);
    assert.equal(p.data.draftFilters.startTime, "00:00");
  }
  const beforeHide = event(p, { field: "endTime" }, 20);
  p.onHide(); p.inputRosterTime(beforeHide); assert.equal(p.data.draftFilters.endTime, "23:59");
  await p.onShow(); p.openFilterDrawer();
  p.inputRosterTime(beforeHide); assert.equal(p.data.draftFilters.endTime, "23:59");
  const beforeAccount = event(p, { field: "startTime" }, 20);
  h.app._loginSessionVersion++;
  p.inputRosterTime(beforeAccount); assert.equal(p.data.draftFilters.startTime, "00:00");
});

test("close discards drafts, date return preserves confirmed filters, and login/identity changes clear them", async () => {
  const h = await roster(), p = h.page; p.openFilterDrawer();
  p.selectRosterOptions(event(p, { kind: "projects" }, ["p"])); p.closeFilterDrawer();
  p.openFilterDrawer(); assert.deepEqual(plain(p.data.draftFilters.serviceItemIds), []);
  p.selectRosterOptions(event(p, { kind: "projects" }, ["q"]));
  await p.confirmRosterFilters(event(p)); assert.equal(p.data.activeFilterCount, 1);
  p.openDay({ currentTarget: { dataset: { id: "a" } } });
  const navigation = h.calls.filter(call => call[0] === "navigate").at(-1)[1];
  assert.doesNotMatch(navigation.url, /serviceItem|startTime|endTime/);
  p.onHide(); navigation.events.dateChange({ date: "2026-10-31" }); await p.onShow();
  assert.equal(p.data.selectedDate, "2026-10-31"); assert.deepEqual(h.requests.at(-1)[1].serviceItemIds, ["q"]);
  h.app._loginSessionVersion++; await p.onShow(); assert.equal(p.data.activeFilterCount, 0);
  p.openFilterDrawer(); p.selectRosterOptions(event(p, { kind: "projects" }, ["p"])); await p.confirmRosterFilters(event(p));
  h.app.globalData.user.id = "another"; await p.onShow(); assert.equal(p.data.activeFilterCount, 0);
  h.app.globalData.user.role = "user"; h.app.globalData.user.therapistId = h.day.therapistId; await p.onShow();
  p.openFilterDrawer(); assert.equal(p.data.filterDrawerVisible, false);
});

test("late drawer events and stale responses cannot overwrite a newer filter, date or session; failures retain confirmed conditions", async () => {
  const h = await roster(), p = h.page; p.openFilterDrawer();
  const oldEvent = event(p, { kind: "projects" }, ["q"]);
  p.closeFilterDrawer(); p.openFilterDrawer(); p.selectRosterOptions(oldEvent);
  assert.deepEqual(plain(p.data.draftFilters.serviceItemIds), []);
  const pending = [];
  h.deps.schedules.list = (date, query) => new Promise((resolve, reject) => pending.push({ date, query, resolve, reject }));
  p.selectRosterOptions(event(p, { kind: "projects" }, ["p"]));
  const first = p.confirmRosterFilters(event(p));
  p.changeDate({ detail: { date: "2026-10-31" } });
  pending[1].resolve(h.response(pending[1].date, pending[1].query)); await flush();
  const current = plain(p.data);
  p.clearRosterFilters(oldEvent);
  assert.deepEqual(plain(p.data), current, "a queued clear action cannot clear newer confirmed filters");
  pending[0].resolve(h.response(pending[0].date, pending[0].query)); await first;
  assert.deepEqual(plain(p.data), current);
  const retry = p.loadDay(); pending[2].reject(new Error("合成网络失败")); await retry;
  assert.match(p.data.error, /合成网络失败/); assert.deepEqual(plain(p.data.filters.serviceItemIds), ["p"]);
  const late = p.loadDay(); h.app._loginSessionVersion++;
  const next = p.onShow(); pending[4].resolve(h.response(pending[4].date, pending[4].query)); await next;
  pending[3].resolve(h.response(pending[3].date, pending[3].query)); await late;
  assert.equal(p.data.activeFilterCount, 0); assert.deepEqual(plain(p.data.filters.serviceItemIds), []);
});

test("drawer markup uses the existing icon and versions every draft event without introducing booking prefill", () => {
  const wxml = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/booking/index.wxml"), "utf8");
  assert.match(wxml, /class="roster-heading"[^]*?选择芳疗师[^]*?assets\/icons\/filter.png/);
  const tags = wxml.match(/<[^>]+bind(?:tap|change)="(?:selectRosterOptions|inputRosterTime|useRosterAllTimes|resetRosterDraft|confirmRosterFilters)"[^>]*>/g);
  assert.equal(tags.length, 9);
  for (const tag of tags) assert.match(tag, /data-filter-version="\{\{filterVersion\}\}"/);
});

test("new date minimum and removed options reconcile confirmed filters and counts; clear restores the unfiltered query", async () => {
  const h = await roster(), p = h.page;
  p.openFilterDrawer(); p.selectRosterOptions(event(p, { kind: "projects" }, ["p"]));
  pick(p, "startTime", "10:00"); pick(p, "endTime", "11:00"); await p.confirmRosterFilters(event(p));
  h.catalog.projects = h.catalog.projects.filter(item => item.id !== "p");
  h.catalog.therapists[0].hasSchedule = false;
  const response = h.response;
  h.response = (date, query) => ({ ...response(date, query), therapists: [],
    appliedFilters: { ...query, serviceItemIds: [], endTime: "11:30" } });
  p.changeDate({ detail: { date: "2026-10-31" } }); await flush();
  assert.equal(p.data.activeFilterCount, 1); assert.equal(p.data.filters.endTime, "11:30");
  p.openFilterDrawer(); assert.equal(p.data.draftMinimum, 90);
  assert.deepEqual(plain(p.data.draftFilters.serviceItemIds), []);
  h.response = response;
  await p.clearRosterFilters(event(p)); assert.equal(p.data.activeFilterCount, 0);
  assert.deepEqual(h.requests.at(-1)[1], { serviceItemIds: [], therapistIds: [], startTime: "00:00", endTime: "23:59" });
});

test("real frontend service encodes filter query through loopback HTTP and the controller to role-scoped schedule matching", async t => {
  const h = serviceFixture(), express = require("express"), app = express();
  const controller = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/controllers/scheduleController.js"), "utf8"), {
    module: controller, require: () => h.service
  });
  app.get("/api/schedules", (req, res, next) => { req.user = h.state.actor; controller.exports.list(req, res).catch(next); });
  app.use((error, req, res, next) => res.status(error.status || 500).json({ success: false, code: error.code }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../miniprogram/services/schedules.js"), "utf8"), {
    module: client, require: name => name.endsWith("/request") ? async ({ url }) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`), body = await response.json();
      if (!body.success) throw Object.assign(new Error(body.code), { code: body.code });
      return body.data;
    } : {}
  });
  const result = await client.exports.list(h.date, { therapistIds: [ids[1]], serviceItemIds: [ids[4]], ...range("10:00", "11:00") });
  assert.deepEqual(result.therapists.map(item => item.id), [ids[1]]);
  assert.equal(result.appliedFilters.endTime, "11:30");
  assert.equal(result.minDuration, 90);
  const legacy = await client.exports.list(h.date);
  assert.equal(legacy.therapists.length, 3); assert.equal(legacy.filterOptions, undefined);
  await assert.rejects(client.exports.list(h.date, { therapistIds: ["bad"] }), { code: "INVALID_FILTER" });
});

test("unsupported filtered responses are shown as errors rather than unfiltered matches, and clearing filters recovers browsing", async () => {
  const h = await roster(), p = h.page;
  p.openFilterDrawer(); p.selectRosterOptions(event(p, { kind: "projects" }, ["p"]));
  h.response = date => ({ today: h.day.today, daysVisible: 7, therapists: [{ id: "a", name: "甲", status: "available", scheduleDate: date }] });
  await p.confirmRosterFilters(event(p));
  assert.match(p.data.error, /筛选暂不可用/); assert.equal(p.data.therapists.length, 0);
  assert.equal(p.data.activeFilterCount, 1);
  await p.clearRosterFilters(event(p)); assert.equal(p.data.error, ""); assert.equal(p.data.therapists.length, 1);
  p.openFilterDrawer(); assert.equal(p.data.filterDrawerVisible, false);
});
