const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const h = { owner: "admin-a", writes: [], toasts: [], destinations: [], days: 7, reads: 0, timers: new Map(),
    people: [{ id: "person-a", name: "测试芳疗师", imageSrc: "https://example.test/avatar.png", bio: "简介内容", tags: ["项目甲"] }] };
  let timerId = 0;
  h.save = async daysVisible => { h.days = daysVisible; return { daysVisible }; };
  const session = { sessionKey: () => h.owner, ensure: async () => true };
  const admin = { scheduleSettings: async () => { h.reads++; if (h.readError) throw h.readError; return { daysVisible: h.days }; },
    setScheduleSettings: value => { h.writes.push(value); return h.save(value); } };
  const saves = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../miniprogram/utils/scheduleSettingsSave.js"), "utf8"), { module: saves });
  h.newPage = () => {
    let page;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/admin/calendar/index.js"), "utf8"), {
      Page: value => { page = value; },
      setTimeout: (fn, delay) => { h.timers.set(++timerId, { fn, delay }); return timerId; },
      clearTimeout: id => h.timers.delete(id),
      require: name => name.endsWith("/scheduleSettingsSave") ? saves.exports
        : name.endsWith("/admin") ? admin : name.endsWith("/therapist") ? { list: async () => ({ therapists: h.people }) } : session,
      wx: { showToast: value => h.toasts.push(value.title), navigateTo: value => h.destinations.push(value.url) }
    });
    page.setData = function (patch) { Object.assign(this.data, patch); };
    return page;
  };
  h.page = h.newPage();
  h.input = value => h.page.inputDays({ detail: { value } });
  h.fireTimers = () => {
    for (const [id, timer] of [...h.timers]) { h.timers.delete(id); timer.fn(); }
  };
  return h;
}

test("day settings debounce valid changes and never save intermediate, invalid or unchanged values", async () => {
  const h = setup(), p = h.page;
  await p.load();
  assert.equal(p.data.daysVisible, "7");
  assert.equal(h.timers.size, 0);
  await p.saveDays(); assert.deepEqual(h.writes, []);
  for (const value of ["", "0", "-1", "1.5", "2147483648", "invalid", "7", "07"]) {
    h.input(value); assert.equal(h.timers.size, 0, value);
  }
  for (const value of ["1", "2147483647", "10"]) {
    h.input(value); assert.equal(h.timers.size, 1, value);
  }
  assert.deepEqual(h.writes, []);
  assert.equal([...h.timers.values()][0].delay, 500);
  const request = deferred(); h.save = () => request.promise;
  h.fireTimers(); const saving = p._saveTask;
  assert.equal(p.data.saving, true); assert.equal(h.timers.size, 0);
  h.input("12"); assert.equal(p.data.daysVisible, "10", "disabled input cannot change the pending save");
  assert.equal(p.flushDays(), saving); assert.deepEqual(h.writes, [10]);
  request.resolve({ daysVisible: 10 }); await saving;
  assert.equal(p.data.daysVisible, "10"); assert.equal(p.data.savedDays, 10);
  assert.equal(p.data.saving, false); assert.equal(p.data.daysFeedback, "");
  await p.flushDays(); assert.deepEqual(h.writes, [10]);
});

test("blur or keyboard confirmation flushes once while invalid entries only show validation feedback", async () => {
  const h = setup(), p = h.page; await p.load();
  h.input("1"); h.input("14"); await p.flushDays();
  assert.deepEqual(h.writes, [14]); assert.equal(h.timers.size, 0);
  h.fireTimers(); await p.flushDays(); assert.deepEqual(h.writes, [14]);
  h.input("20"); assert.equal(h.timers.size, 1);
  h.input(""); assert.equal(h.timers.size, 0);
  await p.flushDays(); assert.match(p.data.daysFeedback, /正整数/);
  assert.equal(p.data.daysSaveError, false); assert.deepEqual(h.writes, [14]);
  h.input("14"); assert.equal(p.data.daysFeedback, "");
});

test("failed autosaves retain the draft across page returns and offer a deliberate retry", async () => {
  const h = setup(), p = h.page; await p.load();
  h.input("14"); h.save = async () => { throw new Error("临时失败"); };
  h.fireTimers(); await p._saveTask;
  assert.equal(p.data.daysVisible, "14"); assert.equal(p.data.savedDays, 7);
  assert.equal(p.data.daysSaveError, true); assert.equal(p.data.saving, false);
  assert.match(p.data.daysFeedback, /临时失败.*重试/); assert.equal(h.timers.size, 0);
  p.onHide(); h.readError = new Error("读取失败"); await p.onShow();
  assert.equal(p.data.error, "读取失败"); assert.equal(p.data.daysVisible, "14"); assert.equal(p.data.daysSaveError, true);
  h.readError = null; await p.load();
  assert.deepEqual(h.writes, [14], "page transitions do not silently retry a failed request");
  assert.equal(p.data.daysVisible, "14"); assert.equal(p.data.daysSaveError, true);
  h.save = async daysVisible => ({ daysVisible }); await p.saveDays();
  assert.equal(p.data.savedDays, 14); assert.equal(p.data.daysSaveError, false);
});

test("a previous account's delayed autosave or response cannot write or display as the current account", async () => {
  const h = setup(), p = h.page; await p.load();
  h.input("14"); h.owner = "admin-b"; h.fireTimers();
  assert.deepEqual(h.writes, []);
  await p.load();
  h.input("21"); const pending = deferred(); h.save = () => pending.promise;
  const saving = p.saveDays();
  h.owner = "admin-c"; h.days = 3; await p.onShow();
  const messages = h.toasts.length;
  pending.resolve({ daysVisible: 21 }); await saving;
  assert.equal(p.data.daysVisible, "3"); assert.equal(p.data.savedDays, 3);
  assert.equal(p.data.daysSaveError, false); assert.equal(p.data.saving, false);
  assert.equal(h.toasts.length, messages);
});

test("leaving flushes the latest valid input once and returning waits for that save before rereading settings", async () => {
  const h = setup(), p = h.page; await p.onShow();
  h.input("20"); const pending = deferred(); h.save = () => pending.promise;
  p.onHide(); assert.deepEqual(h.writes, [20]); assert.equal(h.timers.size, 0);
  const returning = p.onShow(); assert.equal(h.reads, 1);
  h.days = 20; pending.resolve({ daysVisible: 20 }); await returning;
  assert.equal(h.reads, 2); assert.equal(p.data.daysVisible, "20"); assert.equal(p.data.savedDays, 20);
  h.input("21"); const final = deferred(); h.save = () => final.promise;
  p.onHide(); p.onUnload(); assert.deepEqual(h.writes, [20, 21]);
  const before = JSON.stringify(p.data), messages = h.toasts.length;
  final.resolve({ daysVisible: 21 }); await p._saveTask;
  assert.equal(JSON.stringify(p.data), before, "an unloaded page cannot receive a late result");
  assert.equal(h.toasts.length, messages); assert.equal(h.timers.size, 0);
});

test("weekly directory reuses the real therapist-card select event and preserves image, bio and tags", async () => {
  const h = setup(), p = h.page; await p.load();
  const person = p.data.therapists[0];
  assert.equal(person.imageSrc, h.people[0].imageSrc);
  assert.equal(person.bio, h.people[0].bio);
  assert.deepEqual(person.tags, h.people[0].tags);
  assert.equal(person.label, undefined, "weekly management does not claim daily availability");
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../miniprogram/components/therapist-card/index.js"), "utf8"), {
    Component: value => { definition = value; }, require: () => require("../../miniprogram/utils/imageFallback")
  });
  definition.methods.tap.call({ data: { therapist: person }, triggerEvent: (type, detail) => {
    assert.equal(type, "select"); p.edit({ detail });
  } });
  p.edit({ detail: { therapist: { id: "removed-person" } } });
  p.edit({ detail: {} });
  p.batch();
  assert.deepEqual(h.destinations, ["/pages/admin/batch-slots/index?therapistId=person-a", "/pages/admin/batch-slots/index"]);
});

const settle = () => new Promise(resolve => setImmediate(resolve));

test("reopening a new directory waits for the unloaded page's save and can then change back to the old value", async () => {
  const h = setup(), old = h.page; await old.onShow();
  h.input("20"); const pending = deferred();
  h.save = async daysVisible => { await pending.promise; h.days = daysVisible; return { daysVisible }; };
  old.onHide(); old.onUnload();
  const oldData = JSON.stringify(old.data), messages = h.toasts.length;
  const current = h.page = h.newPage(), showing = current.onShow();
  await settle();
  assert.equal(h.reads, 1, "a new instance must not read the pre-save value");
  assert.equal(current.data.loading, true);
  h.input("7"); current.onHide(); const showingAgain = current.onShow();
  assert.deepEqual(h.writes, [20], "waiting must not generate an extra save");
  pending.resolve(); await Promise.all([showing, showingAgain]);
  assert.equal(h.reads, 2, "only the latest show may load");
  assert.equal(current.data.daysVisible, "20"); assert.equal(current.data.savedDays, 20);
  assert.equal(JSON.stringify(old.data), oldData); assert.equal(h.toasts.length, messages);
  h.save = async daysVisible => { h.days = daysVisible; return { daysVisible }; };
  h.input("7"); await current.flushDays();
  assert.deepEqual(h.writes, [20, 7]); assert.equal(h.days, 7);
});

test("a failed off-page save releases a new directory to read actual settings without inheriting the old draft", async () => {
  const h = setup(), old = h.page; await old.onShow();
  h.input("20"); const pending = deferred(); h.save = () => pending.promise;
  old.onHide(); old.onUnload();
  const current = h.page = h.newPage(), showing = current.onShow();
  await settle(); assert.equal(h.reads, 1);
  pending.reject(new Error("保存失败")); await showing;
  assert.equal(current.data.daysVisible, "7"); assert.equal(current.data.savedDays, 7);
  assert.equal(current.data.loading, false); assert.equal(current.data.daysSaveError, false);
  assert.deepEqual(h.writes, [20]); assert.equal(h.toasts.length, 0);
  await current.onShow(); assert.equal(h.reads, 3, "failed tasks cannot block subsequent reads");
});

test("switching account or login session while waiting cannot resume an obsolete show or overwrite the new draft", async () => {
  for (const nextOwner of ["admin-b", "admin-a:new-login"]) {
    const h = setup(), old = h.page; await old.onShow();
    h.input("20"); const pending = deferred(); h.save = () => pending.promise;
    old.onHide(); old.onUnload();
    const current = h.page = h.newPage(), staleShow = current.onShow();
    await settle(); assert.equal(h.reads, 1);
    h.owner = nextOwner; h.days = 14;
    await current.onShow();
    assert.equal(current.data.daysVisible, "14"); assert.equal(h.reads, 2);
    h.input("21"); const newDraft = JSON.stringify(current.data);
    pending.resolve({ daysVisible: 20 }); await staleShow;
    assert.equal(JSON.stringify(current.data), newDraft);
    assert.equal(h.reads, 2); assert.deepEqual(h.writes, [20]);
  }
});

test("leaving a new directory while it waits prevents late loading or writes into that page", async () => {
  const h = setup(), old = h.page; await old.onShow();
  h.input("20"); const pending = deferred(); h.save = () => pending.promise;
  old.onUnload();
  const current = h.page = h.newPage(), showing = current.onShow();
  await settle(); assert.equal(h.reads, 1);
  current.onHide(); current.onUnload(); const before = JSON.stringify(current.data);
  pending.resolve({ daysVisible: 20 }); await showing;
  assert.equal(JSON.stringify(current.data), before);
  assert.equal(h.reads, 1); assert.deepEqual(h.writes, [20]);
  assert.equal(h.timers.size, 0); assert.equal(h.toasts.length, 0);
});
