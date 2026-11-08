const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "../../miniprogram");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
const APPOINTMENT_ID = "00000000-0000-4000-8000-000000000002";
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Run the actual page lifecycle and session helper, with synthetic data and no HTTP or WeChat calls.
async function harness(kind) {
  const therapist = kind === "therapist";
  const app = { globalData: { token: "synthetic-session", user: therapist
    ? { id: "staff", role: "user", therapistId: "therapist" }
    : { id: "manager", role: "admin" } } };
  const payload = { appointment: { id: APPOINTMENT_ID, status: "booked", date: "2020-01-01",
    startTime: "09:00", endTime: "10:30" }, history: [] };
  const h = { app, payload, modals: [], toasts: [], writes: [], updates: [], navigation: [], reads: 0,
    read: () => Promise.resolve(copy(payload)), write: () => Promise.resolve({}),
    field: therapist ? "appointment" : "currentAppointment", busy: "signing",
    eligible: "canCheckIn", targetId: APPOINTMENT_ID };
  let timerId = 0;
  const timeouts = new Map(), intervals = new Map();
  const wx = {
    setNavigationBarTitle() {},
    showModal: (options) => h.modals.push(options),
    showToast: (options) => h.toasts.push(options),
    navigateBack: (options = {}) => {
      h.navigation.push("back");
      if (h.navigateBack) return h.navigateBack(options);
      if (options.success) options.success({});
      if (options.complete) options.complete({});
    },
    redirectTo: (options) => h.navigation.push(options.url),
    switchTab: (options) => h.navigation.push(options.url)
  };
  const globals = { wx, getApp: () => app, getCurrentPages: () => h.visiblePages || [h.page],
    setTimeout: (callback) => { const id = ++timerId; timeouts.set(id, callback); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback) => { const id = ++timerId; intervals.set(id, callback); return id; },
    clearInterval: (id) => intervals.delete(id) };
  const helper = (file) => {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), { ...globals, module, require: (name) => helper("utils/" + name.slice(2) + ".js") }, { filename: file });
    return module.exports;
  };
  const read = (id) => { assert.equal(id, APPOINTMENT_ID); h.reads++; return h.read(); };
  const write = (id) => { h.writes.push(id); return h.write(); };
  const deps = {
    "../../../utils/loginReturn": helper("utils/loginReturn.js"),
    "../../../utils/checkIn": helper("utils/checkIn.js"),
    "../../../utils/confirmation": helper("utils/confirmation.js"),
    "../../../utils/date": require("../../miniprogram/utils/date"),
    "../../../services/therapistPortal": { appointment: read, checkIn: write },
    "../../../services/admin": { appointment: read, adminCheckInAppointment: write,
      adminUncheckInAppointment: async id => {
        h.writes.push(id);
        payload.appointment.status = "booked";
      } },
    "../../../services/user": { serviceItems: async () => ({ items: [] }) },
    "../../../services/therapist": { list: async () => ({ therapists: [] }) }
  };
  const file = therapist ? "pages/therapist/appointment-detail/index.js" : "pages/admin/slot-appointment/index.js";
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), {
    ...globals, Page: (page) => { h.page = page; },
    require: (name) => { assert.ok(deps[name], name); return deps[name]; }
  }, { filename: file });
  const page = h.page;
  page.setData = (patch) => { h.updates.push(copy(patch)); Object.assign(page.data, patch); };
  h.click = () => therapist ? page.checkIn() : page.action({ currentTarget: { dataset: {type: "checkIn"} } });
  h.open = () => {
    const count = h.modals.length;
    h.click();
    assert.equal(h.modals.length, count + 1, "eligible action should open a confirmation");
    return h.modals.at(-1);
  };
  h.reload = () => { page.onHide(); page.onShow(); };
  h.runTimeouts = () => {
    for (const [id, callback] of [...timeouts]) { timeouts.delete(id); callback(); }
  };
  page.onLoad({ appointmentId: APPOINTMENT_ID });
  page.onShow();
  await flush();
  assert.equal(page.data.loading, false);
  assert.equal(page.data[h.field][h.eligible], true);
  return h;
}

for (const kind of ["therapist", "admin"]) {
  test(`${kind}: cancel is harmless; normal confirmation uses the displayed ID and completes`, async () => {
    const h = await harness(kind);
    h.open().success({ confirm: false });
    await flush();
    assert.deepEqual(h.writes, []);
    assert.equal(h.page.data[h.busy], false);
    const reads = h.reads;
    h.open().success({ confirm: true });
    await flush();
    assert.deepEqual(h.writes, [h.targetId]);
    assert.equal(h.page.data[h.busy], false);
    assert.equal(h.toasts.at(-1).title, "已签到");
    assert.equal(h.reads, reads + 2, "check-in verifies and then reloads details");
  });

  test(`${kind}: confirming during onShow reload cannot throw or leave the button stuck`, async () => {
    const h = await harness(kind), pending = deferred(), modal = h.open();
    h.read = () => pending.promise;
    h.reload();
    await flush();
    assert.equal(h.page.data.loading, true);
    assert.equal(h.page.data[h.field], null);
    assert.doesNotThrow(() => modal.success({ confirm: true }));
    await flush();
    assert.deepEqual(h.writes, []);
    assert.equal(h.page.data[h.busy], true);
    assert.match(h.toasts.at(-1).title, /正在核对/);
    pending.resolve(copy(h.payload));
    await flush();
    assert.deepEqual(h.writes, [h.targetId], "the original confirmation continues after verification");
    assert.equal(h.page.data[h.busy], false);
  });

  test(`${kind}: a confirmed action survives a harmless reload of the same target`, async () => {
    const h = await harness(kind), modal = h.open();
    h.reload();
    await flush();
    assert.equal(h.page.data[h.field].id, h.targetId);
    modal.success({ confirm: true });
    await flush();
    assert.deepEqual(h.writes, [h.targetId]);
    assert.equal(h.page.data[h.busy], false);
  });

  test(`${kind}: changed target, eligibility, session or unloaded page invalidates confirmation`, async () => {
    for (const change of ["target", "token", "account", "role", "therapist", "unload"]) {
      const h = await harness(kind), modal = h.open();
      if (change === "target") h.page.data[h.field].id = "different-target";
      if (change === "token") h.app.globalData.token = "new-session";
      if (change === "account") h.app.globalData.user.id = "another-account";
      if (change === "role") h.app.globalData.user.role = "different-role";
      if (change === "therapist") h.app.globalData.user.therapistId = "another-therapist";
      if (change === "unload") h.page.onUnload();
      const updates = h.updates.length;
      modal.success({ confirm: true });
      await flush();
      assert.deepEqual(h.writes, [], change);
      assert.equal(h.page.data[h.busy], false, change);
      assert.equal(h.updates.length, updates, "invalid confirmation must not set a busy state");
      if (!["target", "eligibility"].includes(change)) assert.equal(h.toasts.length, 0, change);
    }
  });

  test(`${kind}: a reload immediately after consent still submits exactly once`, async () => {
    const h = await harness(kind);
    h.open().success({ confirm: true });
    h.reload();
    await flush();
    assert.deepEqual(h.writes, [h.targetId]);
    assert.equal(h.page.data[h.busy], false);
  });

  test(`${kind}: synchronous throws and rejected requests release the button and allow retry`, async () => {
    for (const synchronous of [true, false]) {
      const h = await harness(kind);
      h.write = () => {
        const error = new Error("模拟操作失败");
        if (synchronous) throw error;
        return Promise.reject(error);
      };
      h.open().success({ confirm: true });
      await flush();
      assert.equal(h.page.data[h.busy], false);
      assert.equal(h.toasts.at(-1).title, "模拟操作失败");
      assert.deepEqual(h.navigation, []);
      h.write = () => Promise.resolve({});
      h.open().success({ confirm: true });
      await flush();
      assert.deepEqual(h.writes, [h.targetId, h.targetId]);
      assert.equal(h.page.data[h.busy], false);
    }
  });

  test(`${kind}: repeated confirmation while a request is pending submits only once`, async () => {
    const h = await harness(kind), pending = deferred();
    h.write = () => pending.promise;
    const first = h.open();
    h.click();
    assert.equal(h.modals.length, 1);
    first.success({ confirm: true });
    first.success({ confirm: true });
    await flush();
    assert.deepEqual(h.writes, [h.targetId]);
    assert.equal(h.page.data[h.busy], true);
    pending.resolve({});
    await flush();
    assert.equal(h.page.data[h.busy], false);
  });

  test(`${kind}: stale request completion cannot refresh, navigate or show errors in a new context`, async () => {
    for (const change of ["target", "route", "session", "unload"]) {
      for (const failure of [false, true]) {
        const h = await harness(kind), pending = deferred();
        h.write = () => pending.promise;
        h.open().success({ confirm: true });
        await flush();
        assert.deepEqual(h.writes, [h.targetId]);
        if (change === "target") h.page.data[h.field].id = "different-target";
        if (change === "route") { h.page.data.appointmentId = "different-route"; h.page.data[h.field] = null; h.page.data.loading = true; }
        if (change === "session") h.app.globalData.token = "new-session";
        if (change === "unload") h.page.onUnload();
        const reads = h.reads, updates = h.updates.length, toastCount = h.toasts.length;
        if (failure) pending.reject(new Error("旧请求失败"));
        else pending.resolve({});
        await flush();
        h.runTimeouts();
        assert.equal(h.reads, reads, `${change}: old success cannot reload the new context`);
        assert.equal(h.toasts.length, toastCount, `${change}: stale feedback must be suppressed`);
        assert.deepEqual(h.navigation, []);
        if (change === "unload") assert.equal(h.updates.length, updates);
        else assert.equal(h.page.data[h.busy], false);
      }
    }
  });

  test(`${kind}: success after a same-target reload synchronizes the view even when an old read finishes late`, async () => {
    for (const timing of ["read-first", "write-first", "read-failed"]) {
      const h = await harness(kind), write = deferred(), oldRead = deferred();
      const stale = copy(h.payload);
      let committed = false, readsAfterReload = 0;
      h.write = () => write.promise.then(() => {
        committed = true;
        h.payload.appointment.status = "checked_in";
        return {};
      });
      h.open().success({ confirm: true });
      await flush();
      h.read = () => {
        if (++readsAfterReload === 1) return oldRead.promise;
        assert.equal(committed, true, "recovery must read after the successful write");
        return Promise.resolve(copy(h.payload));
      };
      h.reload();
      await flush();
      if (timing === "read-first") { oldRead.resolve(stale); await flush(); }
      if (timing === "read-failed") { oldRead.reject(new Error("读取失败")); await flush(); }
      write.resolve();
      await flush();
      if (timing === "write-first") { oldRead.resolve(stale); await flush(); }
      assert.equal(committed, true);
      assert.equal(h.page.data.loading, false);
      assert.equal(h.page.data.error, "");
      assert.equal(h.page.data[h.busy], false);
      assert.deepEqual(h.writes, [h.targetId], "synchronization must not repeat the mutation");
      assert.equal(h.page.data[h.field].status, "checked_in");
      assert.equal(h.page.data[h.field].canCheckIn, false);
      assert.equal(readsAfterReload, 2);
    }
  });

  test(`${kind}: failed mutation after a same-target reload remains visible and releases the button`, async () => {
    const h = await harness(kind), pending = deferred();
    h.write = () => pending.promise;
    h.open().success({ confirm: true });
    await flush();
    h.reload();
    await flush();
    pending.reject(new Error("模拟操作失败"));
    await flush();
    assert.equal(h.toasts.at(-1).title, "模拟操作失败");
    assert.equal(h.page.data[h.busy], false);
    assert.equal(h.page.data[h.field].id, h.targetId);
    assert.deepEqual(h.navigation, []);
  });

  test(`${kind}: loading, missing or ineligible targets do not open an action confirmation`, async () => {
    for (const state of ["loading", "missing", "ineligible"]) {
      const h = await harness(kind);
      if (state === "loading") h.page.data.loading = true;
      if (state === "missing") h.page.data[h.field] = null;
      if (state === "ineligible") Object.assign(h.page.data[h.field], { status: "cancelled", canCheckIn: false });
      h.click();
      assert.equal(h.modals.length, 0, state);
      assert.deepEqual(h.writes, []);
    }
  });

  test(`${kind}: detail reads finishing after unload cannot update the destroyed page`, async () => {
    const h = await harness(kind), pending = deferred();
    h.read = () => pending.promise;
    h.reload();
    await flush();
    h.page.onUnload();
    const updates = h.updates.length;
    pending.resolve(copy(h.payload));
    await flush();
    assert.equal(h.updates.length, updates);
  });
}

test("therapist: successful check-in invalidates older reads while recovery is loading and exposes recovery failures", async () => {
  for (const failRecovery of [false, true]) {
    const h = await harness("therapist"), write = deferred(), oldRead = deferred(), recovery = deferred();
    const stale = copy(h.payload);
    h.write = () => write.promise.then(() => { h.payload.appointment.status = "checked_in"; return {}; });
    h.open().success({ confirm: true });
    await flush();
    let readCount = 0;
    h.read = () => ++readCount === 1 ? oldRead.promise : recovery.promise;
    h.reload();
    await flush();
    write.resolve();
    await flush();
    oldRead.resolve(stale);
    await flush();
    assert.equal(h.page.data.loading, true);
    assert.equal(h.page.data.appointment, null, "old response must not restore the check-in button");
    if (failRecovery) recovery.reject(new Error("刷新失败"));
    else recovery.resolve(copy(h.payload));
    await flush();
    assert.equal(h.page.data.loading, false);
    assert.equal(h.page.data.signing, false);
    if (failRecovery) {
      assert.equal(h.page.data.error, "刷新失败");
      h.read = () => Promise.resolve(copy(h.payload));
      h.page.load();
      await flush();
    }
    assert.equal(h.page.data.appointment.status, "checked_in");
    assert.equal(h.page.data.appointment.canCheckIn, false);
    assert.deepEqual(h.writes, [h.targetId]);
  }
});

test("admin undo uses the selected checked-in appointment, ignores duplicate taps and rechecks the session", async () => {
  for (const changedAccount of [false, true]) {
    const h = await harness("admin");
    const undo = () => h.page.action({ currentTarget: { dataset: { type: "uncheckIn" } } });
    undo();
    assert.equal(h.modals.length, 0, "a booked appointment has no check-in to undo");
    h.payload.appointment.status = "checked_in";
    await h.page.load();
    undo(); undo();
    assert.equal(h.modals.length, 1);
    if (changedAccount) h.app.globalData.token = "new-session";
    h.modals[0].success({ confirm: true });
    await flush();
    assert.deepEqual(h.writes, changedAccount ? [] : [APPOINTMENT_ID]);
    if (!changedAccount) {
      assert.equal(h.page.data.currentAppointment.status, "booked");
      assert.equal(h.page.data.currentAppointment.id, APPOINTMENT_ID);
    }
    h.page.onUnload();
  }
});
