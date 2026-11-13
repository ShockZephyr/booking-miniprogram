const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../../miniprogram");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(kind) {
  const admin = kind.startsWith("admin"), staff = admin || kind.startsWith("therapist");
  const detail = kind.endsWith("detail");
  const app = { globalData: { token: "synthetic-session", user: {
    id: kind, role: admin ? "admin" : "user", therapistId: kind.includes("therapist") ? "staff" : null
  } } };
  const record = { id: "00000000-0000-4000-8000-000000000001", therapistId: "staff",
    userId: "customer", status: "booked", date: "2020-01-01", startTime: "09:00", endTime: "10:00" };
  const h = { app, record, modals: [], toasts: [], writes: [], reads: 0, refreshes: 0 };
  h.verify = async () => ({ appointment: copy(record), history: [] });
  h.write = async () => { record.status = "checked_in"; return {}; };
  h.list = async () => ({ appointments: [copy(record)], pagination: {} });
  const read = (id) => { h.reads++; assert.equal(id, record.id); return h.verify(); };
  const write = (role) => (id) => { h.writes.push({ role, id }); return h.write(); };
  const listRead = () => { h.refreshes++; return h.list(); };
  const api = {
    batchCheckIn: {},
    appointmentInbox: { acknowledge: async () => ({ acknowledged: [] }) },
    admin: { appointment: read, appointments: listRead, adminCheckInAppointment: write("admin") },
    therapistPortal: { appointment: read, appointments: listRead, checkIn: write("therapist") },
    appointment: { detail: read, my: listRead, checkIn: write("customer"), filterOptions: async () => ({ serviceItems: [], therapists: [], supportsInactiveFilters: true }) },
    user: { serviceItems: async () => ({ items: [] }) }, therapist: { list: async () => ({ therapists: [] }) }
  };
  const wx = { showModal: (modal) => h.modals.push(modal), showToast: (toast) => h.toasts.push(toast), setNavigationBarTitle() {} };
  const globals = { wx, getApp: () => app, setInterval: () => 1, clearInterval() {} };
  function requireModule(name) {
    const key = name.split("/").at(-1);
    if (api[key]) return api[key];
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, "utils", key + ".js"), "utf8"), { ...globals, module, require: requireModule });
    return module.exports;
  }
  const file = !detail ? "pages/my-appointments/index.js"
    : admin ? "pages/admin/slot-appointment/index.js" : "pages/therapist/appointment-detail/index.js";
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), { ...globals, require: requireModule, Page: (page) => { h.page = page; } });
  h.page.setData = (patch, callback) => { Object.assign(h.page.data, patch); if (callback) callback(); };
  h.page.onLoad(detail ? { appointmentId: record.id } : { status: "pending" });
  h.page.onShow(); await flush();
  h.click = () => detail
    ? admin ? h.page.action({ currentTarget: { dataset: { type: "checkIn" } } }) : h.page.checkIn()
    : h.page.cardAction({ detail: { type: "checkIn", appointment: { ...copy(record), canCheckIn: true } } });
  h.open = () => { h.click(); return h.modals.at(-1); };
  h.expectedRole = admin ? "admin" : staff ? "therapist" : "customer";
  return h;
}

for (const kind of ["customer-list", "therapist-list", "admin-list", "admin-therapist-list", "therapist-detail", "admin-detail"]) {
  test(`${kind}: cancel never reads or writes; confirmed reload verifies the original ID and submits once`, async () => {
    const h = await harness(kind);
    const before = h.reads;
    h.open().success({ confirm: false }); await flush();
    assert.equal(h.reads, before); assert.equal(h.writes.length, 0);
    const pending = deferred(); h.verify = () => pending.promise;
    const modal = h.open(); h.click();
    assert.equal(h.modals.length, 2, "duplicate taps must not open a second active modal");
    h.page.onHide(); h.page.onShow(); await flush();
    modal.success({ confirm: true }); modal.success({ confirm: true }); await flush();
    assert.equal(h.page.data.signing, true); assert.equal(h.writes.length, 0);
    pending.resolve({ appointment: copy(h.record) }); await flush();
    assert.deepEqual(h.writes, [{ role: h.expectedRole, id: h.record.id }]);
    assert.equal(h.page.data.signing, false); assert.equal(h.toasts.at(-1).title, "已签到");
    assert.equal(h.record.status, "checked_in"); h.page.onUnload();
  });

  test(`${kind}: current checked-in state only refreshes; cancelled and future appointments never submit`, async () => {
    for (const state of ["checked_in", "cancelled", "future"]) {
      const h = await harness(kind), modal = h.open();
      if (state === "future") h.record.date = "2999-01-01";
      else h.record.status = state;
      modal.success({ confirm: true }); await flush();
      assert.equal(h.writes.length, 0, state); assert.equal(h.page.data.signing, false);
      assert.match(h.toasts.at(-1).title, state === "checked_in" ? /已签到/ : /当前不能签到/);
      h.page.onUnload();
    }
  });

  test(`${kind}: make-up check-in works from the existing appointment alone after its service day`, async () => {
    const h = await harness(kind), modal = h.open();
    h.record.status = "no_show";
    modal.success({ confirm: true }); await flush();
    assert.deepEqual(h.writes, [{ role: h.expectedRole, id: h.record.id }]);
    h.page.onUnload();
  });

  test(`${kind}: account, role and unload changes during verification suppress writes and stale feedback`, async () => {
    for (const change of ["account", "role", "unload"]) {
      const h = await harness(kind), pending = deferred(); h.verify = () => pending.promise;
      h.open().success({ confirm: true }); await flush();
      if (change === "account") h.app.globalData.token = "other-session";
      if (change === "role") h.app.globalData.user.role = "changed-role";
      if (change === "unload") h.page.onUnload();
      const count = h.toasts.length;
      pending.resolve({ appointment: copy(h.record) }); await flush();
      assert.equal(h.writes.length, 0); assert.equal(h.toasts.length, count);
      h.page.onUnload();
    }
  });

  test(`${kind}: verification failure is visible and a new confirmation can retry`, async () => {
    const h = await harness(kind), original = h.verify;
    h.verify = () => Promise.reject(new Error("合成核对失败"));
    h.open().success({ confirm: true }); await flush();
    assert.equal(h.writes.length, 0); assert.equal(h.page.data.signing, false);
    assert.equal(h.toasts.at(-1).title, "合成核对失败");
    h.verify = original; h.open().success({ confirm: true }); await flush();
    assert.equal(h.writes.length, 1); h.page.onUnload();
  });

  test(`${kind}: a network timeout reads the actual outcome without replaying the write`, async () => {
    for (const outcome of ["committed", "not-committed", "read-failed"]) {
      const h = await harness(kind);
      const before = h.reads;
      h.write = () => {
        if (outcome === "committed") h.record.status = "checked_in";
        if (outcome === "read-failed") h.verify = () => Promise.reject(new Error("合成读取失败"));
        return Promise.reject({ code: "NETWORK_ERROR", message: "合成超时" });
      };
      h.open().success({ confirm: true }); await flush();
      assert.equal(h.writes.length, 1); assert.equal(h.reads - before, 2 + Number(kind.endsWith("detail") && outcome !== "read-failed")); assert.equal(h.page.data.signing, false);
      assert.match(h.toasts.at(-1).title, outcome === "committed" ? /已签到/ : /结果未确认/);
      h.page.onUnload();
    }
  });

  test(`${kind}: success after submission reloads the same view and discards older list/detail responses`, async () => {
    const h = await harness(kind), write = deferred(), oldRead = deferred();
    h.write = () => write.promise.then(() => { h.record.status = "checked_in"; return {}; });
    h.open().success({ confirm: true }); await flush();
    assert.equal(h.writes.length, 1);
    const originalList = h.list, originalDetail = h.verify;
    const stale = kind.endsWith("detail") ? await h.verify() : await h.list();
    h.list = h.verify = () => oldRead.promise;
    h.page.onHide(); h.page.onShow(); await flush();
    h.list = originalList; h.verify = originalDetail;
    write.resolve(); await flush();
    oldRead.resolve(stale); await flush();
    const shown = kind.endsWith("detail")
      ? h.page.data.currentAppointment || h.page.data.appointment : h.page.data.appointments[0];
    assert.equal(shown.status, "checked_in"); assert.equal(shown.canCheckIn, false);
    assert.equal(h.page.data.signing, false); assert.equal(h.writes.length, 1);
    h.page.onUnload();
  });
}
