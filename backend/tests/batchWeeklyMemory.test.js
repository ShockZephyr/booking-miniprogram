const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const formEvents = require("./support/weeklyFormEvents");
const root = path.join(__dirname, "../../miniprogram");
const plain = value => JSON.parse(JSON.stringify(value));
const event = value => ({ detail: { value } });
const row = index => ({ currentTarget: { dataset: { index } } });
const beforeFirst = () => ({ currentTarget: { dataset: { placement: "before" } } });
const legacyRanges = [{ startTime: "09:00", endTime: "12:00" }, { startTime: "14:00", endTime: "17:00" }, { startTime: "19:00", endTime: "21:00" }];
const defaults = [{ startTime: "09:00", endTime: "12:00" }, { startTime: "12:30", endTime: "15:00" }, { startTime: "15:30", endTime: "18:00" }, { startTime: "18:30", endTime: "20:30" }];
const ranges = p => plain(p.data.ranges.map(({startTime,endTime}) => ({startTime,endTime})));
const key = id => "batchSchedule:lastSaved:v1:" + id;
const sample = () => ({ version: 2, therapistIds: ["t1", "t2"], weekdays: [1, 6], serviceItemIds: ["p1"],
  schedule: { step: 15, minDuration: 105, ranges: [{ startTime: "09:00", endTime: "10:45" }] } });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(options = {}) {
  const h = { storage: options.storage || new Map(), user: { id: options.userId || "admin-a", role: "admin" },
    token: "test-session", writes: [], weekWrites: [], alerts: [], alertRequests: [], nativeLeaveAlert: false, rules: {}, toasts: [], modals: [], reads: [], rawHandlers: new WeakMap(),
    therapists: options.therapists || [{ id: "t1" }, { id: "t2" }], projects: options.projects || [{ id: "p1" }, { id: "p2" }],
    rule: { step: 10, minDuration: 100, ranges: [{ startTime: "09:10", endTime: "12:10" }], serviceItemIds: ["p2"] } };
  function nativeAlert(enabled, value) {
    h.alerts.push(enabled ? ["enable", value.message] : ["disable"]);
    const request = { enabled, finish(ok = true) {
      if (ok) { h.nativeLeaveAlert = enabled; if (value.success) value.success({}); }
      else if (value.fail) value.fail({ errMsg: "simulated native alert failure" });
    } };
    h.alertRequests.push(request);
    if (!h.deferAlerts) request.finish();
  }
  const wx = { setNavigationBarTitle() {}, showToast: value => h.toasts.push(value.title),
    enableAlertBeforeUnload: value => nativeAlert(true, value),
    disableAlertBeforeUnload: value => nativeAlert(false, value),
    showModal: value => h.modals.push(value),
    getStorageSync: k => { if (h.readFailure) throw new Error("cache read failure"); return h.storage.has(k) ? plain(h.storage.get(k)) : ""; },
    setStorageSync: (k, value) => { if (h.writeFailure) throw new Error("cache full"); h.storage.set(k, plain(value)); } };
  const globals = { wx, getApp: () => ({ globalData: { user: h.user, token: h.token } }) };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "utils/batchScheduleMemory.js"), "utf8"), { ...globals, module: mod });
  h.newPage = async singleId => {
    let p;
    vm.runInNewContext(fs.readFileSync(path.join(root, "pages/admin/batch-slots/index.js"), "utf8"), {
      ...globals, Page: value => { p = value; }, require: name => {
        if (name.endsWith("/batchScheduleMemory")) return mod.exports;
        if (name.endsWith("/imageFallback")) return require("../../miniprogram/utils/imageFallback");
        if (name.endsWith("/loginReturn")) return { sessionKey: () => h.token + ":" + h.user.id, ensure: async () => true };
        if (name.endsWith("/therapist")) return { list: async () => h.peoplePending ? h.peoplePending.promise : { therapists: h.therapists } };
        if (name.endsWith("/user")) return { serviceItems: async () => ({ items: h.projects }) };
        if (name.endsWith("/admin")) return {
          weekly: async (id, day) => {
            h.reads.push([id, day]);
            if (h.weekFailure) throw new Error("周排班加载失败");
            return h.weekPending ? h.weekPending.promise : plain(h.rules[day] || h.rule);
          },
          saveWeeklyDays: async (id, days) => {
            h.weekWrites.push(plain({ therapistId: id, days }));
            if (h.saveFailure) throw new Error("保存失败");
            if (h.savePending) await h.savePending.promise;
            for (const day of days) h.rules[day.weekday] = { ...plain(day.schedule), serviceItemIds: plain(day.serviceItemIds) };
            return { updated: days.length, days: plain(days), deferredDates: h.deferredDates || [] };
          },
          saveWeekly: async body => {
            h.writes.push(plain(body));
            if (h.saveFailure) throw new Error("保存失败");
            if (h.savePending) await h.savePending.promise;
            return { deferredDates: h.deferredDates || [] };
          }
        };
        throw new Error("Unexpected dependency: " + name);
      }
    });
    p.setData = patch => Object.assign(p.data, patch);
    h.rawHandlers.set(p, formEvents.install(p));
    p.onLoad(singleId ? { therapistId: singleId } : {});
    await p.onShow();
    assert.equal(p.data.error, "");
    return p;
  };
  h.memory = mod.exports;
  h.page = await h.newPage(options.singleId);
  return h;
}
async function save(h, confirm = true) {
  const task = h.page.save();
  const modal = h.modals.at(-1);
  assert.ok(modal);
  modal.success({ confirm });
  await task;
}

test("weekly and batch field notes dismiss without saving or changing the draft", async () => {
  for (const singleId of ["", "t1"]) {
    const h = await setup({ singleId }), p = h.page;
    p.setMinimum(event("120"));
    const before = plain(p.data);
    for (const title of ["时间精度", "最短预约时长"]) {
      p.showFieldNote({ currentTarget: { dataset: { note: title, formVersion: p.data.formVersion } } });
      const modal = h.modals.pop();
      assert.equal(modal.title, title);
      assert.match(modal.content, title === "时间精度" ? /12:00只能作为结束时间/ : /正整数倍/);
      assert.equal(modal.showCancel, false);
      assert.equal(modal.confirmText, "知道了");
      assert.equal(modal.success, undefined);
    }
    assert.deepEqual(plain(p.data), before);
    assert.equal(h.writes.length + h.weekWrites.length + h.storage.size, 0);
  }
});
function choose(h) {
  const p = h.page;
  p.allPeople(); p.pickDays(event(["1", "6"])); p.selectProjects(event(["p1"]));
  while (p.data.ranges.length) p.removeRange(row(0));
  p.setStep(event("15")); p.setMinimum(event("105")); p.addRange();
  p.setTime({ currentTarget: { dataset: { key: p.data.ranges[0].key, field: "endTime" } }, detail: { value: p.data.times.indexOf("10:45") } });
}

test("deferred daily parameters are reported without replacing saved weekly drafts or account prefill", async () => {
  for (const singleId of ["", "t1"]) {
    const h = await setup({ singleId }), p = h.page;
    if (singleId) p.setMinimum(event("120")); else choose(h);
    h.deferredDates = [{ therapistId: "t1", date: "2090-01-02", step: 30, minDuration: 90 }];
    await save(h);
    const notice = h.modals.at(-1);
    assert.equal(notice.title, "排班已保存"); assert.equal(notice.showCancel, false);
    assert.match(notice.content, /2090-01-02：精度30分钟，最短90分钟/);
    assert.equal(p.data.saving, false);
    if (singleId) {
      assert.equal(p.data.minDuration, "120"); assert.equal(p.data.dirtyDays.length, 0);
      assert.equal(h.storage.size, 0);
    } else assert.deepEqual(h.storage.get(key("admin-a")), sample());
  }
});

test("late parameter warnings never appear on a hidden page or after account switching", async () => {
  for (const singleId of ["", "t1"]) for (const switchAccount of [false, true]) {
    const h = await setup({ singleId }), p = h.page;
    if (singleId) p.setMinimum(event("120")); else choose(h);
    h.deferredDates = [{ therapistId: "t1", date: "2090-01-02", step: 30, minDuration: 90 }];
    const pending = h.savePending = deferred(), task = save(h);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.writes.length + h.weekWrites.length, 1);
    p.onHide();
    if (switchAccount) { h.user = { id: "admin-b", role: "admin" }; h.token = "other-session"; }
    pending.resolve(); await task;
    assert.equal(h.modals.length, 1, "only the original confirmation was shown");
    if (!singleId && !switchAccount) assert.deepEqual(h.storage.get(key("admin-a")), sample());
    else assert.equal(h.storage.size, 0);
  }
});

test("new batch forms bind 30 minutes and four default ranges and remember only a successful save for the same administrator", async () => {
  const h = await setup(), p = h.page;
  assert.equal(p.data.step, 30); assert.equal(p.data.minDuration, "90");
  assert.deepEqual(ranges(p), defaults);
  assert.deepEqual(plain(p.data.therapistIds), []); assert.deepEqual(plain(p.data.selectedDays), []);
  const template = fs.readFileSync(path.join(root, "pages/admin/batch-slots/index.wxml"), "utf8");
  assert.match(template, /radio value="\{\{item\}\}" checked="\{\{step === item\}\}"/);
  choose(h); await save(h);
  assert.deepEqual(h.storage.get(key("admin-a")), sample());
  p.setStep(event("30")); p.onUnload();
  const again = await setup({ storage: h.storage });
  assert.equal(again.page.data.step, 15); assert.equal(again.page.data.minDuration, "105");
  assert.deepEqual(plain(again.page.data.selectedDays), [1, 6]);
  assert.equal(again.page.data.therapists.filter(t => t.checked).length, 2);
  assert.equal(again.page.data.projects.filter(item => item.checked)[0].id, "p1");
  assert.equal(again.page.data.times[again.page.data.ranges[0].startIndex], "09:00");
  assert.equal(again.page.data.times[again.page.data.ranges[0].endIndex], "10:45");
  assert.equal(again.writes.length, 0, "restoring the form does not update schedules");
  again.token = "new-login-same-admin"; await again.page.onShow();
  assert.equal(again.page.data.step, 15);
  const other = await setup({ storage: h.storage, userId: "admin-b" });
  assert.equal(other.page.data.step, 30); assert.equal(other.page.data.selectedDays.length, 0);
  h.storage.clear(); const cleared = await setup({ storage: h.storage });
  assert.equal(cleared.page.data.step, 30);
});

test("legacy batch prefill resets ranges once per account while preserving selections and compatible parameters", async () => {
  const old = { ...sample(), version: 1 };
  const storage = new Map([[key("admin-a"), old], [key("admin-b"), { ...old, weekdays: [3], serviceItemIds: ["p2"] }]]);
  const h = await setup({ storage }), p = h.page;
  assert.deepEqual(ranges(p), defaults);
  assert.equal(p.data.step, 15); assert.equal(p.data.minDuration, "105");
  assert.deepEqual(plain(p.data.therapistIds), old.therapistIds);
  assert.deepEqual(plain(p.data.selectedDays), old.weekdays);
  assert.deepEqual(plain(p.data.projectIds), old.serviceItemIds);
  assert.deepEqual(storage.get(key("admin-a")), { ...old, version: 2, schedule: { ...old.schedule, ranges: defaults } });
  assert.equal(storage.get(key("admin-b")).version, 1, "another administrator is not migrated proactively");
  assert.equal(h.writes.length, 0, "migration is local preference only");
  p.setTime({ currentTarget: { dataset: { key: p.data.ranges[0].key, field: "startTime" } }, detail: { value: p.data.times.indexOf("08:00") } });
  assert.deepEqual(storage.get(key("admin-a")).schedule.ranges, defaults, "unsaved edits are not remembered");
  choose(h); await save(h); p.onUnload();
  const again = await setup({ storage });
  assert.deepEqual(ranges(again.page), sample().schedule.ranges, "a later successful save must not reset again");
  const other = await setup({ storage, userId: "admin-b" });
  assert.deepEqual(ranges(other.page), defaults);
  assert.deepEqual(plain(other.page.data.selectedDays), [3]);
  assert.deepEqual(plain(other.page.data.projectIds), ["p2"]);
  assert.deepEqual(storage.get(key("admin-a")), sample());
});

test("legacy rest days reset once and incompatible parameters fall back without clearing other choices", async () => {
  for (const schedule of [
    { step: 30, minDuration: 180, ranges: legacyRanges },
    { step: 20, minDuration: 100, ranges: [] },
    { step: 15, minDuration: 90, ranges: [] }
  ]) {
    const old = { ...sample(), version: 1, schedule };
    const h = await setup({ storage: new Map([[key("admin-a"), old]]) });
    assert.deepEqual(ranges(h.page), defaults);
    assert.equal(h.page.data.step, schedule.step === 15 ? 15 : 30);
    assert.equal(h.page.data.minDuration, "90");
    assert.deepEqual(plain(h.page.data.selectedDays), old.weekdays);
    assert.deepEqual(plain(h.page.data.projectIds), old.serviceItemIds);
    while (h.page.data.ranges.length) h.page.removeRange(row(0));
    await save(h);
    const again = await setup({ storage: h.storage });
    assert.deepEqual(ranges(again.page), [], "new-version intentional rest days remain remembered");
  }
});

test("legacy migration tolerates full storage and never touches a single-therapist weekly draft", async () => {
  const old = { ...sample(), version: 1 };
  const storage = new Map([[key("admin-a"), old]]);
  const weekly = await setup({ storage, singleId: "t1" });
  assert.deepEqual(ranges(weekly.page), weekly.rule.ranges);
  assert.deepEqual(storage.get(key("admin-a")), old);
  weekly.writeFailure = true;
  const batch = await weekly.newPage();
  assert.deepEqual(ranges(batch), defaults);
  assert.deepEqual(plain(batch.data.projectIds), old.serviceItemIds);
  assert.equal(batch.data.error, "");
  assert.equal(weekly.writes.length, 0);
  assert.deepEqual(storage.get(key("admin-a")), old);
});

test("cancelled, invalid, failed and unsaved batch changes cannot replace the last successful form", async () => {
  const storage = new Map([[key("admin-a"), sample()]]), h = await setup({ storage }), p = h.page;
  p.setStep(event("30"));
  await p.save(); assert.equal(h.modals.length, 0, "105 minutes is invalid at precision 30");
  p.setMinimum(event("90")); p.setTime({ currentTarget: { dataset: { index: 0, field: "endTime" } }, detail: { value: p.data.times.indexOf("12:00") } });
  await save(h, false); assert.equal(h.writes.length, 0);
  h.saveFailure = true; await save(h);
  assert.equal(p.data.saving, false); assert.equal(p.data.step, 30);
  assert.deepEqual(storage.get(key("admin-a")), sample());
  p.onUnload(); const again = await setup({ storage }); assert.equal(again.page.data.step, 15);
});

test("batch saves always include both sections and preserve intentional empty project and rest-day settings", async () => {
  const h = await setup(); choose(h);
  while (h.page.data.ranges.length) h.page.removeRange(row(0));
  h.page.selectProjects(event([])); await save(h);
  const again = await setup({ storage: h.storage }), p = again.page;
  assert.equal(p.data.step, 15); assert.equal(p.data.ranges.length, 0); assert.equal(p.data.projectIds.length, 0);
  assert.deepEqual(h.storage.get(key("admin-a")), { version: 2, therapistIds: ["t1", "t2"], weekdays: [1, 6], serviceItemIds: [], schedule: {step:15,minDuration:105,ranges:[]} });
  assert.match(h.modals[0].content, /全天休息.*清空可约项目/);
  p.addRange();
  await save(again);
  assert.deepEqual(again.writes[0].schedule.ranges, [{startTime:"09:00",endTime:"12:00"}]);
  assert.deepEqual(again.writes[0].serviceItemIds, []);
  for (const omit of ["schedule", "serviceItemIds"]) {
    const legacy = sample(); delete legacy[omit];
    const fallback = await setup({ storage: new Map([[key("admin-a"), legacy]]) });
    assert.deepEqual(ranges(fallback.page), defaults);
    assert.equal(fallback.page.data.selectedDays.length, 0);
  }
});

test("prefill removes retired options and ignores malformed local schedules without changing business data", async () => {
  const saved = sample(); saved.therapistIds.push("retired"); saved.serviceItemIds.push("removed");
  const h = await setup({ storage: new Map([[key("admin-a"), saved]]), therapists: [{ id: "t2" }], projects: [{ id: "p2" }] });
  assert.deepEqual(plain(h.page.data.therapistIds), ["t2"]); assert.deepEqual(plain(h.page.data.projectIds), []);
  assert.equal(h.writes.length, 0);
  for (const schedule of [null, { ...sample().schedule, step: 20 }, { ...sample().schedule, minDuration: 91 },
    { ...sample().schedule, ranges: [{ startTime: "09:10", endTime: "10:45" }] },
    { ...sample().schedule, ranges: [{ startTime: "09:00", endTime: "10:00" }] },
    { ...sample().schedule, ranges: [{ startTime: "09:00", endTime: "24:00" }] },
    { ...sample().schedule, ranges: [{ startTime: "09:00", endTime: "12:00" }, { startTime: "11:00", endTime: "13:00" }] }]) {
    const fallback = await setup({ storage: new Map([[key("admin-a"), { ...sample(), schedule }]]) });
    assert.equal(fallback.page.data.step, 30); assert.equal(fallback.page.data.selectedDays.length, 0);
    assert.equal(fallback.writes.length, 0);
  }
});

test("single-person weekly templates always use server data and never overwrite batch memory", async () => {
  const storage = new Map([[key("admin-a"), sample()]]), h = await setup({ storage, singleId: "t1" });
  assert.equal(h.page.data.step, 10); assert.equal(h.page.data.minDuration, "100");
  assert.equal(h.page.data.ranges[0].startTime, "09:10");
  assert.deepEqual(plain(h.page.data.selectedDays), [1]);
  h.page.setMinimum(event("120"));
  await save(h);
  assert.deepEqual(storage.get(key("admin-a")), sample()); assert.equal(h.reads.length, 1);
  assert.equal(h.weekWrites[0].days[0].schedule.minDuration, 120);
});

test("weekly profile uses the selected therapist and survives weekday changes without changing the saved template", async () => {
  const people = [
    { id: "t1", name: "示例甲", imageSrc: "https://example.invalid/first.png", tags: ["项目甲"] },
    { id: "t2", name: "示例乙", imageSrc: "https://example.invalid/second.png", tags: ["项目乙", "较长的项目名称"] }
  ];
  const h = await setup({ singleId: "t2", therapists: people }), p = h.page;
  assert.deepEqual(plain(p.data.person), people[1]);
  assert.equal(p.data.personName, "示例乙");
  assert.equal(p.data.imageSource, people[1].imageSrc);
  const imageRequest = plain(p.data.imageRequests);
  await p.pickWeekday({ currentTarget: { dataset: { day: 4 } } });
  assert.deepEqual(h.reads.at(-1), ["t2", 4]);
  assert.deepEqual(plain(p.data.imageRequests), imageRequest);
  assert.deepEqual(plain(p.data.person.tags), people[1].tags);
  p.selectProjects(event(["p1"]));
  await save(h);
  assert.deepEqual(h.weekWrites[0], { therapistId: "t2", days: [{ weekday: 4,
    schedule: { step: 10, minDuration: 100, ranges: [{ startTime: "09:10", endTime: "12:10" }] },
    serviceItemIds: ["p1"] }] });
  const withoutPhoto = await setup({ singleId: "t1", therapists: [{ id: "t1", name: "示例甲", tags: [] }] });
  assert.equal(withoutPhoto.page.data.imageSource, "");
  assert.deepEqual(plain(withoutPhoto.page.data.imageRequests), []);
  assert.equal(withoutPhoto.page.data.imageFailed, false);
  const batch = await setup({ therapists: people });
  assert.equal(batch.page.data.person, null);
  assert.equal(batch.page.data.imageSource, "");
});

test("weekly avatar retry preserves its URL and ignores obsolete image callbacks", async () => {
  const source = "https://example.invalid/photo.png?signature=example";
  const h = await setup({ singleId: "t1", therapists: [{ id: "t1", name: "示例甲", imageSrc: source }] }), p = h.page;
  const error = attempt => ({ currentTarget: { dataset: { attempt } } });
  const first = p.data.imageAttempt;
  p.imageError(error(first)); assert.equal(p.data.imageFailed, true);
  p.retryImage();
  assert.equal(p.data.imageFailed, false);
  assert.equal(p.data.imageSource, source);
  assert.equal(p.data.imageRequests[0].src, source);
  assert.ok(p.data.imageAttempt > first);
  p.imageError(error(first)); assert.equal(p.data.imageFailed, false);
  const beforeReload = p.data.imageAttempt;
  await p.initialize();
  p.imageError(error(beforeReload)); assert.equal(p.data.imageFailed, false);
  p.imageError(error(p.data.imageAttempt)); assert.equal(p.data.imageFailed, true);
  const unloadedState = plain(p.data);
  p.onUnload(); p.retryImage(); p.retryIconError();
  assert.deepEqual(plain(p.data), unloadedState);
});

test("weekly profile reload clears old identity data and rejects late image or catalog results after account changes", async () => {
  const oldPerson = { id: "t1", name: "示例甲", imageSrc: "https://example.invalid/old.png", tags: ["旧标签"] };
  const h = await setup({ singleId: "t1", therapists: [oldPerson] }), p = h.page;
  const oldAttempt = p.data.imageAttempt;
  h.user.id = "admin-b"; h.token = "session-b";
  p.imageError({ currentTarget: { dataset: { attempt: oldAttempt } } });
  assert.equal(p.data.imageFailed, false);
  const pending = deferred(); h.peoplePending = pending;
  const loadingB = p.onShow();
  assert.equal(p.data.person, null); assert.equal(p.data.personName, "");
  assert.equal(p.data.imageSource, ""); assert.equal(p.data.imageRequests.length, 0);
  await Promise.resolve(); await Promise.resolve();
  h.user.id = "admin-c"; h.token = "session-c"; h.peoplePending = null;
  h.therapists = [{ id: "t1", name: "更新后的资料", imageSrc: "https://example.invalid/current.png", tags: ["新标签"] }];
  await p.onShow();
  const current = plain(p.data);
  pending.resolve({ therapists: [oldPerson] }); await loadingB;
  p.imageError({ currentTarget: { dataset: { attempt: oldAttempt } } });
  assert.deepEqual(plain(p.data), current);
  assert.equal(p.data.personName, "更新后的资料");
  assert.equal(h.writes.length, 0);
});

test("late load and save responses cannot restore or store another administrator's batch settings", async () => {
  const storage = new Map([[key("admin-a"), sample()]]), h = await setup({ storage }), p = h.page;
  const pendingLoad = deferred(); h.peoplePending = pendingLoad;
  const oldLoad = p.initialize(); await Promise.resolve(); await Promise.resolve();
  h.user = { id: "admin-b", role: "admin" }; h.peoplePending = null;
  await p.onShow(); pendingLoad.resolve({ therapists: h.therapists }); await oldLoad;
  assert.equal(p.data.step, 30); assert.equal(p.data.therapistIds.length, 0);
  choose(h); const pendingSave = h.savePending = deferred();
  const oldSave = p.save(); h.modals.at(-1).success({ confirm: true });
  await Promise.resolve(); await Promise.resolve(); assert.equal(h.writes.length, 1);
  h.user = { id: "admin-a", role: "admin" }; await p.onShow();
  pendingSave.resolve(); await oldSave;
  assert.equal(storage.has(key("admin-b")), false);
  assert.deepEqual(storage.get(key("admin-a")), sample()); assert.equal(p.data.step, 15);
});

test("cache failures do not block loading or turn an already successful server save into a failed operation", async () => {
  const h = await setup(); h.readFailure = true; await h.page.initialize();
  assert.equal(h.page.data.error, ""); assert.equal(h.page.data.step, 30);
  choose(h); h.writeFailure = true; await save(h);
  assert.equal(h.writes.length, 1); assert.equal(h.page.data.saving, false);
  assert.match(h.toasts.at(-1), /已保存.*未记住/);
});

test("successful batch saves remember their form after unloading without updating old or reopened pages", async () => {
  const h = await setup(); choose(h);
  const p = h.page, pending = h.savePending = deferred();
  const task = save(h);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.writes.length, 1);
  p.onUnload();
  const oldData = JSON.stringify(p.data), messages = h.toasts.length;
  const reopened = await h.newPage();
  reopened.setMinimum(event("120"));
  const reopenedData = JSON.stringify(reopened.data);
  pending.resolve(); await task;
  assert.deepEqual(h.storage.get(key("admin-a")), sample());
  assert.equal(JSON.stringify(p.data), oldData);
  assert.equal(JSON.stringify(reopened.data), reopenedData, "an in-progress form is not replaced by a previous page's response");
  assert.equal(h.toasts.length, messages);
  const again = await h.newPage();
  assert.equal(again.data.step, 15); assert.equal(again.data.minDuration, "105");
  assert.deepEqual(ranges(again), sample().schedule.ranges);
});

test("an earlier successful response cannot overwrite a newer successful batch memory across page instances", async () => {
  const h = await setup(); choose(h);
  const earlier = h.savePending = deferred(), oldSave = save(h);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.writes.length, 1); h.page.onUnload();
  h.page = await h.newPage(); choose(h);
  h.page.selectProjects(event(["p2"])); h.page.pickDays(event(["2"]));
  const newer = h.savePending = deferred(), newSave = save(h);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.writes.length, 2);
  newer.resolve(); await newSave;
  const expected = { ...sample(), weekdays: [2], serviceItemIds: ["p2"] };
  assert.deepEqual(h.storage.get(key("admin-a")), expected);
  earlier.resolve(); await oldSave;
  assert.deepEqual(h.storage.get(key("admin-a")), expected);
  const again = await h.newPage();
  assert.deepEqual(plain(again.data.selectedDays), [2]);
  assert.deepEqual(plain(again.data.projectIds), ["p2"]);
});

test("a failed newer batch request does not suppress an earlier save that later succeeds after leaving", async () => {
  const h = await setup(); choose(h);
  const earlier = h.savePending = deferred(), oldSave = save(h);
  await Promise.resolve(); await Promise.resolve(); h.page.onUnload();
  h.page = await h.newPage(); choose(h);
  h.page.selectProjects(event(["p2"])); h.saveFailure = true;
  await save(h);
  assert.equal(h.storage.has(key("admin-a")), false);
  earlier.resolve(); await oldSave;
  assert.deepEqual(h.storage.get(key("admin-a")), sample());
  assert.deepEqual(plain(h.page.data.projectIds), ["p2"], "only the saved preference changes, not the current draft");
});

test("leaving before confirmation cannot save and switching login sessions cannot remember a pending save", async () => {
  const cancelled = await setup(); choose(cancelled);
  const confirmation = cancelled.page.save(); cancelled.page.onUnload();
  cancelled.modals.at(-1).success({ confirm: true }); await confirmation;
  assert.equal(cancelled.writes.length, 0); assert.equal(cancelled.storage.size, 0);
  for (const change of ["account", "session"]) {
    const h = await setup(); choose(h);
    const pending = h.savePending = deferred(), task = save(h);
    await Promise.resolve(); await Promise.resolve(); h.page.onUnload();
    if (change === "account") h.user = { id: "admin-b", role: "admin" };
    else h.token = "new-login-session";
    const messages = h.toasts.length;
    pending.resolve(); await task;
    assert.equal(h.storage.size, 0); assert.equal(h.toasts.length, messages);
  }
});

test("a failed or unreadable off-page save cannot change existing batch preferences or report into another page", async () => {
  for (const failure of ["request", "storage"]) {
    const storage = new Map([[key("admin-a"), sample()]]), h = await setup({ storage });
    h.page.selectProjects(event(["p2"]));
    let finish;
    h.savePending = { promise: new Promise((resolve, reject) => { finish = failure === "request" ? () => reject(new Error("保存失败")) : resolve; }) };
    const task = save(h);
    await Promise.resolve(); await Promise.resolve();
    h.page.onUnload(); const before = JSON.stringify(h.page.data), messages = h.toasts.length;
    if (failure === "storage") h.writeFailure = true;
    finish(); await task;
    assert.deepEqual(storage.get(key("admin-a")), sample());
    assert.equal(JSON.stringify(h.page.data), before); assert.equal(h.toasts.length, messages);
  }
});

test("a newer successful save with unavailable storage is not replaced by an older delayed response", async () => {
  const h = await setup(); choose(h);
  const earlier = h.savePending = deferred(), oldSave = save(h);
  await Promise.resolve(); await Promise.resolve(); h.page.onUnload();
  h.page = await h.newPage(); choose(h); h.page.selectProjects(event(["p2"]));
  h.savePending = null; h.writeFailure = true;
  await save(h);
  assert.match(h.toasts.at(-1), /已保存.*未记住/);
  h.writeFailure = false; earlier.resolve(); await oldSave;
  assert.equal(h.storage.size, 0, "an older form must not be presented as the latest successful form");
});

test("plus inserts locally, sorts by start time and preserves picker identities without wrapping to earlier gaps", async () => {
  const h = await setup(), p = h.page;
  p.setData({ ranges: legacyRanges.map((r, i) => ({ ...r, key: "fixture-" + i })) });
  const before = plain(p.data.ranges);
  p.addRange(row(0));
  assert.deepEqual(ranges(p), [legacyRanges[0], {startTime:"12:00",endTime:"13:30"}, legacyRanges[1], legacyRanges[2]]);
  assert.deepEqual([p.data.ranges[0].key,p.data.ranges[2].key,p.data.ranges[3].key], before.map(r => r.key));
  assert.equal(new Set(p.data.ranges.map(r => r.key)).size,4);
  p.removeRange(row(1)); assert.deepEqual(ranges(p), legacyRanges);
  p.addRange(row(2)); assert.deepEqual(ranges(p).at(-1), {startTime:"21:00",endTime:"22:30"});
  p.setData({ saving: true }); const blocked = ranges(p);
  p.addRange(row(0)); p.removeRange(row(0)); assert.deepEqual(ranges(p), blocked);
  p.setData({ saving: false, ranges: [{startTime:"00:00",endTime:"23:00"}] });
  p.addRange(row(0)); assert.deepEqual(ranges(p), [{startTime:"00:00",endTime:"23:00"},{startTime:"23:00",endTime:"23:30"}]);
  p.setData({ ranges: [{key:"existing",startTime:"09:00",endTime:"23:30"}] });
  p.addRange(row(0)); assert.equal(p.data.ranges.length,1); assert.match(h.toasts.at(-1), /此处已无/);
  p.addRange(beforeFirst()); assert.deepEqual(ranges(p)[0], {startTime:"07:30",endTime:"09:00"});
  assert.equal(p.data.ranges[1].key,"existing");
  for (const item of p.data.ranges) {
    assert.equal(p.data.times[item.startIndex],item.startTime);
    assert.equal(p.data.times[item.endIndex],item.endTime);
  }
  p.removeRange(row(0)); assert.equal(p.data.ranges[0].key,"existing");
  p.setData({ ranges: before.slice().reverse() });
  p.addRange(row(1));
  assert.deepEqual(ranges(p), [legacyRanges[0],legacyRanges[1],{startTime:"17:00",endTime:"18:30"},legacyRanges[2]]);
  assert.deepEqual([p.data.ranges[0].key,p.data.ranges[1].key,p.data.ranges[3].key],before.map(r=>r.key));
  while (p.data.ranges.length) p.removeRange(row(0));
  p.addRange(); assert.deepEqual(ranges(p), [{startTime:"09:00",endTime:"12:00"}]);
});

test("a deleted last row's delayed events cannot turn a rest day back into a working day", async () => {
  for (const singleId of ["", "t1"]) {
    const h = await setup({ singleId }), p = h.page;
    while (p.data.ranges.length > 1) p.removeRange(row(0));
    const target = { index: 0, key: p.data.ranges[0].key };
    p.removeRange({ currentTarget: { dataset: target } });
    const stalePlus = { currentTarget: { dataset: target } };
    p.addRange(stalePlus); p.removeRange(stalePlus);
    p.setTime({ currentTarget: { dataset: { ...target, field: "startTime" } }, detail: { value: 0 } });
    assert.deepEqual(ranges(p), []);
    p.setMinimum(event("invalid")); const messages = h.toasts.length;
    p.addRange(stalePlus); assert.equal(h.toasts.length, messages, "a removed row's event is ignored before validating unrelated fields");
    p.setMinimum(event("90"));
    p.addRange({ currentTarget: { dataset: {} } });
    assert.deepEqual(ranges(p), [{ startTime: "09:00", endTime: "12:00" }]);
    assert.notEqual(p.data.ranges[0].key, target.key);
    p.addRange(stalePlus); p.removeRange(stalePlus);
    assert.deepEqual(ranges(p), [{ startTime: "09:00", endTime: "12:00" }]);
  }
});

test("editing times reorders immediately and delayed row events still target the same range", async () => {
  const h = await setup(), p = h.page;
  p.setData({ ranges: legacyRanges.map((r, i) => ({ ...r, key: "fixture-" + i })) });
  const target = {index:2, key:p.data.ranges[2].key};
  const edit = (field, time, dataset = target) => p.setTime({currentTarget:{dataset:{...dataset,field}},detail:{value:p.data.times.indexOf(time)}});
  edit("startTime", "06:30");
  assert.deepEqual(ranges(p).map(r=>r.startTime), ["06:30","09:00","14:00"]);
  assert.equal(p.data.ranges[0].key,target.key);
  edit("endTime", "08:30");
  assert.deepEqual(ranges(p), [{startTime:"06:30",endTime:"08:30"},legacyRanges[0],legacyRanges[1]]);
  for (const item of p.data.ranges) {
    assert.equal(p.data.times[item.startIndex],item.startTime);
    assert.equal(p.data.times[item.endIndex],item.endTime);
  }
  p.addRange({currentTarget:{dataset:target}});
  assert.deepEqual(ranges(p), [{startTime:"06:30",endTime:"08:30"},{startTime:"08:30",endTime:"09:00"},legacyRanges[0],legacyRanges[1]]);
  p.removeRange({currentTarget:{dataset:target}});
  assert.ok(p.data.ranges.every(r=>r.key!==target.key));
  const kept = ranges(p);
  edit("startTime", "05:00");
  p.addRange({currentTarget:{dataset:target}}); p.removeRange({currentTarget:{dataset:target}});
  assert.deepEqual(ranges(p),kept,"events for a removed row cannot act on a row that inherited its index");
  p.setData({saving:true}); edit("startTime","05:00",{index:0,key:p.data.ranges[0].key});
  assert.deepEqual(ranges(p),kept);
});

test("weekly editor rejects short standalone groups but accepts a sufficient adjacent combination at every precision", async () => {
  for (const step of [10,15,30]) {
    const h = await setup(), p = h.page;
    p.allPeople(); p.allDays(); p.setStep(event(String(step)));
    p.setData({ ranges: [{startTime:"09:00",endTime:"10:00"}] });
    await p.save(); assert.equal(h.writes.length,0); assert.equal(h.modals.length,0);
    assert.match(h.toasts.at(-1), /连续排班.*90/);
    p.setData({ ranges: [{startTime:"10:00",endTime:"10:30"},{startTime:"09:00",endTime:"10:00"}] });
    await save(h); assert.equal(h.writes.length,1);
    assert.deepEqual(h.writes[0].schedule.ranges, [{startTime:"09:00",endTime:"10:00"},{startTime:"10:00",endTime:"10:30"}]);
    const restored = await setup({storage:h.storage});
    assert.equal(restored.page.data.step,step); assert.equal(restored.page.data.ranges.length,2);
  }
});

test("weekly project layout follows the day view's six-character boundary without changing selected IDs", async () => {
  const h = await setup({projects:[{id:"p1",name:"一二三四五六"},{id:"p2",name:"一二三四五六七"}]});
  assert.equal(h.page.data.projects[0].wide,false); assert.equal(h.page.data.projects[1].wide,true);
  h.page.selectProjects(event(["p2"]));
  assert.equal(h.page.data.projects[1].checked,true); assert.equal(h.page.data.projects[1].wide,true);
  const template = fs.readFileSync(path.join(root,"pages/admin/batch-slots/index.wxml"),"utf8");
  assert.doesNotMatch(template, /<switch|changeTimes|changeProjects|toggleSection/);
  const add = template.match(/<button class="add"[^>]*>/)[0];
  assert.doesNotMatch(add, /wx:if/);
  assert.match(add, /data-placement="before"/);
  assert.ok(template.indexOf(add) < template.indexOf('<view wx:for="{{ranges}}"'), "the prepend action stays above every row");
  assert.match(add, /disabled="\{\{saving \|\| \(ranges.length && ranges\[0\].startTime === '00:00'\)\}\}"/);
  assert.match(template, /disabled="\{\{saving \|\| !item.canAddAfter\}\}"/);
});

const keyedRow = (key, field) => ({ currentTarget: { dataset: { key, index: 99, field } } });
function editRange(p, key, field, time) {
  p.setTime({ ...keyedRow(key, field), detail: { value: p.data.times.indexOf(time) } });
}
function seedRanges(p, pairs) {
  p.setData({ ranges: pairs.map(([startTime, endTime], i) => ({ key: "test-row-" + i, startTime, endTime })) });
}

test("middle insertions use the minimum while final-row additions inherit duration at each precision", async () => {
  for (const step of [10, 15, 30]) {
    const h = await setup(), p = h.page;
    p.setStep(event(String(step))); p.setData({ ranges: [] });
    p.addRange(); assert.deepEqual(ranges(p), [{ startTime: "09:00", endTime: "12:00" }]);
    p.addRange(keyedRow(p.data.ranges[0].key));
    assert.deepEqual(ranges(p).at(-1), { startTime: "14:00", endTime: "17:00" });
    p.addRange(keyedRow(p.data.ranges[1].key));
    assert.deepEqual(ranges(p).at(-1), { startTime: "19:00", endTime: "22:00" });

    seedRanges(p, [["09:00", "11:00"], ["14:00", "17:00"]]);
    p.addRange(keyedRow("test-row-0"));
    assert.deepEqual(ranges(p), [{ startTime: "09:00", endTime: "11:00" },
      { startTime: "11:00", endTime: "12:30" }, { startTime: "14:00", endTime: "17:00" }]);

    seedRanges(p, [["09:00", "12:00"], ["14:00", "17:00"]]);
    p.addRange(keyedRow("test-row-0"));
    assert.deepEqual(ranges(p)[1], { startTime: "12:00", endTime: "13:30" }, "a two-hour gap uses 90 minutes, not its full length");

    seedRanges(p, [["09:00", "12:00"], ["12:30", "17:00"]]);
    p.addRange(keyedRow("test-row-0"));
    assert.deepEqual(ranges(p)[1], { startTime: "12:00", endTime: "12:30" }, "a short local gap is filled instead of searching another gap");
    for (const item of p.data.ranges) {
      assert.equal(p.data.times[item.startIndex], item.startTime);
      assert.equal(p.data.times[item.endIndex], item.endTime);
    }
  }
});

test("weekly and batch middle insertions use the configured minimum even in a large gap and keep row identities", async () => {
  for (const singleId of ["", "t1"]) {
    const h = await setup({ singleId }), p = h.page;
    for (const step of [10, 15, 30]) {
      p.setStep(event(String(step)));
      for (const [minimum, expectedEnd] of [[90, "13:30"], [120, "14:00"]]) {
        p.setMinimum(event(String(minimum)));
        seedRanges(p, [["09:00", "12:00"], ["17:00", "20:00"]]);
        p.addRange(keyedRow("test-row-0"));
        assert.deepEqual(ranges(p), [{ startTime: "09:00", endTime: "12:00" },
          { startTime: "12:00", endTime: expectedEnd }, { startTime: "17:00", endTime: "20:00" }]);
        const insertedKey = p.data.ranges[1].key;
        assert.equal(p.data.ranges[0].key, "test-row-0");
        assert.equal(p.data.ranges[2].key, "test-row-1");
        // Stale indices must still target the original later row after insertion and sorting.
        editRange(p, "test-row-1", "endTime", "21:00");
        p.removeRange(keyedRow(insertedKey));
        assert.deepEqual(ranges(p), [{ startTime: "09:00", endTime: "12:00" },
          { startTime: "17:00", endTime: "21:00" }]);
        assert.equal(h.storage.size, 0, "editing alone must not replace any account's saved prefill");
      }
    }
  }
});

test("empty additions honor a larger minimum while invalid existing drafts cannot generate more ranges", async () => {
  const h = await setup(), p = h.page;
  p.setData({ ranges: [] }); p.setMinimum(event("240")); p.addRange();
  assert.deepEqual(ranges(p), [{ startTime: "09:00", endTime: "13:00" }]);
  p.setMinimum(event("90")); seedRanges(p, [["09:00", "10:00"]]); p.addRange(keyedRow("test-row-0"));
  assert.deepEqual(ranges(p), [{ startTime: "09:00", endTime: "10:00" }]);
  assert.match(h.toasts.at(-1), /连续排班.*90/);
  p.setData({ ranges: [] }); p.setMinimum(event("1440")); p.addRange();
  assert.deepEqual(ranges(p), []); assert.match(h.toasts.at(-1), /09:00后不足/);
  p.setMinimum(event("90"));
  for (const pairs of [ [["00:00", "23:30"]], [["09:00", "12:00"], ["11:00", "14:00"]] ]) {
    seedRanges(p, pairs); const before = ranges(p); p.addRange(keyedRow("test-row-0"));
    assert.deepEqual(ranges(p), before);
  }
});

test("prepend, between and append use only their own space at all precisions in both editors", async () => {
  const { normalizeSchedule } = require("../src/utils/schedule");
  const time = n => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
  for (const singleId of ["", "t1"]) for (const step of [10, 15, 30]) {
    const h = await setup({ singleId }), p = h.page;
    p.setStep(event(String(step))); p.setMinimum(event("90"));
    const lastMinute = 1440 - step, last = time(lastMinute);
    const exactPreviousEnd = 18 * 60 - (lastMinute - 22 * 60);
    const cases = [
      ["head inherits the first gap and duration", [["09:00","12:00"],["14:00","17:00"]], "before", ["04:00","07:00"]],
      ["head fits exactly at midnight", [["05:00","08:00"],["10:00","13:00"]], "before", ["00:00","03:00"]],
      ["head falls back to an adjacent minimum", [["04:00","07:00"],["09:00","12:00"]], "before", ["02:30","04:00"]],
      ["head fills a short boundary remainder", [["01:00","04:00"],["06:00","09:00"]], "before", ["00:00","01:00"]],
      ["one row uses a two-hour head gap", [["09:00","12:00"]], "before", ["04:00","07:00"]],
      ["one row uses a two-hour tail gap", [["09:00","12:00"]], 0, ["14:00","17:00"]],
      ["middle fills a gap shorter than the minimum", [["09:00","10:30"],["11:00","12:30"]], 0, ["10:30","11:00"]],
      ["middle fits the minimum exactly", [["09:00","10:30"],["12:00","14:00"]], 0, ["10:30","12:00"]],
      ["tail inherits a non-default interval and its own duration", [["08:00","09:30"],["10:00","12:00"]], 1, ["12:30","14:30"]],
      ["zero gap is inherited at the head", [["09:00","10:30"],["10:30","12:00"]], "before", ["07:30","09:00"]],
      ["zero gap is inherited at the tail", [["09:00","10:30"],["10:30","12:00"]], 1, ["12:00","13:30"]],
      ["tail fits exactly at the last legal grid", [[time(exactPreviousEnd - 120),time(exactPreviousEnd)],["18:00","20:00"]], 1, [time(lastMinute - 120),last]],
      ["tail falls back to an adjacent minimum", [["18:00","21:00"]], 0, ["21:00","22:30"]],
      ["tail fills a short boundary remainder", [["21:00","23:00"]], 0, ["23:00",last]],
      ["no head space does not append instead", [["00:00","03:00"],["06:00","09:00"]], "before", null],
      ["no middle space does not search elsewhere", [["09:00","10:30"],["10:30","12:00"]], 0, null],
      ["no tail space does not wrap to midnight", [["09:00",last]], 0, null]
    ];
    for (const [label, initial, action, added] of cases) {
      seedRanges(p, initial); const oldKeys = p.data.ranges.map(r => r.key);
      const expected = initial.map(([startTime,endTime]) => ({startTime,endTime}));
      if (added) expected.push({startTime:added[0],endTime:added[1]});
      expected.sort((a,b) => a.startTime.localeCompare(b.startTime));
      p.addRange(action === "before" ? beforeFirst() : keyedRow(oldKeys[action]));
      assert.deepEqual(ranges(p), expected, `${singleId || "batch"}/${step}: ${label}`);
      assert.doesNotThrow(() => normalizeSchedule({step, minDuration:90, ranges:ranges(p)}), label);
      for (const [i, oldKey] of oldKeys.entries()) {
        const kept = p.data.ranges.find(r => r.key === oldKey);
        assert.equal(kept.startTime, initial[i][0]); assert.equal(kept.endTime, initial[i][1]);
      }
      if (added) {
        for (const [i, item] of p.data.ranges.entries()) {
          assert.equal(p.data.times[item.startIndex], item.startTime);
          assert.equal(p.data.times[item.endIndex], item.endTime);
          assert.equal(item.canAddAfter, item.endTime < (expected[i + 1] ? expected[i + 1].startTime : last));
        }
      } else assert.match(h.toasts.at(-1), /此处已无/);
    }
    // Neither entrance may use an invalid draft as a timing pattern.
    for (const invalid of [
      [["09:00","10:00"]], [["09:00","12:00"],["11:00","14:00"]],
      [["09:01","12:00"]], [["12:00","09:00"]]
    ]) {
      seedRanges(p, invalid); const before = plain(p.data);
      p.addRange(beforeFirst()); p.addRange(keyedRow("test-row-0"));
      assert.deepEqual(plain(p.data), before);
    }
  }
});

test("short inserted rows keep merged-duration validation and successful account-specific prefill", async () => {
  const { normalizeSchedule } = require("../src/utils/schedule");
  const h = await setup(), p = h.page; p.allPeople(); p.allDays();
  seedRanges(p, [["09:00","10:30"],["11:00","12:30"]]);
  p.addRange(keyedRow("test-row-0"));
  const submitted = ranges(p), shortKey = p.data.ranges[1].key;
  assert.equal(p.data.ranges[0].canAddAfter, false);
  assert.equal(p.data.ranges[1].canAddAfter, false);
  assert.deepEqual(normalizeSchedule({step:30,minDuration:90,ranges:submitted}).ranges,
    [{startTime:"09:00",endTime:"12:30"}]);
  h.saveFailure = true; await save(h);
  assert.deepEqual(ranges(p), submitted); assert.equal(h.storage.size, 0);
  h.saveFailure = false; await save(h);
  assert.deepEqual(h.storage.get(key("admin-a")).schedule.ranges, submitted);
  const restored = await h.newPage(); assert.deepEqual(ranges(restored), submitted);
  restored.addRange(beforeFirst());
  assert.deepEqual(ranges(restored)[0], {startTime:"07:30",endTime:"09:00"}, "adjacent rows preserve a zero-minute pattern after prefill");
  assert.deepEqual(h.storage.get(key("admin-a")).schedule.ranges, submitted, "unsaved additions do not replace successful prefill");
  // If the long neighbours are removed, the short row remains an invalid standalone draft.
  p.removeRange(keyedRow("test-row-0")); p.removeRange(keyedRow("test-row-1"));
  const notices = h.modals.length; await p.save();
  assert.equal(h.modals.length, notices); assert.equal(p.data.ranges[0].key, shortKey);
  assert.match(h.toasts.at(-1), /连续排班.*90/);
  assert.deepEqual(h.storage.get(key("admin-a")).schedule.ranges, submitted);
  h.user = {id:"admin-b",role:"admin"}; await restored.onShow();
  assert.deepEqual(ranges(restored), defaults); assert.equal(h.storage.has(key("admin-b")), false);
});

test("prepend sorting preserves stable row editing and deletion, including late events for removed rows", async () => {
  for (const singleId of ["", "t1"]) {
    const h = await setup({singleId}), p = h.page;
    p.setStep(event("30")); p.setMinimum(event("90"));
    seedRanges(p, [["09:00","12:00"],["14:00","17:00"]]);
    const delayedEdit = plain(formEvents.formEvent(p, {
      ...keyedRow("test-row-0", "endTime"), detail: {value:p.data.times.indexOf("11:00")}
    }));
    p.addRange(beforeFirst()); p.setTime(delayedEdit);
    assert.deepEqual(ranges(p), [{startTime:"04:00",endTime:"07:00"},
      {startTime:"09:00",endTime:"11:00"},{startTime:"14:00",endTime:"17:00"}]);
    p.removeRange(keyedRow("test-row-0")); const before = plain(p.data);
    p.setTime(delayedEdit); p.addRange(keyedRow("test-row-0")); p.removeRange(keyedRow("test-row-0"));
    assert.deepEqual(plain(p.data), before);
  }
});

test("manual start/end changes preserve valid durations and repair short, equal or reversed ranges to the minimum", async () => {
  for (const singleId of ["", "t1"]) {
    const h = await setup({ singleId }), p = h.page;
    p.setMinimum(event("90"));
    for (const step of [10, 15, 30]) {
      p.setStep(event(String(step)));
      for (const [field, time, start, end] of [
        ["startTime", "10:00", "10:00", "12:00"],
        ["startTime", "11:00", "11:00", "12:30"],
        ["startTime", "12:00", "12:00", "13:30"],
        ["startTime", "13:00", "13:00", "14:30"],
        ["endTime", "11:00", "09:00", "11:00"],
        ["endTime", "10:00", "08:30", "10:00"],
        ["endTime", "09:00", "07:30", "09:00"],
        ["endTime", "08:00", "06:30", "08:00"]
      ]) {
        seedRanges(p, [["09:00", "12:00"]]); editRange(p, "test-row-0", field, time);
        assert.deepEqual(ranges(p), [{ startTime: start, endTime: end }], `${singleId || "batch"}/${step}/${field}/${time}`);
        assert.equal(p.data.ranges[0].key, "test-row-0");
        assert.equal(p.data.times[p.data.ranges[0].startIndex], start);
        assert.equal(p.data.times[p.data.ranges[0].endIndex], end);
      }
    }
  }
});

test("manual time correction respects midnight and the final grid point without moving the explicitly selected endpoint", async () => {
  const h = await setup(), p = h.page;
  const time = minute => String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
  for (const step of [10, 15, 30]) {
    p.setStep(event(String(step)));
    const last = 1440 - step;
    seedRanges(p, [["09:00", "12:00"]]);
    editRange(p, "test-row-0", "startTime", time(last - 90));
    assert.deepEqual(ranges(p), [{ startTime: time(last - 90), endTime: time(last) }]);
    const before = plain(p.data.ranges);
    editRange(p, "test-row-0", "startTime", time(last - 90 + step));
    assert.deepEqual(plain(p.data.ranges), before); assert.match(h.toasts.at(-1), /边界.*不足.*90.*分钟/);
    seedRanges(p, [["09:00", "12:00"]]); editRange(p, "test-row-0", "endTime", "01:30");
    assert.deepEqual(ranges(p), [{ startTime: "00:00", endTime: "01:30" }]);
    editRange(p, "test-row-0", "endTime", time(90 - step));
    assert.deepEqual(ranges(p), [{ startTime: "00:00", endTime: "01:30" }]);
  }
  seedRanges(p, [["09:00", "12:00"]]); p.setMinimum(event("invalid"));
  editRange(p, "test-row-0", "startTime", "13:00");
  assert.deepEqual(ranges(p), [{ startTime: "09:00", endTime: "12:00" }]);
});

test("automatic start correction reorders by stable IDs, keeps overlapping drafts visible, and preserves per-account saved memory", async () => {
  const h = await setup(), p = h.page;
  p.allPeople(); p.allDays(); p.selectProjects(event(["p2"]));
  const target = p.data.ranges[2].key, untouched = plain(p.data.ranges.slice(0, 2).map(r => r.key));
  editRange(p, target, "endTime", "08:00"); // Automatically moves 19:00 back to 06:30.
  assert.equal(p.data.ranges[0].key, target);
  assert.deepEqual(ranges(p)[0], { startTime: "06:30", endTime: "08:00" });
  p.addRange(keyedRow(target));
  assert.deepEqual(ranges(p)[1], { startTime: "08:00", endTime: "09:00" });
  p.removeRange(keyedRow(target));
  assert.deepEqual([p.data.ranges[1].key, p.data.ranges[2].key], untouched);
  const expected = ranges(p);
  editRange(p, target, "startTime", "01:00"); p.addRange(keyedRow(target)); p.removeRange(keyedRow(target));
  assert.deepEqual(ranges(p), expected);
  await save(h);
  const remembered = plain(h.storage.get(key("admin-a")));
  assert.deepEqual(remembered.schedule.ranges, expected);
  const again = await h.newPage(); assert.deepEqual(ranges(again), expected);
  editRange(again, again.data.ranges[0].key, "startTime", "10:30");
  assert.match(h.toasts.at(-1), /重叠/);
  const modalCount = h.modals.length;
  await again.save(); assert.equal(h.modals.length, modalCount);
  assert.deepEqual(h.storage.get(key("admin-a")), remembered);
  const staleKey = again.data.ranges[0].key;
  h.user = { id: "admin-b", role: "admin" }; await again.onShow();
  editRange(again, staleKey, "endTime", "08:00"); again.removeRange(keyedRow(staleKey)); again.addRange(keyedRow(staleKey));
  assert.deepEqual(ranges(again), defaults); assert.equal(h.storage.has(key("admin-b")), false);
  again.onUnload(); const afterUnload = plain(again.data);
  editRange(again, again.data.ranges[0].key, "endTime", "08:00"); again.addRange(keyedRow(again.data.ranges[0].key));
  assert.deepEqual(plain(again.data), afterUnload);
});

function captureFormActions(p) {
  const first = p.data.ranges[0];
  const values = {
    setMinimum: event("180"), selectProjects: event(["p1"]), selectPeople: event(["t1"]),
    pickDays: event(["7"]), setStep: event("10"), pickWeekday: { currentTarget: { dataset: { day: 7 } } },
    setTime: { currentTarget: { dataset: { key: first && first.key, field: "endTime" } }, detail: { value: 0 } },
    removeRange: keyedRow(first && first.key), addRange: keyedRow(first && first.key)
  };
  return formEvents.handlers.map(name => [name, plain(formEvents.formEvent(p, values[name]))])
    .concat([["addRange", plain(formEvents.formEvent(p, beforeFirst()))]]);
}

async function replay(p, actions) { for (const [name, event] of actions) await p[name](event); }

test("all native form bindings carry a version and unversioned events cannot mutate or submit the form", async () => {
  const template = fs.readFileSync(path.join(root, "pages/admin/batch-slots/index.wxml"), "utf8");
  for (const name of formEvents.handlers) {
    const tags = template.match(new RegExp('<[^>]+bind(?:tap|input|change)="' + name + '"[^>]*>', "g"));
    assert.ok(tags && tags.length, name);
    for (const tag of tags) assert.match(tag, /data-form-version="\{\{formVersion\}\}"/, name);
  }
  const h = await setup(); choose(h);
  const p = h.page, before = plain(p.data), actions = captureFormActions(p), raw = h.rawHandlers.get(p);
  for (const [name, action] of actions) {
    delete action.currentTarget.dataset.formVersion;
    await raw[name](action);
  }
  assert.deepEqual(plain(p.data), before);
  assert.equal(h.modals.length, 0); assert.equal(h.writes.length, 0);
});

test("old account events cannot change loading or restored fields, save targets, or the next account's prefill", async () => {
  const b = { ...sample(), therapistIds: ["t2"], weekdays: [2], serviceItemIds: ["p2"],
    schedule: { step: 30, minDuration: 90, ranges: defaults } };
  const h = await setup({ storage: new Map([[key("admin-b"), b]]) }), p = h.page;
  const stale = captureFormActions(p);
  h.user = { id: "admin-b", role: "admin" }; h.token = "session-b";
  const pending = h.peoplePending = deferred(), loading = p.onShow();
  const during = plain(p.data); await replay(p, stale); assert.deepEqual(plain(p.data), during);
  pending.resolve({ therapists: h.therapists }); await loading; h.peoplePending = null;
  const restored = plain(p.data); await replay(p, stale);
  assert.deepEqual(plain(p.data), restored); assert.deepEqual(h.storage.get(key("admin-b")), b);
  assert.equal(h.modals.length, 0); assert.equal(h.writes.length, 0);
  p.setMinimum(event("120")); p.selectProjects(event(["p2"])); await save(h);
  assert.equal(h.writes[0].schedule.minDuration, 120);
  assert.deepEqual(h.writes[0].therapistIds, ["t2"]); assert.deepEqual(h.writes[0].weekdays, [2]);
  assert.deepEqual(h.writes[0].serviceItemIds, ["p2"]);
  assert.equal(h.storage.get(key("admin-b")).schedule.minDuration, 120);
  assert.equal(h.storage.has(key("admin-a")), false);
});

test("weekday changes and retries invalidate old field and navigation events even after returning to the original weekday", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page, oldMonday = captureFormActions(p);
  const pending = h.weekPending = deferred();
  const switching = p.pickWeekday({ currentTarget: { dataset: { day: 2 } } });
  const during = plain(p.data); await replay(p, oldMonday); assert.deepEqual(plain(p.data), during);
  pending.resolve({ step: 30, minDuration: 120, ranges: defaults, serviceItemIds: ["p2"] });
  await switching; h.weekPending = null;
  const tuesday = plain(p.data); await replay(p, oldMonday); assert.deepEqual(plain(p.data), tuesday);
  const oldTuesday = captureFormActions(p);
  await p.pickWeekday({ currentTarget: { dataset: { day: 1 } } });
  const monday = plain(p.data); await replay(p, oldMonday); await replay(p, oldTuesday);
  assert.deepEqual(plain(p.data), monday); assert.equal(h.modals.length, 0);
  p.setMinimum(event("120")); p.selectProjects(event(["p1"])); await save(h);
  assert.equal(h.weekWrites[0].days[0].schedule.minDuration, 120); assert.equal(h.weekWrites[0].days[0].weekday, 1);
  assert.deepEqual(h.weekWrites[0].days[0].serviceItemIds, ["p1"]); assert.equal(h.storage.size, 0);
  const beforeFailure = captureFormActions(p); h.weekFailure = true;
  await p.pickWeekday({ currentTarget: { dataset: { day: 4 } } });
  const failed = plain(p.data); await replay(p, beforeFailure); assert.deepEqual(plain(p.data), failed);
  p.setMinimum(event("180")); assert.equal(p.data.minDuration, failed.minDuration, "failed pages cannot edit stale fields");
  h.weekFailure = false; await p.retry(); assert.equal(p.data.error, "");
  const afterRetry = plain(p.data); await replay(p, beforeFailure); assert.deepEqual(plain(p.data), afterRetry);
});

test("same-account relogin, hide/return and unload reject old events without clearing current drafts", async () => {
  const h = await setup(), p = h.page;
  choose(h); await save(h); const remembered = plain(h.storage.get(key("admin-a")));
  const previousLogin = captureFormActions(p); h.token = "new-session-same-admin"; await p.onShow();
  const restored = plain(p.data); await replay(p, previousLogin); assert.deepEqual(plain(p.data), restored);
  p.setMinimum(event("120")); const oldVisible = captureFormActions(p), draft = ranges(p);
  p.onHide(); const hidden = plain(p.data);
  await replay(p, oldVisible); await replay(p, captureFormActions(p)); assert.deepEqual(plain(p.data), hidden);
  await p.onShow(); const shown = plain(p.data); await replay(p, oldVisible); assert.deepEqual(plain(p.data), shown);
  assert.equal(p.data.minDuration, "120"); assert.deepEqual(ranges(p), draft);
  p.setMinimum(event("135")); assert.equal(p.data.minDuration, "135");
  p.onUnload(); const unloaded = plain(p.data); await replay(p, captureFormActions(p)); assert.deepEqual(plain(p.data), unloaded);
  assert.deepEqual(h.storage.get(key("admin-a")), remembered, "unsaved drafts never replace successful prefill");
});

test("confirmation and request completion reject delayed input while an already submitted save still survives leaving", async () => {
  const h = await setup(); choose(h); const p = h.page, beforeSaving = captureFormActions(p);
  const waiting = p.save(), duringConfirmation = captureFormActions(p), confirming = plain(p.data);
  await replay(p, beforeSaving); await replay(p, duringConfirmation); assert.deepEqual(plain(p.data), confirming);
  p.onHide(); await p.onShow(); h.modals.at(-1).success({ confirm: true }); await waiting;
  assert.equal(h.writes.length, 0, "leaving before confirmation cannot submit even after returning");
  assert.equal(p.data.saving, false);
  const afterCancel = plain(p.data); await replay(p, duringConfirmation); assert.deepEqual(plain(p.data), afterCancel);

  const pending = h.savePending = deferred(), saved = save(h);
  await Promise.resolve(); await Promise.resolve(); assert.equal(h.writes.length, 1);
  const duringRequest = captureFormActions(p), payload = plain(h.writes[0]);
  p.onHide(); await replay(p, duringRequest); p.onUnload();
  const oldPage = plain(p.data), messages = h.toasts.length, next = await h.newPage();
  next.setMinimum(event("120")); const nextDraft = plain(next.data);
  pending.resolve(); await saved;
  assert.deepEqual(plain(p.data), oldPage); assert.deepEqual(plain(next.data), nextDraft);
  assert.equal(h.toasts.length, messages);
  assert.deepEqual(h.storage.get(key("admin-a")), { version: 2, ...payload });
});

test("saving completion and precision changes invalidate obsolete control events but preserve sorted row identity", async () => {
  const h = await setup(); choose(h); const p = h.page;
  const saving = p.save(), stale = captureFormActions(p);
  h.modals.at(-1).success({ confirm: false }); await saving;
  const afterSaving = plain(p.data); await replay(p, stale); assert.deepEqual(plain(p.data), afterSaving);
  const first = p.data.ranges[0].key;
  const oldPicker = plain(formEvents.formEvent(p, {
    currentTarget: { dataset: { key: first, field: "startTime" } }, detail: { value: p.data.times.indexOf("09:00") }
  }));
  p.setStep(event("30")); const afterStep = plain(p.data); p.setTime(oldPicker); assert.deepEqual(plain(p.data), afterStep);
  p.setMinimum(event("90")); editRange(p, first, "endTime", "12:00");
  p.addRange(keyedRow(first)); const second = p.data.ranges[1].key;
  const deferredEnd = plain(formEvents.formEvent(p, {
    currentTarget: { dataset: { key: second, index: 1, field: "endTime" } }, detail: { value: p.data.times.indexOf("08:00") }
  }));
  editRange(p, second, "startTime", "06:00");
  p.setTime(deferredEnd);
  assert.equal(p.data.ranges[0].key, second); assert.equal(p.data.ranges[0].endTime, "08:00");
  assert.equal(p.data.ranges[1].key, first);
});

test("an already submitted save can finish while hidden and remains editable on return without stale events or notices", async () => {
  for (const fail of [false, true]) {
    const h = await setup(); choose(h); const p = h.page;
    let finish;
    h.savePending = { promise: new Promise((resolve, reject) => { finish = fail ? () => reject(new Error("保存失败")) : resolve; }) };
    const saving = save(h); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.writes.length, 1);
    const submitted = plain(h.writes[0]), stale = captureFormActions(p), messages = h.toasts.length;
    p.onHide(); finish(); await saving;
    assert.equal(p.data.saving, false); assert.equal(h.toasts.length, messages);
    assert.equal(h.storage.has(key("admin-a")), !fail);
    if (!fail) assert.deepEqual(h.storage.get(key("admin-a")), { version: 2, ...submitted });
    await p.onShow(); const returned = plain(p.data); await replay(p, stale); assert.deepEqual(plain(p.data), returned);
    p.setMinimum(event("120")); assert.equal(p.data.minDuration, "120");
  }
});

const dayTap = day => ({ currentTarget: { dataset: { day } } });

test("project select-all selects every active option without toggling off or saving automatically", async () => {
  for (const singleId of ["", "t1"]) {
    const h = await setup({ singleId }), p = h.page;
    const selectAll = () => p.allProjects(formEvents.formEvent(p));
    selectAll(); selectAll();
    assert.deepEqual(plain(p.data.projectIds), ["p1", "p2"]);
    assert.ok(p.data.projects.every(item => item.checked));
    p.selectProjects(event(["p2"]));
    assert.equal(p.data.projects[0].checked, false);
    selectAll();
    assert.equal(h.writes.length + h.weekWrites.length, 0, "select-all only changes the draft");
    if (!singleId) { p.allPeople(); p.allDays(); }
    await save(h);
    assert.deepEqual(singleId ? h.weekWrites[0].days[0].serviceItemIds : h.writes[0].serviceItemIds, ["p1", "p2"]);
    assert.equal(h.nativeLeaveAlert, false, "success removes the native return warning");
  }
  const empty = await setup({ projects: [] });
  empty.page.allProjects(formEvents.formEvent(empty.page));
  assert.deepEqual(plain(empty.page.data.projectIds), []);
  assert.equal(empty.writes.length, 0);
});

test("a delayed native enable cannot restore the unsaved warning after a weekly save", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  h.deferAlerts = true;
  p.setMinimum(event("120"));
  const delayedEnable = h.alertRequests.at(-1);
  await save(h);
  assert.deepEqual(plain(p.data.dirtyDays), []);
  h.alertRequests.at(-1).finish();
  h.deferAlerts = false;
  delayedEnable.finish();
  assert.equal(h.nativeLeaveAlert, false, "return must not warn after a successful save");
  p.setMinimum(event("150"));
  assert.equal(h.nativeLeaveAlert, true, "new unsaved edits must still warn");
  h.saveFailure = true; await save(h);
  assert.equal(h.nativeLeaveAlert, true, "failed saves must retain the warning and draft");
  assert.equal(h.weekWrites.length, 2, "the second valid draft reached the failing save request");
});

test("a delayed native disable cannot remove the warning for subsequent unsaved edits", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  p.setMinimum(event("120")); h.deferAlerts = true;
  await save(h);
  const delayedDisable = h.alertRequests.at(-1);
  h.deferAlerts = false; p.setMinimum(event("130"));
  delayedDisable.finish();
  assert.equal(h.nativeLeaveAlert, true);
  assert.deepEqual(plain(p.data.dirtyDays), [1]);
  assert.equal(p.data.minDuration, "130");
});

test("obsolete native callbacks cannot issue commands from hidden, unloaded or previous-account pages", async () => {
  for (const boundary of ["hide", "unload", "account"]) {
    const h = await setup({ singleId: "t1" }), p = h.page;
    h.deferAlerts = true; p.setMinimum(event("120"));
    const delayedEnable = h.alertRequests.at(-1);
    if (boundary === "hide") p.onHide();
    else if (boundary === "unload") { p.onHide(); p.onUnload(); }
    else { h.user = { id: "admin-b", role: "admin" }; h.token = "session-b"; await p.onShow(); }
    const alerts = h.alerts.length, before = plain(p.data);
    delayedEnable.finish();
    assert.equal(h.alerts.length, alerts);
    assert.deepEqual(plain(p.data), before);
  }
});

test("returning after an off-page successful save clears a native warning whose earlier disable failed", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  p.setMinimum(event("120"));
  const pending = h.savePending = deferred(), saving = save(h);
  await Promise.resolve(); await Promise.resolve();
  h.deferAlerts = true; p.onHide();
  h.alertRequests.at(-1).finish(false);
  assert.equal(h.nativeLeaveAlert, true);
  const alerts = h.alerts.length;
  pending.resolve(); await saving;
  assert.equal(h.alerts.length, alerts, "hidden completion cannot alter another page's native warning");
  h.deferAlerts = false; await p.onShow();
  assert.equal(h.nativeLeaveAlert, false);
  assert.equal(p.data.dirtyDays.length, 0);
});

test("batch entry and saved batch form clear stale native warnings without changing account prefill", async () => {
  const h = await setup(); h.nativeLeaveAlert = true;
  await h.page.onShow();
  assert.equal(h.nativeLeaveAlert, false);
  choose(h); h.nativeLeaveAlert = true; await save(h);
  assert.equal(h.nativeLeaveAlert, false);
  assert.deepEqual(h.storage.get(key("admin-a")), sample());
});

test("single weekly editor keeps separate weekday drafts and submits only changed days once", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  await p.save(); assert.equal(h.modals.length, 0, "an unchanged week has nothing to submit");
  p.setMinimum(event("120")); p.selectProjects(event(["p1"]));
  const mondayKey = p.data.ranges[0].key, stale = captureFormActions(p);
  h.rules[2] = { step: 30, minDuration: 90, ranges: defaults, serviceItemIds: ["p2"] };
  await p.pickWeekday(dayTap(2)); p.setMinimum(event("120"));
  h.rules[3] = { step: 30, minDuration: 90, ranges: [], serviceItemIds: [] };
  await p.pickWeekday(dayTap(3)); assert.equal(p.data.ranges.length, 0);
  assert.deepEqual(plain(p.data.dirtyDays), [1, 2]);
  await p.pickWeekday(dayTap(1)); const returned = plain(p.data);
  assert.equal(p.data.minDuration, "120"); assert.equal(p.data.ranges[0].key, mondayKey);
  await replay(p, stale); assert.deepEqual(plain(p.data), returned);
  assert.deepEqual(h.reads, [["t1", 1], ["t1", 2], ["t1", 3]], "revisiting a draft must not read over it");
  await save(h);
  assert.equal(h.weekWrites.length, 1); assert.equal(h.writes.length, 0);
  assert.deepEqual(h.weekWrites[0].days.map(day => [day.weekday, day.schedule.minDuration, day.serviceItemIds]), [[1, 120, ["p1"]], [2, 120, ["p2"]]]);
  assert.match(h.modals[0].content, /周一、周二/); assert.doesNotMatch(h.modals[0].content, /周三/);
  assert.equal(p.data.dirtyDays.length, 0); assert.equal(h.storage.size, 0);
  await p.save(); assert.equal(h.weekWrites.length, 1);
  assert.equal(h.alerts.at(-1)[0], "disable");
});

test("local insertions survive weekday changes and failed multi-day saves without becoming batch prefill", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  p.setStep(event("30")); p.setMinimum(event("90"));
  seedRanges(p, [["09:00","10:30"],["11:00","12:30"]]);
  p.addRange(keyedRow("test-row-0"));
  const monday = plain(p.data.ranges), mondayEvents = captureFormActions(p);
  h.rules[2] = { step:30, minDuration:90, ranges:[{startTime:"01:00",endTime:"04:00"}], serviceItemIds:["p1"] };
  h.rules[3] = { step:30, minDuration:90, ranges:defaults, serviceItemIds:[] };
  await p.pickWeekday(dayTap(2)); p.addRange(beforeFirst());
  const tuesday = plain(p.data.ranges), tuesdayEvents = captureFormActions(p);
  assert.deepEqual(ranges(p), [{startTime:"00:00",endTime:"01:00"},{startTime:"01:00",endTime:"04:00"}]);
  p.onHide(); await p.onShow(); const afterReturn = plain(p.data);
  await replay(p, tuesdayEvents); assert.deepEqual(plain(p.data), afterReturn);
  await p.pickWeekday(dayTap(3)); assert.deepEqual(plain(p.data.dirtyDays), [1,2]);
  await p.pickWeekday(dayTap(1)); const active = plain(p.data);
  await replay(p, mondayEvents); assert.deepEqual(plain(p.data), active);
  assert.deepEqual(plain(p.data.ranges), monday);
  h.saveFailure = true; await save(h);
  assert.deepEqual(plain(p.data.dirtyDays), [1,2]); assert.deepEqual(plain(p.data.ranges), monday);
  await p.pickWeekday(dayTap(2)); assert.deepEqual(plain(p.data.ranges), tuesday);
  h.saveFailure = false; await save(h);
  assert.equal(h.weekWrites.length, 2);
  assert.deepEqual(h.weekWrites[0], h.weekWrites[1], "retry submits the same two preserved drafts");
  assert.deepEqual(h.weekWrites[1].days.map(day => day.weekday), [1,2]);
  const { normalizeSchedule } = require("../src/utils/schedule");
  assert.deepEqual(h.weekWrites[1].days.map(day => normalizeSchedule(day.schedule).ranges), [
    [{startTime:"09:00",endTime:"12:30"}], [{startTime:"00:00",endTime:"04:00"}]
  ]);
  assert.deepEqual(plain(p.data.dirtyDays), []); assert.equal(h.storage.size, 0);
});

test("reverting weekly changes removes the unsaved marker and return warning without a server write", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  p.setMinimum(event("120")); assert.deepEqual(plain(p.data.dirtyDays), [1]);
  assert.ok(p.data.weekdays[0].dirty); assert.equal(h.alerts.at(-1)[0], "enable");
  p.setMinimum(event("100")); assert.deepEqual(plain(p.data.dirtyDays), []);
  assert.equal(h.alerts.at(-1)[0], "disable");
  p.selectProjects(event(["p1", "p2"])); p.selectProjects(event(["p2"]));
  await p.save(); assert.equal(h.modals.length, 0);
  p.onHide(); p.onUnload(); assert.equal(h.weekWrites.length, 0);
});

test("adjacent rows equal to the original interval still require correction when a precision switch leaves an invalid inner endpoint", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  h.rules[2] = { step: 30, minDuration: 90, ranges: [{ startTime: "09:00", endTime: "12:00" }], serviceItemIds: [] };
  await p.pickWeekday(dayTap(2)); p.setStep(event("10")); p.setMinimum(event("30"));
  const first = p.data.ranges[0].key;
  editRange(p, first, "endTime", "10:10"); p.addRange(keyedRow(first));
  const second = p.data.ranges[1].key;
  editRange(p, second, "startTime", "10:10"); editRange(p, second, "endTime", "12:00");
  p.setStep(event("30")); p.setMinimum(event("90"));
  assert.deepEqual(plain(p.data.dirtyDays), [2]); await p.save();
  assert.equal(h.modals.length, 0); assert.match(p.data.weekNotice, /周二.*精度/);
  editRange(p, first, "endTime", "10:30"); editRange(p, second, "startTime", "10:30");
  assert.equal(p.data.weekNotice, "");
  assert.deepEqual(plain(p.data.dirtyDays), []); await p.save(); assert.equal(h.weekWrites.length, 0);
});

test("a nonvisible weekday validation error preserves every draft and prevents partial submission", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  p.setMinimum(event("91")); await p.pickWeekday(dayTap(4)); p.selectProjects(event(["p1"]));
  await p.save(); assert.equal(h.modals.length, 0); assert.equal(h.weekWrites.length, 0);
  assert.match(p.data.weekNotice, /周一.*正整数倍/); assert.deepEqual(plain(p.data.dirtyDays), [1, 4]);
  await p.pickWeekday(dayTap(1)); assert.equal(p.data.minDuration, "91");
  p.setMinimum(event("110")); await save(h);
  assert.deepEqual(h.weekWrites[0].days.map(d => d.weekday), [1, 4]);
  assert.equal(p.data.dirtyDays.length, 0); assert.equal(p.data.weekNotice, "");
});

test("failed multi-day saves retain all drafts, navigation, leave warning and allow an explicit retry", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  p.setMinimum(event("120")); await p.pickWeekday(dayTap(5)); p.selectProjects(event(["p1"]));
  h.saveFailure = true; await save(h);
  assert.equal(p.data.saving, false); assert.match(p.data.weekNotice, /保存失败/);
  assert.deepEqual(plain(p.data.dirtyDays), [1, 5]);
  p.onHide(); assert.equal(h.alerts.at(-1)[0], "disable"); await p.onShow();
  assert.equal(h.alerts.at(-1)[0], "enable"); assert.deepEqual(plain(p.data.projectIds), ["p1"]);
  await p.pickWeekday(dayTap(1)); assert.equal(p.data.minDuration, "120");
  h.saveFailure = false; await save(h);
  assert.deepEqual(h.weekWrites[0].days, h.weekWrites[1].days);
  assert.equal(p.data.dirtyDays.length, 0); assert.equal(h.storage.size, 0);
});

test("a failed weekday load and retry cannot clear another day's unsaved edits", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  p.setMinimum(event("120")); h.weekFailure = true;
  await p.pickWeekday(dayTap(6)); assert.match(p.data.error, /加载失败/);
  const failed = captureFormActions(p);
  h.weekFailure = false; await p.retry(); p.selectProjects(event(["p1"]));
  const current = plain(p.data); await replay(p, failed); assert.deepEqual(plain(p.data), current);
  await p.pickWeekday(dayTap(1)); assert.equal(p.data.minDuration, "120");
  await save(h); assert.deepEqual(h.weekWrites[0].days.map(d => d.weekday), [1, 6]);
});

test("weekly draft account/session boundaries reject delayed controls, confirmations and pending reads", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  p.setMinimum(event("120")); const old = captureFormActions(p);
  const pending = h.weekPending = deferred(), loading = p.pickWeekday(dayTap(2));
  h.user = { id: "admin-b", role: "admin" }; h.token = "b"; h.weekPending = null;
  await p.onShow(); p.selectProjects(event(["p1"])); const before = plain(p.data);
  await replay(p, old); pending.resolve({ ...h.rule, minDuration: 180 }); await loading;
  assert.deepEqual(plain(p.data), before); assert.equal(Object.keys(p._weekDrafts).length, 1);
  const saving = p.save(); h.token = "new-login-b"; await p.onShow();
  const fresh = plain(p.data); h.modals.at(-1).success({ confirm: true }); await saving;
  assert.deepEqual(plain(p.data), fresh); assert.equal(h.weekWrites.length, 0); assert.equal(h.storage.size, 0);
  assert.equal(p.data.dirtyDays.length, 0); assert.equal(p.data.minDuration, "100");
});

test("weekly confirmation before leaving expires while confirmed requests may finish off-page without restoring drafts", async () => {
  const h = await setup({ singleId: "t1" }), p = h.page;
  p.setMinimum(event("120")); const stale = captureFormActions(p);
  const cancelled = p.save(); p.onHide(); await p.onShow();
  h.modals.at(-1).success({ confirm: true }); await cancelled;
  assert.equal(h.weekWrites.length, 0); assert.deepEqual(plain(p.data.dirtyDays), [1]);
  const pending = h.savePending = deferred(), saving = save(h); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.weekWrites.length, 1); p.onHide(); p.onUnload();
  const oldData = plain(p.data), notices = h.toasts.length;
  const next = await h.newPage("t1"); next.setMinimum(event("130")); const nextData = plain(next.data);
  const alerts = h.alerts.length;
  pending.resolve(); await saving; await replay(p, stale);
  assert.deepEqual(plain(p.data), oldData); assert.deepEqual(plain(next.data), nextData);
  assert.equal(h.toasts.length, notices); assert.equal(h.alerts.length, alerts, "old completion cannot change the new page's return warning");
  assert.equal(h.storage.size, 0);
  const reopened = await h.newPage("t1"); assert.equal(reopened.data.minDuration, "120", "a later entry reads the committed server rule");
});

test("weekly save completion while hidden preserves failures and clears successes without native calls into another page", async () => {
  for (const fail of [false, true]) {
    const h = await setup({ singleId: "t1" }), p = h.page; p.setMinimum(event("120"));
    let finish;
    h.savePending = { promise: new Promise((resolve, reject) => { finish = fail ? () => reject(new Error("保存失败")) : resolve; }) };
    const saving = save(h); await Promise.resolve(); await Promise.resolve(); p.onHide();
    const alerts = h.alerts.length, notices = h.toasts.length;
    finish(); await saving; assert.equal(h.alerts.length, alerts); assert.equal(h.toasts.length, notices);
    assert.equal(p.data.saving, false); assert.equal(p.data.dirtyDays.length, fail ? 1 : 0);
    await p.onShow(); p.setMinimum(event("130")); assert.equal(p.data.minDuration, "130");
    assert.equal(h.storage.size, 0);
  }
});
