const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../../miniprogram");
const flush = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Actual list page, confirmation lifecycle and frontend cancellation service.
// Only the HTTP transport and WeChat native UI are substituted.
async function harness() {
  const app = { _loginSessionVersion: 1, globalData: { token: "synthetic-session", user: { id: "customer", role: "user" } } };
  const records = ["a", "b"].map(id => ({ id, userId: "customer", status: "booked", date: "2099-01-01", startTime: "09:00", endTime: "11:00" }));
  const h = { app, records, modals: [], toasts: [], writes: [], reads: 0, pages: [] };
  h.write = async id => { records.find(record => record.id === id).status = "cancelled"; return {}; };
  const request = options => {
    const match = /^\/api\/appointments\/(.+)\/cancel$/.exec(options.url);
    if (match) { h.writes.push({ id: match[1], token: app.globalData.token }); return h.write(match[1]); }
    if (options.url.includes("filter-options")) return Promise.resolve({ serviceItems: [], therapists: [], supportsInactiveFilters: true });
    if (options.url.startsWith("/api/appointments/my?")) { h.reads++; return Promise.resolve({ appointments: copy(records), pagination: {} }); }
    throw new Error("Unexpected request: " + options.url);
  };
  const wx = { setNavigationBarTitle() {}, showModal: modal => h.modals.push(modal), showToast: toast => h.toasts.push(toast) };
  const cache = new Map();
  function run(file, extra = {}) {
    vm.runInNewContext(fs.readFileSync(file, "utf8"), {
      wx, getApp: () => app, setInterval: () => 1, clearInterval() {}, ...extra,
      require(name) {
        const resolved = path.resolve(path.dirname(file), name + ".js");
        if (resolved === path.join(root, "utils/request.js")) return request;
        if (!cache.has(resolved)) { const module = { exports: {} }; run(resolved, { module }); cache.set(resolved, module.exports); }
        return cache.get(resolved);
      }
    }, { filename: file });
  }
  h.newPage = async () => {
    let page;
    run(path.join(root, "pages/my-appointments/index.js"), { Page: value => { page = value; } });
    page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback(); };
    page.onLoad({ status: "pending" }); page.onShow(); await flush(); h.pages.push(page); return page;
  };
  h.click = (page = h.page, id = "a") => page.cardAction({ detail: { type: "cancel", appointment: page.data.appointments.find(record => record.id === id) } });
  h.open = (page = h.page, id = "a") => { h.click(page, id); return h.modals.at(-1); };
  h.page = await h.newPage();
  return h;
}

test("list cancellation captures the original ID, accepts no_show and sends once despite duplicate taps or modal callbacks", async () => {
  const h = await harness(), pending = deferred();
  h.records[0].status = "no_show"; await h.page.load(); await flush();
  h.write = () => pending.promise;
  const modal = h.open(); h.click(h.page, "b");
  assert.equal(h.modals.length, 1); assert.equal(h.page.data.cancelling, true);
  modal.success({ confirm: true }); modal.success({ confirm: true }); await flush();
  h.click(); h.click(h.page, "b");
  assert.deepEqual(h.writes, [{ id: "a", token: "synthetic-session" }]);
  assert.equal(h.modals.length, 1);
  pending.resolve({}); await flush();
  assert.equal(h.page.data.cancelling, false); assert.equal(h.page._confirmedAction, null);
  assert.equal(h.toasts.at(-1).title, "已取消预约"); h.page.onUnload();
});

for (const change of ["hide", "hide-return", "unload", "token", "session-version", "role", "therapist"]) {
  test(`an old list cancellation cannot write after ${change}`, async () => {
    const h = await harness(), modal = h.open();
    if (change.startsWith("hide")) h.page.onHide();
    if (change === "hide-return") { h.page.onShow(); await flush(); }
    if (change === "unload") h.page.onUnload();
    if (change === "token") h.app.globalData.token = "replacement-session";
    if (change === "session-version") h.app._loginSessionVersion++;
    if (change === "role") h.app.globalData.user.role = "admin";
    if (change === "therapist") h.app.globalData.user.therapistId = "staff";
    modal.success({ confirm: true }); await flush();
    assert.equal(h.writes.length, 0); assert.equal(h.toasts.length, 0); h.page.onUnload();
  });
}

test("old confirmation callbacks cannot consume or release a new session's cancellation", async () => {
  const h = await harness(), old = h.open();
  h.app._loginSessionVersion++; h.page.onShow(); await flush();
  const current = h.open(h.page, "b");
  old.success({ confirm: true }); old.fail(); await flush();
  assert.equal(h.page.data.cancelling, true); assert.equal(h.writes.length, 0);
  current.success({ confirm: true }); await flush();
  assert.equal(h.writes[0].id, "b"); assert.equal(h.page.data.cancelling, false); h.page.onUnload();
});

test("cancelled or failed modal and failed service release the lock without automatic retries", async () => {
  const h = await harness();
  h.open().success({ confirm: false }); await flush();
  assert.equal(h.page.data.cancelling, false); assert.equal(h.writes.length, 0);
  h.open().fail(); await flush();
  assert.equal(h.page.data.cancelling, false); assert.equal(h.writes.length, 0);
  h.write = async () => { throw Object.assign(new Error("取消结果未确认"), { code: "NETWORK_ERROR" }); };
  h.open().success({ confirm: true }); await flush(); await flush();
  assert.equal(h.writes.length, 1); assert.equal(h.page.data.cancelling, false);
  assert.equal(h.toasts.at(-1).title, "取消结果未确认");
  h.write = async () => ({});
  h.open().success({ confirm: true }); await flush();
  assert.equal(h.writes.length, 2, "an explicit fresh confirmation may retry after a settled failure"); h.page.onUnload();
});

test("confirmation rechecks the latest loaded record, while harmless reloads retain the original target", async () => {
  for (const change of ["loading", "removed", "checked_in", "other-owner", "reload"]) {
    const h = await harness(), modal = h.open();
    if (change === "loading") h.page.data.loading = true;
    if (change === "removed") h.page.data.appointments = [];
    if (change === "checked_in") h.page.data.appointments[0].status = "checked_in";
    if (change === "other-owner") h.page.data.appointments[0].userId = "other";
    if (change === "reload") { h.page.load(); await flush(); }
    modal.success({ confirm: true }); await flush();
    assert.equal(h.writes.length, change === "reload" ? 1 : 0, change);
    assert.equal(h.page.data.cancelling, false); h.page.onUnload();
  }
});

test("leaving a confirmed cancellation and re-entering coalesces the same pending HTTP write", async () => {
  const h = await harness(), pending = deferred(); h.write = () => pending.promise;
  h.open().success({ confirm: true }); await flush(); h.page.onUnload();
  const next = await h.newPage(); h.open(next).success({ confirm: true }); await flush();
  assert.equal(h.writes.length, 1); const before = h.toasts.length;
  pending.resolve({}); await flush();
  assert.equal(h.toasts.length, before + 1, "only the live page shows completion");
  assert.equal(next.data.cancelling, false); next.onUnload();
});

for (const outcome of ["success", "failure"]) {
  test(`late cancellation ${outcome} cannot refresh, toast or unlock a new session's action`, async () => {
    const h = await harness(), old = deferred(), next = deferred();
    h.write = () => old.promise; h.open().success({ confirm: true }); await flush();
    h.app.globalData.token = "new-session"; h.app._loginSessionVersion++;
    h.page.onShow(); await flush();
    h.write = () => next.promise; h.open().success({ confirm: true }); await flush();
    assert.deepEqual(h.writes.map(write => write.token), ["synthetic-session", "new-session"], "pending requests must not be shared across sessions");
    const reads = h.reads, toasts = h.toasts.length;
    if (outcome === "success") old.resolve({}); else old.reject(new Error("旧请求失败"));
    await flush();
    assert.equal(h.reads, reads); assert.equal(h.toasts.length, toasts); assert.equal(h.page.data.cancelling, true);
    next.resolve({}); await flush(); assert.equal(h.page.data.cancelling, false); h.page.onUnload();
  });
}

test("list cards use the existing busy guard without changing hit areas or action bubbling", () => {
  const list = fs.readFileSync(path.join(root, "pages/my-appointments/index.wxml"), "utf8");
  assert.match(list, /busy="{{signing \|\| cancelling}}"/);
  const card = fs.readFileSync(path.join(root, "components/appointment-card/index.js"), "utf8");
  assert.match(card, /if \(this.properties.busy\) return/);
});
