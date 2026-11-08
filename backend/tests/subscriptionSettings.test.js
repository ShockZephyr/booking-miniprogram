const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../../miniprogram");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(user = { id: "customer", role: "user" }) {
  const app = { globalData: { user, token: "test-session" } };
  const requests = [], calls = [], toasts = [], navigation = [];
  const wx = {
    requestSubscribeMessage: (options) => requests.push(options),
    navigateTo: (options) => navigation.push(options),
    showToast: (options) => toasts.push(options),
    showModal: (options) => { if (options.success) options.success({ confirm: true }); },
    getStorageSync() { throw new Error("no subscription state should be read from storage"); },
    setStorageSync() { throw new Error("authorization results must not be persisted as credits"); },
    removeStorageSync() {}
  };
  const api = (name) => async (...args) => { calls.push({ name, args }); return { success: 1 }; };
  const admin = Object.fromEntries([
    "adminCheckInAppointment", "adminUncheckInAppointment", "adminCancelAppointment"
  ].map((name) => [name, api(name)]));
  const verified = async (id) => ({ appointment: { id, status: "booked", date: "2020-01-01", startTime: "09:00" } });
  admin.appointment = verified;
  const portal = { checkIn: api("therapistCheckIn"), appointment: verified };
  const appointment = { detail: verified, checkIn: api("customerCheckIn"), cancel: api("customerCancel"),
    create: api("customerCreate"), modify: api("customerModify") };
  function helper(file) {
    const module = { exports: {} };
    vm.runInNewContext(source("utils/" + file + ".js"), { wx, module, getApp: () => app,
      require: (name) => helper(name.slice(2)), setInterval: () => 1, clearInterval() {} });
    return module.exports;
  }
  function load(file) {
    let page;
    vm.runInNewContext(source(file), {
      wx, getApp: () => app, Page: (definition) => { page = definition; }, setTimeout: () => 1,
      require: (name) => {
        if (name.endsWith("/confirmation")) return helper("confirmation");
        if (name.endsWith("/loginReturn")) return helper("loginReturn");
        if (name.endsWith("/checkIn")) return helper("checkIn");
        if (name.endsWith("/admin")) return admin;
        if (name.endsWith("/therapistPortal")) return portal;
        if (name.endsWith("/appointment")) return appointment;
        if (name.endsWith("/date")) return require("../../miniprogram/utils/date");
        if (name.endsWith("/timePicker")) return require("../../miniprogram/utils/timePicker");
        if (name.endsWith("/filterTime")) return require("../../miniprogram/utils/filterTime");
        return {};
      }
    }, { filename: file });
    page.setData = (patch) => Object.assign(page.data, patch);
    page.load = () => {};
    return page;
  }
  return { app, wx, requests, calls, toasts, navigation, admin, portal, appointment, load };
}

test("settings has no notification entry and the unused authorization page is unregistered", () => {
  const h = harness(), page = h.load("pages/settings/index.js"), wxml = source("pages/settings/index.wxml");
  assert.doesNotMatch(wxml, /预约消息通知|分\s*3\s*组授权|openSubscriptions/);
  assert.equal(JSON.parse(source("app.json")).pages.includes("pages/subscriptions/index"), false);
  for (const match of wxml.matchAll(/bindtap="([^"]+)"/g)) assert.equal(typeof page[match[1]], "function");
  page.onShow(); assert.equal(h.requests.length, 0);
  for (const name of ["privacy", "agreement", "about"]) {
    assert.ok(wxml.includes(`data-page="${name}"`));
    page.open({ currentTarget: { dataset: { page: name } } });
    assert.equal(h.navigation.at(-1).url, `/pages/static/${name}/index`);
  }
});

test("customer create and modify submit without waiting for subscription permission", async () => {
  const { setup, tap, flush, confirmLatest, inputEvent } = require("./support/scheduleUI");
  for (const editing of [false, true]) {
    const h = setup();
    h.wx.requestSubscribeMessage = () => assert.fail("booking must not prompt for subscriptions");
    const board = h.board(editing); await flush();
    if (!editing) { board.pickItem(inputEvent(board, [board.data.items[0].id])); tap(board, "09:00"); tap(board, "10:30"); }
    board.submit(); await confirmLatest(h);
    assert.equal(board.data.saved, true);
    assert.equal(h.calls.filter(c => c[0] === (editing ? "modify" : "create")).length, 1);
    board.detach();
  }
});

test("customer cancellation works without authorization and service failures remain visible", async () => {
  const h = harness(), page = h.load("pages/my-appointments/index.js");
  const appointment = { id: "appointment", userId: "customer", status: "booked", canCancel: true };
  page.data.appointments = [appointment];
  await page.cardAction({ detail: { type: "cancel", appointment } });
  assert.deepEqual(plain(h.calls), [{ name: "customerCancel", args: ["appointment"] }]);
  assert.equal(page.data.cancelling, false);
  h.appointment.cancel = async () => { throw new Error("取消失败测试"); };
  await page.cardAction({ detail: { type: "cancel", appointment } });
  assert.equal(h.toasts.at(-1).title, "取消失败测试");
  assert.equal(h.requests.length, 0);
});

test("shared list keeps each identity's check-in API without subscription authorization", async () => {
  for (const [user, admin, therapist, expected] of [
    [{ id: "c", role: "user" }, false, false, "customerCheckIn"],
    [{ id: "t", role: "user", therapistId: "t" }, false, true, "therapistCheckIn"],
    [{ id: "a", role: "admin" }, true, false, "adminCheckInAppointment"],
    [{ id: "at", role: "admin", therapistId: "t" }, true, false, "adminCheckInAppointment"]
  ]) {
    const h = harness(user), page = h.load("pages/my-appointments/index.js");
    Object.assign(page.data, { isAdminMode: admin, isTherapistMode: therapist,
      identityReady: true });
    page.cardAction({ detail: { type: "checkIn", appointment: { id: "appointment", canCheckIn: true } } }); assert.equal(h.requests.length, 0);
    await flush();
    assert.deepEqual(h.calls.map(({ name, args }) => [name, ...args]), [[expected, "appointment"]]);
    assert.equal(page._confirmedAction, null);
  }
});

test("staff appointment details submit check-in, cancellation and undo without subscription authorization", async () => {
  const h = harness({ id: "staff", role: "admin", therapistId: "t" });
  const detail = h.load("pages/therapist/appointment-detail/index.js");
  Object.assign(detail.data, { loading: false, appointmentId: "appointment", appointment: { id: "appointment", canCheckIn: true } });
  await detail.checkIn(); await flush();
  const management = h.load("pages/admin/slot-appointment/index.js");
  for (const action of ["checkIn", "uncheckIn", "cancel"]) {
    Object.assign(management.data, { loading: false, appointmentId: "appointment", currentAppointment: {
      id: "appointment", status: action === "uncheckIn" ? "checked_in" : "booked", date: "2020-01-01", startTime: "09:00" } });
    await management.action({ currentTarget: { dataset: { type: action } } });
    await flush();
  }
  assert.deepEqual(h.calls.map(({ name }) => name), ["therapistCheckIn", "adminCheckInAppointment", "adminUncheckInAppointment", "adminCancelAppointment"]);
  assert.equal(h.requests.length, 0);
});

test("staff operation errors remain visible and release the pending state", async () => {
  const h = harness({ id: "staff", role: "user", therapistId: "t" });
  h.portal.checkIn = async () => { throw new Error("签到失败测试"); };
  const page = h.load("pages/therapist/appointment-detail/index.js");
  page.data.loading = false;
  page.data.appointment = { id: "appointment", canCheckIn: true };
  page.checkIn(); await flush();
  assert.equal(page.data.signing, false); assert.equal(h.toasts.at(-1).title, "签到失败测试");
  assert.equal(h.requests.length, 0);
});

test("runtime code has no subscription requests, message send endpoints or enqueue writes", () => {
  function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(file) : [file];
    });
  }
  for (const directory of [root, path.join(__dirname, "../src")]) {
    for (const file of walk(directory).filter((file) => /\.(js|wxml|json)$/.test(file))) {
      const content = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(content, /requestSubscribeMessage|wxa\/business\/subscribemessage\/send|INSERT\s+INTO\s+notifications/i, file);
      assert.doesNotMatch(content, /require\(["'][^"']*(?:notificationService|notificationDispatchService|notificationReminderService|notificationRepository|notificationTemplates|wechatNotificationService|utils\/subscription)["']\)/, file);
    }
  }
  // These WeChat capabilities authenticate members; they are not subscription consent.
  assert.match(source("pages/mine/index.wxml"), /getPhoneNumber/);
  const wechat = fs.readFileSync(path.join(__dirname, "../src/services/wechatService.js"), "utf8");
  assert.match(wechat, /sns\/jscode2session/);
  assert.match(wechat, /wxa\/business\/getuserphonenumber/);
});

test("automatic no-show marking still runs in its transaction and keeps metrics", async () => {
  const client = {}, order = [], marked = 1;
  const deps = {
    "../config/db": { transaction: async (handler) => {
      order.push("begin"); const result = await handler(client); order.push("commit"); return result;
    } },
    "../utils/identityLock": async (value) => { assert.equal(value, client); order.push("identityLock"); },
    "../repositories/appointmentRepository": { markNoShows: async (value) => {
      assert.equal(value, client); order.push("mark"); return marked;
    } },
    "./metricsService": { incrementAppointment: (state, count) => order.push([state, count]) },
    "../config/logger": { logger: { info: () => order.push("log") } }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/services/noShowService.js"), "utf8"), {
    module, require: (name) => { assert.ok(deps[name], name); return deps[name]; }
  });
  assert.equal(await module.exports.markNoShows(), marked);
  assert.deepEqual(order, ["begin", "identityLock", "mark", "commit", ["no_show", 1], "log"]);
  order.length = 0;
  deps["../repositories/appointmentRepository"].markNoShows = async () => { throw new Error("database failed"); };
  await assert.rejects(module.exports.markNoShows(), /database failed/);
  assert.deepEqual(order, ["begin", "identityLock"], "failed updates must not report success metrics");
});
