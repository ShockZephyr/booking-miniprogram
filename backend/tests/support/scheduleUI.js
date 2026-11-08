const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../../../miniprogram");
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function setup({ performance } = {}) {
  let now = Date.parse("2026-10-30T09:12:00+08:00");
  class Clock extends Date {
    constructor(...args) { if (args.length) super(...args); else super(now); }
    static now() { return now; }
  }
  const timers = new Map(), intervals = new Map(), stack = [], calls = [], storage = new Map();
  let timer = 0;
  const app = { _loginSessionVersion: 1, globalData: { token: "session", user: { id: "u", role: "user", effectiveRole: "member" } } };
  const day = { therapistId: "10000000-0000-4000-8000-000000000001", therapistName: "芳疗师", therapistBio: "温和细致的芳疗师简介",
    therapistImageUrl: "/uploads/therapists/synthetic.png", therapistImageSrc: "https://example.test/uploads/therapists/synthetic.png",
    therapistTags: ["项目一", "项目二"],
    date: "2026-10-30", today: "2026-10-30", daysVisible: 7,
    ranges: [{ startTime: "09:00", endTime: "13:00" }], step: 30, minDuration: 90, closed: [], busy: [], serviceItemIds: ["p"], appointments: [] };
  const record = { id: "a", userId: "u", therapistId: day.therapistId, date: day.date, startTime: "09:00", endTime: "11:00",
    serviceItemId: "p", serviceItemName: "项目一", status: "checked_in", note: "原备注", version: 2,
    whitelistRemarkName: "测试会员", userPhone: "138****8000" };
  const wx = { setNavigationBarTitle() {}, getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key), navigateTo: options => calls.push(["navigate", options]), showToast: options => calls.push(["toast", options]),
    navigateBack: options => calls.push(["back", options]), redirectTo: options => calls.push(["redirect", options]),
    switchTab: options => calls.push(["tab", options]), showModal: options => calls.push(["modal", options]) };
  const deps = {
    schedules: { dayPath: require("../../../miniprogram/services/schedules").dayPath,
      day: async (...args) => { calls.push(["day", ...args]); return app.globalData.user?.role === "admin"
        ? { serverNowMs: now, ...plain(day) } : plain(day); },
      list: async date => ({ today: day.today, daysVisible: day.daysVisible, therapists: [{ id: "t", name: "芳疗师", status: "available" }] }),
      changeDay: async (...args) => calls.push(["change", ...args]) },
    appointment: { detail: async () => ({ appointment: plain(record) }), calendarStatus: async () => ({ statuses: [] }),
      create: async payload => calls.push(["create", plain(payload)]), modify: async (id, payload) => calls.push(["modify", id, plain(payload)]) },
    user: { serviceItems: async () => ({ items: [{ id: "p", name: "项目一" }, { id: "q", name: "项目二" }] }), business: async () => ({}) }
  };
  const cache = new Map();
  function run(file, extra) {
    const globals = { wx, getApp: () => app, getCurrentPages: () => stack, Date: Clock, performance,
      setInterval: fn => { intervals.set(++timer, fn); return timer; }, clearInterval: id => intervals.delete(id),
      setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id), ...extra };
    globals.require = name => {
      if (deps[name.split("/").at(-1)]) return deps[name.split("/").at(-1)];
      const res = path.resolve(path.dirname(file), name + ".js");
      if (!cache.has(res)) {
        const mod = { exports: {} }; run(res, { module: mod }); cache.set(res, mod.exports);
      }
      return cache.get(res);
    };
    vm.runInNewContext(fs.readFileSync(file, "utf8"), globals, { filename: file });
  }
  function page(file) {
    let p; run(path.join(root, file + "/index.js"), { Page: value => { p = value; } });
    p.route = file; p.setData = function (patch, cb) { Object.assign(this.data, patch); if (cb) cb(); };
    return p;
  }
  function board(editing = false) {
    let def; run(path.join(root, "components/day-schedule/index.js"), { Component: value => { def = value; } });
    const events = [];
    const c = { ...def.methods, data: def.data, properties: { visible: true,
      target: { therapistId: day.therapistId, date: day.date, appointmentId: editing ? record.id : "" } },
      setData(patch) { Object.assign(this.data, patch); }, triggerEvent(type, data) { events.push([type, data]); } };
    def.lifetimes.attached.call(c);
    c.detach = () => def.lifetimes.detached.call(c);
    return c;
  }
  return { app, day, record, deps, wx, stack, calls, page, board, storage, timers, intervals,
    loginReturn: () => cache.get(path.join(root, "utils/loginReturn.js")),
    setNow(value) { now = Date.parse(value); for (const fn of [...intervals.values()]) fn(); },
    runTimers() { for (const fn of timers.values()) fn(); timers.clear(); } };
}

const inputEvent = (board, value) => ({ currentTarget: { dataset: { viewVersion: board.data.viewVersion } }, detail: { value } });
const tap = (board, time) => board.tapPoint({ currentTarget: { dataset: { time, viewVersion: board.data.viewVersion } } });
async function confirmLatest(h, confirm = true) {
  const modal = h.calls.filter(call => call[0] === "modal").at(-1)?.[1];
  if (!modal) throw new Error("Expected a confirmation dialog");
  try { return await modal.success({ confirm }); } finally { if (modal.complete) modal.complete(); }
}
module.exports = { setup, flush, plain, tap, inputEvent, confirmLatest };
