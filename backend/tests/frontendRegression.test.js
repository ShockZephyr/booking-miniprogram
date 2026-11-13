const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const filterEvent = (page, value, field) => ({ currentTarget: { dataset: { filterVersion: page.data.filterVersion, field } }, detail: { value } });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
test("weekly editor stops at the final grid point and only prepends through the top add button", async () => {
  const { page } = await weeklyEditor();
  page.data.ranges = [{ startTime: "09:00", endTime: "12:00" }, { startTime: "14:00", endTime: "23:30" }];
  page.addRange();
  assert.equal(page.data.ranges.length, 2, "the tail action must not search an earlier gap");
  page.addRange({ currentTarget: { dataset: { placement: "before" } } });
  assert.equal(page.data.ranges.length, 3);
  const added = page.data.ranges[0];
  assert.equal(added.startTime, "04:00"); assert.equal(added.endTime, "07:00");
  assert.ok(page.data.ranges.slice(1).every(r => added.endTime <= r.startTime || added.startTime >= r.endTime));
  assert.deepEqual([...page.data.ranges].map(r => r.startTime), ["04:00", "09:00", "14:00"]);
});
function load(file, requireFn, globals = {}) {
  let definition;
  const clockGlobals = {
    Date: globals.Date || Date,
    setInterval: globals.setInterval || (() => 1),
    clearInterval: globals.clearInterval || (() => {})
  };
  const checkIn = loadModule("utils/checkIn.js", () => ({}), clockGlobals);
  const confirmation = loadModule("utils/confirmation.js", (name) => name === "./checkIn" ? checkIn : loadModule("utils/loginReturn.js", () => ({}), globals), globals);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../miniprogram", file), "utf8"), {
    require: (name) => name.endsWith("/utils/editorLifecycle") ? loadModule("utils/editorLifecycle.js", () => ({}), {
      getApp: () => ({ globalData: { user: { role: "admin" } } }), getCurrentPages: () => [definition], ...globals })
      : name.endsWith("/utils/filterTime") ? require("../../miniprogram/utils/filterTime")
      : name.endsWith("/utils/batchScheduleMemory") ? loadModule("utils/batchScheduleMemory.js", () => ({}), globals)
      : name.endsWith("/utils/scheduleSettingsSave") ? loadModule("utils/scheduleSettingsSave.js", () => ({}), globals)
      : name.endsWith("/utils/confirmation") ? confirmation : name.endsWith("/utils/checkIn") ? checkIn
      : name.endsWith("/utils/imageFallback") ? require("../../miniprogram/utils/imageFallback") : requireFn(name), Page: (value) => { definition = value; },
    App: (value) => { definition = value; }, ...globals
  });
  definition.setData = (patch, callback) => { Object.assign(definition.data, patch); if (callback) callback(); };
  return definition;
}

function loadModule(file, requireFn, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../miniprogram", file), "utf8"), {
    require: requireFn,
    module,
    exports: module.exports,
    ...globals
  });
  return module.exports;
}

test("calendar cancellation discards the draft date when reopened", () => {
  let definition;
  const events = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../miniprogram/components/calendar-drawer/index.js"), "utf8"), {
    Component: (value) => { definition = value; }
  });
  const calendar = {
    data: { ...definition.data },
    properties: { selected: "2026-10-20" },
    setData(patch) { Object.assign(this.data, patch); },
    triggerEvent(type, value) { events.push({ type, value }); }
  };
  definition.observers.visible.call(calendar, true);
  definition.methods.selectDay.call(calendar, { currentTarget: { dataset: { date: "2026-10-25" } } });
  definition.methods.close.call(calendar);
  definition.observers.visible.call(calendar, true);
  definition.methods.confirm.call(calendar);
  assert.equal(events.find((event) => event.type === "confirm").value.date, "2026-10-20");

  calendar.properties.selected = "2026-11-01";
  definition.observers.visible.call(calendar, true);
  definition.methods.confirm.call(calendar);
  assert.equal(events.at(-1).value.date, "2026-11-01");
});

const adminSession = { sessionKey: () => "manager:session", ensure: async () => true };
function adminAppointment(read) {
  return load("pages/admin/slot-appointment/index.js", name => name.endsWith("/admin") ? { appointment: read } : adminSession,
    { wx: { showToast() {} } });
}
test("administrator reads the original appointment snapshots and revisions after catalog removal", async () => {
  const appointment = { id: "a", status: "cancelled", date: "2020-01-01", startTime: "09:00", endTime: "10:30",
    therapistId: "former", therapistName: "历史芳疗师", serviceItemName: "历史项目" };
  const history = [{ id: 1, before: { ...appointment, startTime: "08:30", note: "原备注" } }];
  const page = adminAppointment(async id => { assert.equal(id, appointment.id); return {appointment, history}; });
  page.onLoad({ appointmentId: appointment.id }); await page.load();
  assert.equal(page.data.currentAppointment.therapistName, "历史芳疗师");
  assert.equal(page.data.currentAppointment.serviceItemName, "历史项目");
  assert.equal(page.data.currentAppointment.canCheckIn, false);
  assert.equal(page.data.historyAppointments[0].before.note, "原备注");
  assert.equal(page.data.historyAppointments[0].before.startTime, "08:30");
});

test("project and therapist management expose a shared recycle bin entry", () => {
  const projectsWxml = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/projects/index.wxml"), "utf8");
  const therapistsWxml = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/therapists/index.wxml"), "utf8");
  const projectsJs = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/projects/index.js"), "utf8");
  const therapistsJs = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/therapists/index.js"), "utf8");
  const projectService = fs.readFileSync(path.join(__dirname, "../../miniprogram/services/project.js"), "utf8");
  const therapistService = fs.readFileSync(path.join(__dirname, "../../miniprogram/services/therapist.js"), "utf8");
  const projectConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/projects/index.json"), "utf8"));
  const therapistConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/therapists/index.json"), "utf8"));
  const recycleConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/admin/recycle-bin/index.json"), "utf8"));
  const projectStyles = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/projects/index.wxss"), "utf8");
  const therapistStyles = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/therapists/index.wxss"), "utf8");
  assert.match(projectsWxml, /assets\/icons\/recycle-bin\.png/);
  assert.match(therapistsWxml, /assets\/icons\/recycle-bin\.png/);
  assert.match(projectsJs, /recycle-bin\/index\?type=project/);
  assert.match(therapistsJs, /recycle-bin\/index\?type=therapist/);
  assert.match(projectService, /projects\/purge[^\n]+method:'POST'/);
  assert.match(therapistService, /therapists\/purge[^\n]+method: "POST"/);
  assert.equal(projectConfig.navigationBarBackgroundColor, "#FFFFFF");
  assert.equal(therapistConfig.navigationBarBackgroundColor, "#FFFFFF");
  assert.equal(recycleConfig.navigationBarBackgroundColor, "#FFFFFF");
  assert.match(projectStyles, /\.manage-toolbar \{[^}]*background:#fff;[^}]*border-top:1rpx solid #e4e1e8;/s);
  assert.doesNotMatch(therapistsWxml, /class="manage-toolbar"/);
  assert.match(therapistsWxml, /class="title-row"[\s\S]*class="page-title">场馆芳疗师[\s\S]*wx:if="\{\{manage\}\}" class="recycle-entry"/);
  assert.match(therapistStyles, /\.title-row \{[^}]*display:flex;[^}]*justify-content:space-between;/s);
  const recycleWxml = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/admin/recycle-bin/index.wxml"), "utf8");
  assert.match(recycleWxml, /一键恢复/);
  assert.match(recycleWxml, /永久删除/);
  assert.match(recycleWxml, /满 \{\{retentionDays\}\} 天后将自动永久删除/);
});

test("recycle bin supports selecting all and restoring the selected records", async () => {
  const restored = [];
  const purged = [];
  let title = "";
  const projectApi = {
    recycleBin: async () => ({ items: [
      { id: "project-a", name: "项目甲" },
      { id: "project-b", name: "项目乙" }
    ], retentionDays: 45 }),
    restore: async (ids) => { restored.push(...ids); },
    purge: async (ids) => { purged.push(...ids); }
  };
  const page = load("pages/admin/recycle-bin/index.js", (name) => {
    if (name.endsWith("/project")) return projectApi;
    if (name.endsWith("/therapist")) return { recycleBin: async () => ({ therapists: [] }), restore: async () => {} };
    return {};
  }, {
    getApp: () => ({
      globalData: { token: "token", user: { role: "admin" } },
      refreshMe: async () => ({ role: "admin" })
    }),
    wx: {
      setNavigationBarTitle: ({ title: nextTitle }) => { title = nextTitle; },
      showToast() {},
      showModal: ({ success }) => success({ confirm: true }),
      navigateBack() {}
    }
  });
  page.onLoad({ type: "project" });
  page.onShow();
  await flush();
  assert.equal(title, "项目回收站");
  assert.equal(page.data.retentionDays, 45);
  assert.deepEqual(Array.from(page.data.items, (item) => item.id), ["project-a", "project-b"]);
  page.toggleAll();
  assert.deepEqual(Array.from(page.data.selectedIds), ["project-a", "project-b"]);
  page.load = () => {};
  page.restoreSelected();
  await flush();
  assert.deepEqual(restored, ["project-a", "project-b"]);
  assert.equal(page.data.saving, false);
  page.purgeSelected();
  await flush();
  assert.deepEqual(purged, ["project-a", "project-b"]);
  assert.equal(page.data.saving, false);
});

test("recycle bin discards an old administrator response after account switch", async () => {
  const pending = deferred();
  let currentUser = { role: "admin" };
  const page = load("pages/admin/recycle-bin/index.js", (name) => {
    if (name.endsWith("/project")) return {
      recycleBin: () => pending.promise,
      restore: async () => {},
      purge: async () => {}
    };
    if (name.endsWith("/therapist")) return { recycleBin: async () => ({ therapists: [] }) };
    return {};
  }, {
    getApp: () => ({
      globalData: { token: "token", user: currentUser },
      refreshMe: async () => currentUser
    }),
    wx: { setNavigationBarTitle() {}, showToast() {}, navigateBack() {} }
  });
  page.onLoad({ type: "project" });
  page.onShow();
  await flush();
  currentUser = { role: "user" };
  page.onShow();
  await flush();
  pending.resolve({ items: [{ id: "private", name: "已删除项目" }], retentionDays: 30 });
  await flush();
  assert.deepEqual(Array.from(page.data.items), []);
  assert.equal(page.data.loading, false);
});

async function dailyAdmin() {
  const day = { therapistId: "person", therapistName: "芳疗师", therapistBio: "公开简介", therapistImageSrc: "https://example.test/person.png",
    therapistTags: ["芳香护理", "面部调理", "深度放松课程"],
    date: "2999-01-01", today: "2999-01-01", daysVisible: 7, step: 30, minDuration: 90,
    ranges: [{startTime:"09:00",endTime:"14:00"}], busy: [{startTime:"09:00",endTime:"10:30"}],
    closed: ["12:00"], serviceItemIds: ["p1"], appointments: [{id:"existing",status:"checked_in"}] };
  const app = {globalData:{user:{id:"manager",role:"admin"}}};
  const h = { calls: [], toasts: [], day, reads: 0 };
  const schedules = {day: async () => { h.reads++; return {...day}; }, changeDay: async (id,body) => {
    h.calls.push([id, JSON.parse(JSON.stringify(body))]);
    if (h.reject) throw {statusCode:409,message:"未结束的预约仍在使用该项目"};
    if (body.close) day.closed = [...new Set([...day.closed,...body.close])];
    if (body.open) day.closed = day.closed.filter(time => !body.open.includes(time));
    if (body.serviceItemIds) day.serviceItemIds = body.serviceItemIds;
  }};
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../../miniprogram/components/day-schedule/index.js"),"utf8"), {
    Component: value => { definition = value; }, getApp: () => app,
    wx:{showToast: x => h.toasts.push(x.title)}, require: name => {
      if (name.endsWith("/schedules")) return schedules;
      if (name.endsWith("/loginReturn")) return adminSession;
      if (name.endsWith("/scheduleGrid")) return require("../../miniprogram/utils/scheduleGrid");
      if (name.endsWith("/imageFallback")) return require("../../miniprogram/utils/imageFallback");
      if (name.endsWith("/appointmentDisplay")) return require("../../miniprogram/utils/appointmentDisplay");
      if (name.endsWith("/scheduleBooking")) {
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../miniprogram/utils/scheduleBooking.js"), "utf8"), {
          module, getApp: () => app, require: () => ({})
        });
        return module.exports;
      }
      if (name.endsWith("/user")) return {serviceItems:async () => ({items:[
        {id:"p1",name:"六字项目名称"},{id:"p2",name:"短项目"},{id:"p3",name:"超过六个字的项目名称"}
      ]})};
      return {};
    }
  });
  h.page = Object.assign({ data: {...definition.data}, properties: {visible:true,target:{therapistId:day.therapistId,date:day.date}},
    _attached:true, triggerEvent(){}, setData(patch){ Object.assign(this.data,patch); } }, definition.methods);
  await h.page.load();
  h.tap = time => h.page.tapPoint({currentTarget:{dataset:{time,viewVersion:h.page.data.viewVersion}}});
  h.apply = action => h.page.applyDay({currentTarget:{dataset:{action,viewVersion:h.page.data.viewVersion}}});
  return h;
}

test("admin closes and reopens unused cells while neighboring checked-in cells and the end boundary stay protected", async () => {
  const h=await dailyAdmin();
  assert.deepEqual(h.page.data.projects.map(({id,wide})=>({id,wide})),[
    {id:"p1",wide:false},{id:"p2",wide:false},{id:"p3",wide:true}
  ]);
  h.tap("09:30"); h.tap("14:00"); h.tap("10:30");
  assert.deepEqual([...h.page.data.chosen],["10:30"]);
  assert.equal(h.page.data.canCloseChosen,true); assert.equal(h.page.data.canOpenChosen,false);
  await h.apply("close");
  assert.deepEqual(h.calls,[["person",{date:h.day.date,expectedStep:h.day.step,close:["10:30"]}]]);
  assert.equal(h.page.data.appointments[0].status,"checked_in");
  h.tap("10:30"); await h.apply("open");
  assert.deepEqual(h.calls[1],["person",{date:h.day.date,expectedStep:h.day.step,open:["10:30"]}]);
  assert.deepEqual([...h.page.data.day.closed],["12:00"]);
});

test("daily schedule keeps time cells equal and contained, while projects and appointments use responsive cards", () => {
  const template=fs.readFileSync(path.join(__dirname,"../../miniprogram/components/day-schedule/index.wxml"),"utf8");
  const styles=fs.readFileSync(path.join(__dirname,"../../miniprogram/components/day-schedule/index.wxss"),"utf8");
  assert.match(styles,/\.points \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[^}]*gap: 16rpx 14rpx;[^}]*width: 100%;/s);
  assert.match(styles,/\.point \{[^}]*align-items: center;[^}]*justify-content: center;[^}]*max-width: 100%;[^}]*height: 52px;/s);
  assert.match(template,/class="card projects"/);
  assert.match(template,/class="project-option \{\{item\.wide \? 'wide' : ''\}\}"/);
  assert.match(styles,/\.project-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
  assert.match(styles,/\.project-option\.wide \{[^}]*grid-column: 1 \/ -1;/s);
  assert.match(template,/class="card appointments"/);
  assert.match(template,/>关闭时段<\/button>/);
  assert.match(template,/>开启时段<\/button>/);
  assert.match(template,/disabled="\{\{saving \|\| confirmingDay \|\| !canCloseChosen\}\}"/);
  assert.match(template,/disabled="\{\{saving \|\| confirmingDay \|\| !canOpenChosen\}\}"/);
  assert.match(styles,/\.point\.selected \{[^}]*background: #fff4cf;[^}]*color: #5f4b18;/s);
  assert.match(styles,/\.point\.end-only, \.point\.limited \{[^}]*background: #fff;[^}]*border-style: dashed;/s);
  assert.match(template,/item\.disabled && item\.state !== 'end-only' && item\.state !== 'limited' \? 'inactive' : ''/);
  assert.match(template,/\{\{selectionGuide\}\}/);
  assert.doesNotMatch(template,/虚线框时间点仅可作为结束/);
  assert.match(styles,/\.close-action \{[^}]*background: #f6e9ea;[^}]*color: #793e44;/s);
  assert.match(styles,/\.open-action \{[^}]*background: #e5f2e8;[^}]*color: #356243;/s);
  assert.match(styles,/\.project-save \{[^}]*background: #e6e0f8;[^}]*color: #40374f;/s);
  assert.match(styles,/\.project-grid \{[^}]*row-gap: 5rpx;/s);
  assert.match(styles,/\.project-option \{[^}]*min-height: 36px;[^}]*padding: 0;/s);
  assert.match(template,/class="schedule-profile-card"[^]*?class="profile-identity"[^]*?class="profile-avatar"[^]*?class="profile-name">\{\{day\.therapistName\}\}<\/text>/);
  assert.match(template,/class="profile-specialties"[^]*?class="specialty-label">擅长项目：<\/text>[^]*?class="specialty-tags"/);
  assert.match(template,/wx:for="\{\{day\.therapistTags\}\}"[^]*?class="specialty-tag"/);
  assert.doesNotMatch(template,/profile-date|\{\{day\.date\}\}/);
  assert.doesNotMatch(template,/profile-bio|therapistBio|个人简介/);
  assert.match(styles,/\.profile-avatar \{[^}]*width: 96rpx;[^}]*height: 96rpx;[^}]*border-radius: 50%;/s);
  assert.match(styles,/\.profile-specialties \{[^}]*display: grid;[^}]*grid-template-columns: auto minmax\(0, 1fr\);/s);
  assert.match(styles,/\.specialty-tags \{[^}]*display: flex;[^}]*flex-wrap: wrap;/s);
  assert.match(styles,/\.schedule-guide \{[^}]*background: #eee9f7;[^}]*color: #50465e;/s);
  assert.match(template,/class="day-appointment-card"[^]*?bindtap="openAppointment"/);
  assert.match(template,/预约项目：[^]*?会员手机：[^]*?备注：/);
  assert.doesNotMatch(template,/\{\{item\.date\}\}|芳疗师：\{\{item\.therapistName/);
  assert.match(template,/class="appointment-chevron" src="\/assets\/icons\/chevron-left\.png"/);
  assert.match(template,/class="appointment-heading"[^]*?class="appointment-primary"[^]*?class="appointment-status status-\{\{item\.status\}\}"/);
  assert.match(styles,/\.appointment-heading \{[^}]*display: flex;[^}]*justify-content: flex-start;[^}]*gap: 10rpx;/s);
  assert.match(styles,/\.status-booked \{[^}]*color: #5c556b;[^}]*background: #fff4cf;/s);
  assert.match(styles,/\.status-checked_in \{[^}]*background: #e3f1e6;/s);
  assert.match(styles,/\.status-no_show \{[^}]*background: #fff1c7;/s);
  assert.match(styles,/\.status-cancelled \{[^}]*background: #f6e3e5;/s);
});

test("conflicting day projects refresh the original selection and keep the appointment visible",async () => {
  const h=await dailyAdmin();
  h.page.selectProjects({currentTarget:{dataset:{viewVersion:h.page.data.viewVersion}},detail:{value:["p2"]}}); h.reject=true;
  await h.apply("projects");
  assert.deepEqual(h.calls,[["person",{date:h.day.date,serviceItemIds:["p2"]}]]);
  assert.equal(h.page.data.appointments[0].id,"existing");
  assert.deepEqual([...h.page.data.projectIds],["p1"]);
  assert.equal(h.page.data.saving,false); assert.equal(h.reads,2);
  assert.match(h.toasts.at(-1),/未结束/);
});

test("image uploads use multipart with a dedicated timeout", () => {
  const requestSource = fs.readFileSync(path.join(__dirname, "../../miniprogram/utils/request.js"), "utf8");
  const serviceSource = fs.readFileSync(path.join(__dirname, "../../miniprogram/services/therapist.js"), "utf8");
  const envSource = fs.readFileSync(path.join(__dirname, "../../miniprogram/config/env.js"), "utf8");
  assert.match(requestSource, /wx\.uploadFile\(/);
  assert.match(requestSource, /timeout: options\.timeout \|\| env\.UPLOAD_TIMEOUT/);
  assert.match(serviceSource, /request\.uploadFile\(\{/);
  assert.match(serviceSource, /name: "image"/);
  assert.doesNotMatch(serviceSource, /encoding: "base64"/);
  assert.match(envSource, /UPLOAD_TIMEOUT: 60000/);
});

test("phone login explains membership use and stops when authorization is denied", () => {
  let toast = "";
  let loginCalls = 0;
  const page = load("pages/mine/index.js", () => ({ login: () => { loginCalls += 1; } }), {
    wx: { showToast: ({ title }) => { toast = title; } }
  });
  page.doLogin = () => { loginCalls += 1; };
  page.handlePhoneLogin({ detail: { errMsg: "getPhoneNumber:fail user deny" } });
  assert.equal(loginCalls, 0);
  assert.equal(toast, "未授权手机号，暂时无法登录和预约");
  page.handlePhoneLogin({ detail: { code: "phone-code" } });
  assert.equal(loginCalls, 1);
  const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/mine/index.wxml"), "utf8");
  assert.match(template, /手机号用于登录和查询会员资格/);
  assert.match(template, /手机号快捷登录/);
  assert.doesNotMatch(template, /微信|腾讯|WeChat|Weixin/i);
});

test("phone quick login keeps native authorization, duplicate protection and the booking return", async () => {
  const payloads = [], sessions = [], toasts = [];
  let nativeLogin, resumed = 0;
  const user = { id: "member", role: "user", effectiveRole: "member" };
  const page = load("pages/mine/index.js", (name) => name.endsWith("/services/auth") ? {
    login: async (payload) => { payloads.push(payload); return { token: "test-session", user }; }
  } : { resume: () => { resumed += 1; } }, {
    getApp: () => ({ globalData: { token: "" }, setSession: (token, account) => sessions.push({ token, account }) }),
    wx: { login: (options) => { nativeLogin = options; }, showToast: (options) => toasts.push(options.title) }
  });
  page.handlePhoneLogin({ detail: { code: "phone-code" } });
  page.handlePhoneLogin({ detail: { code: "duplicate-phone-code" } });
  assert.equal(page.data.loggingIn, true);
  assert.equal(payloads.length, 0, "authorization still waits for a real login code");
  nativeLogin.success({ code: "login-code" });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(payloads)), [{ loginCode: "login-code", phoneCode: "phone-code" }]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].account, user);
  assert.equal(page.data.user, user);
  assert.equal(page.data.loggingIn, false);
  assert.equal(resumed, 1);
  assert.deepEqual(toasts, ["登录成功"]);
});

test("native login failure uses store-neutral copy and permits retry without a session", async () => {
  const toasts = [];
  let nativeCalls = 0, apiCalls = 0;
  const page = load("pages/mine/index.js", () => ({ login: () => { apiCalls += 1; } }), {
    getApp: () => ({ globalData: { token: "" } }),
    wx: { login: (options) => { nativeCalls += 1; options.fail(); }, showToast: ({ title }) => toasts.push(title) }
  });
  page.handlePhoneLogin({ detail: { code: "phone-code" } });
  await flush();
  page.handlePhoneLogin({ detail: { code: "phone-code-retry" } });
  await flush();
  assert.equal(nativeCalls, 2);
  assert.equal(apiCalls, 0);
  assert.equal(page.data.user, null);
  assert.equal(page.data.loggingIn, false);
  assert.deepEqual(toasts, ["登录失败，请重试", "登录失败，请重试"]);
});

test("therapist list separates browsing from administrator selection", () => {
  const navigations = [];
  const page = load("pages/therapists/index.js", () => ({}), { wx: { navigateTo: (options) => navigations.push(options.url) } });
  page.select({ detail: { therapist: { id: "t" } } });
  assert.equal(navigations[0], "/pages/therapist-detail/index?id=t");
  page.data.manage = true;
  page.select({ detail: { therapist: { id: "t" } } });
  assert.equal(page.data.selectedId, "t");
  assert.equal(navigations.length, 1);
  page.edit(); page.add();
  assert.equal(navigations[1], "/pages/admin/therapist-edit/index?id=t");
  assert.equal(navigations[2], "/pages/admin/therapist-edit/index");
});

test("therapist editor uses active service items as selectable tags", async () => {
  const page = load("pages/admin/therapist-edit/index.js", (name) => {
    if (name.endsWith("/user")) return { serviceItems: async () => ({ items: [{ id: "a", name: "精油舒缓" }, { id: "b", name: "肩颈护理" }] }) };
    return {};
  }, { getApp: () => ({ globalData: { user: { role: "admin" } } }), wx: { setNavigationBarTitle() {}, showToast() {} } });
  page.onLoad({});
  await flush();
  assert.equal(page.data.serviceItems.length, 2);
  page.selectTags({ detail: { value: ["b"] } });
  assert.equal(page.data.tags.join(","), "b");
  assert.equal(page.data.serviceItems[1].checked, true);
  const editorWxml = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/admin/therapist-edit/index.wxml"), "utf8");
  const editorWxss = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/admin/therapist-edit/index.wxss"), "utf8");
  assert.match(editorWxml, /checkbox-group class="project-tags" bindchange="selectTags"/);
  assert.doesNotMatch(editorWxml, /tagInput|输入标签后点击添加/);
  assert.match(editorWxss, /\.form-input \{ min-height:48px; padding:18rpx 22rpx; \}/);
  assert.match(editorWxss, /\.form-input, \.form-textarea \{[^}]*line-height:1\.55;/);
});

test("review therapist profile can be edited without treating its fixed identifier as a phone", async () => {
  const calls = [], toasts = [];
  const record = { id: "review-staff", name: "审核测试芳疗师", phone: "review:therapist", bio: "原简介",
    imageUrl: "/uploads/therapists/test.png", serviceItemIds: [], isReviewTherapist: true };
  const page = load("pages/admin/therapist-edit/index.js", name => name.endsWith("/user")
    ? { serviceItems: async () => ({ items: [] }) }
    : { adminDetail: async () => ({ therapist: record }), save: async (id, input) => {
      calls.push({ id, input }); return { therapist: { ...record, ...input } };
    } }, {
    getApp: () => ({ globalData: { user: { role: "admin" } } }),
    wx: { setNavigationBarTitle() {}, showToast: x => toasts.push(x.title) }, setTimeout() {}
  });
  page.onLoad({ id: record.id }); await flush();
  page.input({ currentTarget: { dataset: { field: "bio" } }, detail: { value: "修改后的简介" } });
  page.save(); await flush();
  assert.equal(calls.length,1); assert.equal(calls[0].id,record.id);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].input)),{ bio: "修改后的简介" });
  assert.ok(!toasts.includes("请输入 11 位有效手机号"));
  page.applyProfile({ ...record, isReviewTherapist: false, phone: "bad-phone" },[]);
  page.save(); await flush();
  assert.equal(calls.length,1); assert.ok(toasts.includes("请输入 11 位有效手机号"));
});

test("therapist editor retains more than twelve tags and sends them all when creating", async () => {
  const items = Array.from({ length: 13 }, (_, index) => ({ id: `p${index}`, name: `项目${index}` }));
  let submitted;
  const page = load("pages/admin/therapist-edit/index.js", (name) => {
    if (name.endsWith("/user")) return { serviceItems: async () => ({ items }) };
    if (name.endsWith("/therapist")) return { save: async (id, input) => { submitted = input; return { therapist: { ...input, id: "created" } }; } };
    return {};
  }, {
    getApp: () => ({ globalData: { user: { role: "admin" } } }),
    wx: { setNavigationBarTitle() {}, showToast() {} }, setTimeout() {}
  });
  page.onLoad({});
  await flush();
  page.selectTags({ detail: { value: items.map((item) => item.id) } });
  assert.equal(page.data.tags.length, 13);
  assert.equal(page.data.serviceItems.every((item) => item.checked), true);
  Object.assign(page.data, { name: "芳疗师", phone: "13800138000", imageUrl: "/uploads/therapists/example.png" });
  page.submitSave();
  await flush();
  assert.equal(submitted.serviceItemIds.length, 13);
  const wxml = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/admin/therapist-edit/index.wxml"), "utf8");
  assert.doesNotMatch(wxml, /最多选择|tags.length\s*>=\s*12/);
});

test("therapist profile edits omit untouched tags and explicit tag edits include the snapshot version", async () => {
  const detail = deferred();
  const calls = [], submitted = [];
  const items = Array.from({ length: 13 }, (_, index) => ({ id: `p${index}`, name: `项目${index}` }));
  let record = { id: "therapist", name: "甲", phone: "13800138000", bio: "", imageUrl: "/uploads/therapists/a.png",
    serviceItemIds: items.map(item => item.id), specialtiesVersion: "snapshot" };
  const page = load("pages/admin/therapist-edit/index.js", (name) => {
    if (name.endsWith("/user")) return { serviceItems: async (options) => {
      calls.push("catalog"); assert.equal(options.force, true); return { items };
    } };
    if (name.endsWith("/therapist")) return {
      adminDetail: () => { calls.push("profile"); return detail.promise; },
      save: async (id, input) => {
        submitted.push(input);
        record = { ...record, ...input, specialtiesVersion: "after-" + submitted.length };
        return { therapist: record };
      }
    };
    return {};
  }, {
    getApp: () => ({ globalData: { user: { role: "admin" } } }),
    wx: { setNavigationBarTitle() {}, showToast() {} }, setTimeout() {}
  });
  page.onLoad({ id: "therapist" });
  await flush();
  assert.deepEqual(calls, ["profile"]);
  detail.resolve({ therapist: record });
  await flush();
  assert.deepEqual(calls, ["profile", "catalog"]);
  assert.equal(page.data.tags.length, 13);
  page.data.bio = "仅更新简介";
  page.submitSave();
  await flush();
  assert.deepEqual(Object.keys(submitted[0]), ["bio"]);
  assert.equal(Object.hasOwn(submitted[0], "serviceItemIds"), false);
  page.selectTags({ detail: { value: items.slice(1).map((item) => item.id) } });
  page.submitSave();
  await flush();
  assert.equal(submitted[1].serviceItemIds.length, 12);
  assert.equal(submitted[1].specialtiesVersion, "after-1");
  page.selectTags({ detail: { value: [] } });
  page.submitSave();
  await flush();
  assert.equal(submitted[2].serviceItemIds.length, 0);
  page.selectTags({ detail: { value: items.map((item) => item.id).reverse() } });
  page.submitSave();
  await flush();
  assert.equal(submitted[3].serviceItemIds.length, 13);
  page.selectTags({ detail: { value: items.map(item => item.id) } });
  page.submitSave(); await flush();
  assert.equal(submitted.length, 4, "changing only the order of checked tags does not submit");
});

test("logout failures keep the session, allow retry, and suppress duplicate requests", async () => {
  const pending = deferred();
  const toasts = [], navigations = [];
  let requests = 0, cleared = 0, prompts = 0;
  const app = { globalData: { token: "token", user: { id: "user" } }, clearSession() { cleared++; this.globalData.token = ""; this.globalData.user = null; } };
  const page = load("pages/settings/index.js", (name) => name.endsWith("/auth") ? {
    logout: () => { requests++; return requests === 1 ? pending.promise : Promise.resolve({ loggedOut: true }); }
  } : {}, { getApp: () => app, wx: {
    showModal: (options) => { prompts++; options.success({ confirm: true }); },
    showToast: (options) => toasts.push(options.title),
    switchTab: (options) => navigations.push(options.url)
  } });
  page.logout(); page.logout();
  assert.equal(requests, 1);
  assert.equal(prompts, 1);
  assert.equal(page.data.loggingOut, true);
  pending.reject({ code: "NETWORK_ERROR" });
  await flush();
  assert.equal(cleared, 0);
  assert.equal(app.globalData.token, "token");
  assert.equal(navigations.length, 0);
  assert.match(toasts[0], /退出未完成.*重试/);
  assert.equal(page.data.loggingOut, false);
  page.logout();
  await flush();
  assert.equal(requests, 2);
  assert.equal(cleared, 1);
  assert.deepEqual(navigations, ["/pages/home/index"]);
});

for (const code of ["INVALID_SESSION", "NOT_LOGGED_IN", "SERVER_ERROR"]) {
  test(`logout handles ${code} without an unhandled rejection`, async () => {
    let cleared = 0, navigated = 0, toasted = 0;
    const app = { globalData: { token: "token", user: { id: "user" } }, clearSession() { cleared++; } };
    const page = load("pages/settings/index.js", (name) => name.endsWith("/auth") ? {
      logout: async () => { throw { code }; }
    } : {}, { getApp: () => app, wx: {
      showModal: (options) => options.success({ confirm: true }),
      switchTab: () => { navigated++; }, showToast: () => { toasted++; }
    } });
    page.logout();
    await flush();
    const expired = code !== "SERVER_ERROR";
    assert.equal(cleared, expired ? 1 : 0);
    assert.equal(navigated, expired ? 1 : 0);
    assert.equal(toasted, expired ? 0 : 1);
    assert.equal(page.data.loggingOut, false);
  });
}

for (const failure of [false, true]) {
  test(`a ${failure ? "failed" : "successful"} old logout cannot clear a new login`, async () => {
    const pending = deferred();
    const app = { globalData: { token: "old", user: { id: "old-user" } }, clearSession: () => assert.fail("new login must survive") };
    const page = load("pages/settings/index.js", (name) => name.endsWith("/auth") ? {
      logout: () => pending.promise
    } : {}, { getApp: () => app, wx: {
      showModal: (options) => options.success({ confirm: true }),
      switchTab: () => assert.fail("must not navigate away from new login"),
      showToast: () => assert.fail("must not show a stale logout failure")
    } });
    page.logout();
    app.globalData = { token: "new", user: { id: "new-user" } };
    if (failure) pending.reject({ code: "INVALID_SESSION" });
    else pending.resolve({ loggedOut: true });
    await flush();
    assert.equal(app.globalData.token, "new");
    assert.equal(page.data.loggingOut, false);
  });
}

test("logout confirmation is single-instance and cannot log out a newly switched account", () => {
  let modal, prompts = 0;
  const app = { globalData: { token: "old", user: { id: "old-user" } } };
  const page = load("pages/settings/index.js", (name) => name.endsWith("/auth") ? {
    logout: () => assert.fail("confirmation belongs to the old account")
  } : {}, { getApp: () => app, wx: { showModal: (options) => { prompts++; modal = options; } } });
  page.logout(); page.logout();
  assert.equal(prompts, 1);
  app.globalData = { token: "new", user: { id: "new-user" } };
  modal.success({ confirm: true });
  assert.equal(page.data.loggingOut, false);
});

async function weeklyEditor(singleId) {
  const h={writes:[],modals:[],toasts:[],owner:"session",reads:[],rules:{}};
  const empty={step:30,minDuration:90,ranges:[],serviceItemIds:[]};
  const page=load("pages/admin/batch-slots/index.js",name=>{
    if(name.endsWith("/loginReturn")) return {sessionKey:()=>h.owner,ensure:async()=>true};
    if(name.endsWith("/admin")) return {weekly:async(id,day)=>{h.reads.push([id,day]);return h.rules[day] || empty;},
      saveWeekly:async payload=>{h.writes.push(JSON.parse(JSON.stringify(payload)));}};
    if(name.endsWith("/therapist")) return {list:async()=>({therapists:[{id:"t1",name:"甲"},{id:"t2",name:"乙"}]})};
    if(name.endsWith("/user")) return {serviceItems:async()=>({items:[{id:"p1"},{id:"p2"}]})};
    return {};
  },{wx:{setNavigationBarTitle(){},showModal: x=>h.modals.push(x),showToast:x=>h.toasts.push(x.title)}});
  require("./support/weeklyFormEvents").install(page);
  h.page=page; page.onLoad(singleId?{therapistId:singleId}:{}); await page.onShow();
  return h;
}
const selection = value => ({detail:{value}});

test("batch weekly updates confirm the scope and send one operation for all selected people and weekdays", async ()=>{
  const h=await weeklyEditor(), p=h.page;
  assert.equal(p.data.therapistIds.length,0);
  assert.equal(p.data.selectedDays.length,0);
  p.allPeople(); p.pickDays(selection(["1","7"])); p.selectProjects(selection(["p1"]));
  const cancelled=p.save(); h.modals[0].success({confirm:false}); await cancelled;
  assert.equal(h.writes.length,0);
  const saved=p.save(); p.save();
  assert.equal(h.modals.length,2); assert.match(h.modals[1].content,/2 位芳疗师 × 2 个星期，共 4 组/);
  h.modals[1].success({confirm:true}); await saved;
  assert.deepEqual(h.writes,[{therapistIds:["t1","t2"],weekdays:[1,7],
    schedule:{step:30,minDuration:90,ranges:[{startTime:"09:00",endTime:"12:00"}, {startTime:"12:30",endTime:"15:00"}, {startTime:"15:30",endTime:"18:00"}, {startTime:"18:30",endTime:"20:30"}]},serviceItemIds:["p1"]}]);
});

test("batch weekly select-all keeps all seven days selected and cannot change a pending save's scope", async ()=>{
  const h=await weeklyEditor(), p=h.page;
  p.selectPeople(selection(["t1"])); p.pickDays(selection(["2"])); p.addRange();
  const pending=p.save();
  p.allDays(); p.allPeople();
  assert.deepEqual([...p.data.selectedDays],[2]);
  assert.deepEqual([...p.data.therapistIds],["t1"]);
  h.modals[0].success({confirm:false}); await pending;
  p.allDays(); p.allDays(); p.allPeople(); p.allPeople();
  assert.deepEqual([...p.data.selectedDays],[1,2,3,4,5,6,7]);
  assert.ok(p.data.weekdays.every(day=>day.checked));
  assert.deepEqual([...p.data.therapistIds],["t1","t2"]);
  p.pickDays(selection(["1","5"]));
  assert.deepEqual([...p.data.weekdays].filter(day=>day.checked).map(day=>day.value),[1,5]);
  p.allDays();
  const saved=p.save();
  assert.match(h.modals[1].content,/2 位芳疗师 × 7 个星期，共 14 组/);
  h.modals[1].success({confirm:true}); await saved;
  assert.equal(h.writes.length,1);
  assert.deepEqual(h.writes[0].weekdays,[1,2,3,4,5,6,7]);
  assert.deepEqual(h.writes[0].therapistIds,["t1","t2"]);
  h.owner="different-account";
  p.pickDays(selection(["3"])); p.selectPeople(selection(["t2"]));
  assert.equal(p.data.selectedDays.length,7); assert.equal(p.data.therapistIds.length,2);
  const single=await weeklyEditor("t1"); single.page.allDays();
  assert.deepEqual([...single.page.data.selectedDays],[1]);
});

test("weekly precision radio events retain entered times and enforce the existing grid and minimum rules", async ()=>{
  const h=await weeklyEditor(), p=h.page;
  p.allPeople(); p.pickDays(selection(["1"]));
  for(const [step,last] of [[10,"23:50"],[15,"23:45"],[30,"23:30"]]) {
    p.setStep(selection(String(step)));
    assert.equal(p.data.step,step);
    assert.equal(p.data.times.at(-1),last);
  }
  while(p.data.ranges.length) p.removeRange({currentTarget:{dataset:{index:0}}});
  p.setStep(selection("10")); p.addRange();
  for(const [field,time] of [["startTime","09:10"],["endTime","12:10"]]) {
    p.setTime({currentTarget:{dataset:{index:0,field}},detail:{value:p.data.times.indexOf(time)}});
  }
  p.setMinimum(selection("100")); p.setStep(selection("15"));
  assert.equal(p.data.ranges[0].startTime,"09:10");
  assert.equal(p.data.ranges[0].endTime,"12:10"); assert.equal(p.data.minDuration,"100");
  await p.save(); assert.match(h.toasts.at(-1),/正整数倍/);
  p.setMinimum(selection("90")); await p.save(); assert.match(h.toasts.at(-1),/精度/);
  assert.equal(h.modals.length,0); assert.equal(h.writes.length,0);
  p.setStep(selection("10"));
  for(const invalid of ["bad","-1","3","1.5"]) p.setStep(selection(invalid));
  assert.equal(p.data.step,10);
  const saved=p.save(); p.setStep(selection("30"));
  assert.equal(p.data.step,10,"precision stays fixed while the confirmation is open");
  h.modals[0].success({confirm:true}); await saved;
  assert.deepEqual(h.writes[0].schedule,{step:10,minDuration:90,ranges:[{startTime:"09:10",endTime:"12:10"}]});
});

test("weekly editor always saves schedules and projects together; invalid durations and overlap still block changes",async()=>{
  const h=await weeklyEditor(), p=h.page;
  p.selectPeople(selection(["t2"])); p.pickDays(selection(["3"]));
  for(const [step,last] of [[10,"23:50"],[15,"23:45"],[30,"23:30"]]){
    p.setStep(selection(String(step))); assert.equal(p.data.times.at(-1),last);
  }
  p.setMinimum(selection("45")); await p.save(); assert.equal(h.modals.length,0);
  p.setMinimum(selection("90"));
  p.setTime({currentTarget:{dataset:{index:1,field:"startTime"}},detail:{value:p.data.times.indexOf("10:00")}});
  await p.save(); assert.match(h.toasts.at(-1),/重叠/); assert.equal(h.writes.length,0);
  p.setTime({currentTarget:{dataset:{index:1,field:"startTime"}},detail:{value:p.data.times.indexOf("12:30")}});
  p.selectProjects(selection(["p2"]));
  const saved=p.save(); h.modals[0].success({confirm:true}); await saved;
  assert.deepEqual(h.writes,[{therapistIds:["t2"],weekdays:[3],serviceItemIds:["p2"],
    schedule:{step:30,minDuration:90,ranges:[{startTime:"09:00",endTime:"12:00"},{startTime:"12:30",endTime:"15:00"},{startTime:"15:30",endTime:"18:00"},{startTime:"18:30",endTime:"20:30"}]}}]);
});

test("switching weekdays drops an older weekly rule, and changing account cancels an open save confirmation",async()=>{
  const h=await weeklyEditor("t1"), p=h.page, old=deferred();
  h.rules[2]=old.promise;
  const first=p.pickWeekday({currentTarget:{dataset:{day:2}}});
  h.rules[5]={step:15,minDuration:45,ranges:[{startTime:"13:00",endTime:"16:00"}],serviceItemIds:["p2"]};
  await p.pickWeekday({currentTarget:{dataset:{day:5}}});
  old.resolve({step:10,minDuration:20,ranges:[],serviceItemIds:[]});await first;
  assert.deepEqual([...p.data.selectedDays],[5]); assert.equal(p.data.step,15); assert.equal(p.data.ranges[0].startTime,"13:00");
  p.setMinimum(selection("60"));
  const pending=p.save(); h.owner="other"; h.modals[0].success({confirm:true});await pending;
  assert.equal(h.writes.length,0);
});

test("home therapist section is a rounded card and renders the all link as text", () => {
  const homeWxml = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/home/index.wxml"), "utf8");
  const homeJs = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/home/index.js"), "utf8");
  const mineJs = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/mine/index.js"), "utf8");
  assert.match(homeWxml, /class="therapist-section card"/);
  assert.match(homeWxml, /\{\{allTherapistsLabel\}\}/);
  assert.doesNotMatch(homeWxml, /&gt;/);
  assert.match(homeJs, /allTherapistsLabel:\s*"全部>"/);
  const whitelistPosition = mineJs.indexOf('page: "whitelist"');
  const therapistsPosition = mineJs.indexOf('page: "therapists"');
  assert.ok(therapistsPosition > whitelistPosition);
  assert.match(mineJs, /admin-therapists\.png/);
});

test("home shortcuts use functional color roles while the tab bar keeps one lavender system", () => {
  const root = path.join(__dirname, "../../miniprogram");
  const homeJs = fs.readFileSync(path.join(root, "pages/home/index.js"), "utf8");
  const homeWxml = fs.readFileSync(path.join(root, "pages/home/index.wxml"), "utf8");
  const homeWxss = fs.readFileSync(path.join(root, "pages/home/index.wxss"), "utf8");
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));

  for (const tone of ["lavender", "sage", "amber", "rose"]) {
    assert.match(homeJs, new RegExp(`tone: "${tone}"`));
    assert.match(homeWxss, new RegExp(`\\.quick-${tone} \\{`));
    assert.doesNotMatch(homeWxss, new RegExp(`\\.quick-${tone} \\{[^}]*color:`, "s"));
    assert.match(homeWxss, new RegExp(`\\.quick-${tone} \\{[^}]*background: #ffffff;`, "s"));
    assert.doesNotMatch(homeWxss, new RegExp(`\\.quick-${tone} \\{[^}]*border-color:`, "s"));
  }
  assert.match(homeWxml, /class="quick-item quick-\{\{item\.tone\}\} card"/);
  assert.match(homeWxml, /hover-class="quick-item-pressed"/);
  assert.match(homeWxss, /\.quick-item \{[^}]*color: #2f2f32;/s);
  assert.doesNotMatch(homeWxss, /\.quick-label \{[^}]*font-weight:/s);
  assert.equal(appConfig.tabBar.color, "#776E80");
  assert.equal(appConfig.tabBar.selectedColor, "#8663AA");
  assert.ok(appConfig.tabBar.list.every((item) => item.iconPath && item.selectedIconPath));
});

test('project dragging saves the displayed order and restores it on request failure', async () => {
  const projectWxml=fs.readFileSync(path.join(__dirname,'../../miniprogram/pages/projects/index.wxml'),'utf8');
  const projectWxss=fs.readFileSync(path.join(__dirname,'../../miniprogram/pages/projects/index.wxss'),'utf8');
  assert.match(projectWxml,/class="project-row[^\"]*"[\s\S]*?bindlongpress="startDrag"[\s\S]*?bindtouchmove="moveDrag"/);
  assert.match(projectWxml,/class="drag-handle"/);
  assert.match(projectWxml,/project-move-up\.png/);
  assert.match(projectWxml,/project-move-down\.png/);
  assert.match(projectWxss,/\.reorder-button \{[^}]*background:transparent;/s);
  const requests=[];
  const page=load('pages/projects/index.js',()=>({reorder:ids=>{const pending=deferred();requests.push({ids,pending});return pending.promise;}}),{
    wx:{showToast(){}},clearInterval,setInterval
  });
  page.original=[{id:'a'},{id:'b'},{id:'c'}];
  page.data.items=page.original.slice();page.data.dragging=true;page.data.dragId='a';
  page.viewport={top:100};page.rowHeights=new Map([['a',100],['b',100],['c',100]]);page.contentInset=0;page.pointerY=351;
  page.positionDrag();
  assert.equal(page.data.items.map(i=>i.id).join(),'b,c,a');
  page.endDrag();
  assert.equal(page.data.saving,true);
  assert.equal(requests[0].ids.join(),'b,c,a');
  requests[0].pending.reject({message:'failed'});await flush();
  assert.equal(page.data.items.map(i=>i.id).join(),'a,b,c');
  assert.equal(page.data.saving,false);
});

test('project move buttons provide a non-gesture sorting path', async () => {
  const request=deferred();let savedIds;
  const page=load('pages/projects/index.js',()=>({reorder:ids=>{savedIds=ids;return request.promise;}}),{
    wx:{showToast(){}},clearInterval,setInterval
  });
  page.data.manage=true;
  page.data.items=[{id:'a',name:'甲'},{id:'b',name:'乙'},{id:'c',name:'丙'}];
  page.moveProject({currentTarget:{dataset:{id:'b',direction:-1}}});
  assert.equal(page.data.items.map(i=>i.id).join(),'b,a,c');
  assert.equal(savedIds.join(),'b,a,c');
  assert.equal(page.data.saving,true);
  request.resolve();await flush();
  assert.equal(page.data.saving,false);
  assert.match(page.data.sortMessage,/乙已移动至第1位/);
});

test('homepage recommends only the first five projects in server order',async()=>{
  const page=load('pages/home/index.js',name=>name.endsWith('/project')?{list:async()=>({items:Array.from({length:7},(_,i)=>({id:String(i)}))})}:{},{});
  page.loadProjects();await flush();
  assert.equal(page.data.projects.map(i=>i.id).join(),'0,1,2,3,4');
});

test("schedule management opens a weekly template only for the selected active person",async()=>{
  const calls=[];
  const p=load("pages/admin/calendar/index.js",name=>{
    if(name.endsWith("/loginReturn")) return adminSession;
    if(name.endsWith("/admin")) return {scheduleSettings:async()=>({daysVisible:7})};
    return {list:async()=>({therapists:[{id:"active",name:"甲"}]})};
  },{wx:{navigateTo:({url})=>calls.push(url)}});
  await p.load();
  p.edit({detail:{therapist:{id:"missing"}}}); p.edit({detail:{therapist:{id:"active"}}}); p.batch();
  assert.deepEqual(calls,["/pages/admin/batch-slots/index?therapistId=active","/pages/admin/batch-slots/index"]);
});

test("switching appointment filter discards a pending previous-page append", async () => {
  const requests = [];
  const page = load("pages/my-appointments/index.js", () => ({
    my: () => { const request = deferred(); requests.push(request); return request.promise; }
  }), { wx: { showToast: () => assert.fail("stale request must not show an error") } });
  page.data.hasMore = true;
  page.load({ append: true });
  page.switchTab({ currentTarget: { dataset: { key: "cancelled" } } });
  requests[1].resolve({ appointments: [{ id: "new", status: "cancelled" }], pagination: { page: 1, hasMore: false } });
  await flush();
  requests[0].resolve({ appointments: [{ id: "old", status: "booked" }], pagination: { page: 2, hasMore: true } });
  await flush();
  assert.equal(page.data.appointments.length, 1);
  assert.equal(page.data.appointments[0].id, "new");
  assert.equal(page.data.page, 1);
  assert.equal(page.data.loadingMore, false);
});

test("appointment list derives staff mode from the refreshed account instead of route parameters", async () => {
  const refresh = deferred();
  let adminCalls = 0, therapistCalls = 0, customerCalls = 0;
  const therapistUser = { id: "therapist-user", role: "user", therapistId: "therapist-1" };
  const app = {
    globalData: { token: "therapist-token", user: therapistUser },
    refreshMe: () => refresh.promise
  };
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.endsWith("/admin")) return { appointments: async () => { adminCalls++; return { appointments: [] }; } };
    if (name.endsWith("therapistPortal")) return { appointments: async () => { therapistCalls++; return { appointments: [] }; } };
    if (name.endsWith("/appointment")) return { my: async () => { customerCalls++; return { appointments: [] }; } };
    if (name.endsWith("/user")) return { serviceItems: async () => ({ items: [] }) };
    if (name.includes("utils/date")) return { today: () => "2999-01-01", addDays: (date) => date };
    if (name.includes("timePicker")) return { valueFromTime: () => [], range: [] };
    return {};
  }, {
    getApp: () => app,
    wx: { setNavigationBarTitle() {}, showToast() {} }
  });
  page.onLoad({ status: "pending", admin: "1" });
  page.onShow();
  assert.equal(page.data.isAdminMode, false);
  refresh.resolve(therapistUser);
  await flush();
  await flush();
  assert.equal(page.data.isAdminMode, false);
  assert.equal(page.data.isTherapistMode, true);
  assert.equal(adminCalls, 0);
  assert.equal(therapistCalls, 1);
  assert.equal(customerCalls, 0);
});

test("administrator appointment mode does not depend on an admin route parameter", async () => {
  let adminCalls = 0, customerCalls = 0;
  const adminUser = { id: "admin", role: "admin", therapistId: "therapist-1" };
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.endsWith("/admin")) return {
      appointments: async () => { adminCalls++; return { appointments: [] }; }
    };
    if (name.endsWith("/appointment")) return { my: async () => { customerCalls++; return { appointments: [] }; } };
    if (name.endsWith("/user")) return { serviceItems: async () => ({ items: [] }) };
    if (name.endsWith("/therapist")) return { list: async () => ({ therapists: [] }) };
    if (name.includes("utils/date")) return { today: () => "2999-01-01", addDays: (date) => date };
    if (name.includes("timePicker")) return { valueFromTime: () => [], range: [] };
    return {};
  }, {
    getApp: () => ({ globalData: { token: "", user: adminUser } }),
    wx: { setNavigationBarTitle() {}, showToast() {} }
  });
  page.onLoad({ status: "pending" });
  page.onShow();
  await flush();
  assert.equal(page.data.isAdminMode, true);
  assert.equal(page.data.isTherapistMode, false);
  assert.equal(adminCalls, 1);
  assert.equal(customerCalls, 0);
});

test("project management controls are removed when the refreshed account is not an administrator", async () => {
  const refresh = deferred();
  const app = {
    globalData: { token: "customer-token", user: { id: "old-admin", role: "admin" } },
    refreshMe: () => refresh.promise
  };
  const page = load("pages/projects/index.js", () => ({ list: async () => ({ items: [] }) }), {
    getApp: () => app,
    wx: { setNavigationBarTitle() {} },
    clearInterval() {}
  });
  page.onLoad({ manage: "1" });
  assert.equal(page.data.manage, true);
  app.globalData.user = { id: "customer", role: "user" };
  page.onShow();
  assert.equal(page.data.manage, false);
  refresh.resolve(app.globalData.user);
  await flush();
  assert.equal(page.data.manage, false);
});

test("therapist management controls are removed when the refreshed account is not an administrator", async () => {
  const refresh = deferred();
  const app = {
    globalData: { token: "customer-token", user: { id: "old-admin", role: "admin" } },
    refreshMe: () => refresh.promise
  };
  const page = load("pages/therapists/index.js", () => ({ list: async () => ({ therapists: [] }) }), {
    getApp: () => app,
    wx: { navigateTo: () => assert.fail("customer must not open the therapist editor") }
  });
  page.onLoad({ manage: "1" });
  page.data.manage = true;
  app.globalData.user = { id: "customer", role: "user" };
  page.onShow();
  assert.equal(page.data.manage, false);
  refresh.resolve(app.globalData.user);
  await flush();
  assert.equal(page.data.manage, false);
  page.add();
});

test("appointment actions use native confirmation before changing state", async () => {
  let modal,cancelCalls=0;
  const app={globalData:{user:{id:"customer",role:"user"},token:"synthetic-session"}};
  const page=load("pages/my-appointments/index.js",(name)=>name.endsWith("/appointment")?{
    cancel:async()=>{cancelCalls++;}
  }:{},{getApp:()=>app,wx:{showModal:options=>{modal=options;},showToast(){}}});
  const appointment={id:"a",userId:"customer",canCancel:true,status:"booked"};
  page.data.appointments=[appointment];
  page.cardAction({detail:{type:"cancel",appointment}});
  assert.match(modal.content,/重新向所有人开放/);
  modal.success({confirm:false});
  await flush();
  assert.equal(cancelCalls,0);
  page.load=()=>{};
  page.cardAction({detail:{type:"cancel",appointment}});
  modal.success({confirm:true});
  await flush();
  assert.equal(cancelCalls,1);
});

test("customer check-in warns that cancellation requires an administrator", () => {
  let modal;
  const page = load("pages/my-appointments/index.js", (name) => name.endsWith("/appointment") ? {
    checkIn: () => assert.fail("confirmation was not accepted")
  } : {}, { wx: { showModal: (options) => { modal = options; }, showToast() {} } });
  page.cardAction({ detail: { type: "checkIn", appointment: { id: "a", canCheckIn: true, status: "booked" } } });
  assert.match(modal.content, /后续如需取消签到，请联系管理员/);
});

test("appointment cards keep white surfaces, shared image layout and compact bottom actions", () => {
  const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/components/appointment-card/index.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../../miniprogram/components/appointment-card/index.wxss"), "utf8");
  assert.match(template, /class="project-picture"/);
  assert.match(template, /会员名称：/);
  assert.doesNotMatch(template, /!detail && actionMode === 'admin'[^>]*>会员手机：/);
  assert.match(template, /wx:if="\{\{actionMode === 'admin'\}\}" class="info-row"><text class="row-label">会员手机<\/text>/);
  assert.match(styles, /\.appointment-card \{[^}]*background: #ffffff;/s);
  assert.match(styles, /\.compact-actions \{[^}]*grid-row: 3;[^}]*justify-self: end;/s);
  assert.match(styles, /\.compact-action \{[^}]*width: 108rpx;[^}]*height: 60rpx;/s);
  assert.match(template, /class="time appointment-time"/);
  assert.match(styles, /\.list-layout\.mode-user \.detail-main \{[^}]*display: flex;[^}]*justify-content: space-between;/s);
  assert.match(styles, /\.list-layout\.mode-user \.title \{[^}]*font-size: 32rpx;/s);
  assert.match(styles, /\.list-layout\.mode-user \.detail-main > \.time,[^}]*\.list-layout\.mode-user \.detail-main > \.note \{[^}]*font-size: 28rpx;[^}]*margin-top: 0rpx;/s);
  assert.match(styles, /\.list-layout\.mode-therapist \.project-picture,[^}]*\.list-layout\.mode-admin \.project-picture \{[^}]*width: 180rpx;[^}]*height: auto;[^}]*align-self: stretch;/s);
  assert.match(styles, /\.list-layout \.title,[^}]*\.list-layout \.status \{[^}]*margin-bottom: 20rpx;/s);
  assert.match(styles, /\.detail-layout \.title,[^}]*\.detail-layout \.status \{[^}]*margin-bottom: 12rpx;/s);
  for (const name of ["checkin", "edit", "cancel"]) assert.ok(template.includes(`appointment-action-${name}.png`));
});

test("booking separates navigation, date strip, and content surfaces", () => {
  const root = path.join(__dirname, "../../miniprogram");
  const pageWxml = fs.readFileSync(path.join(root, "pages/booking/index.wxml"), "utf8");
  const pageWxss = fs.readFileSync(path.join(root, "pages/booking/index.wxss"), "utf8");
  const stripWxss = fs.readFileSync(path.join(root, "components/date-strip/index.wxss"), "utf8");
  const pageConfig = JSON.parse(fs.readFileSync(path.join(root, "pages/booking/index.json"), "utf8"));

  assert.match(pageWxml, /class="date-strip-shell"/);
  assert.match(pageWxml, /class="date-strip-inner"/);
  const dayPageWxml = fs.readFileSync(path.join(root, "pages/schedule-day/index.wxml"), "utf8");
  const stripWxml = fs.readFileSync(path.join(root, "components/date-strip/index.wxml"), "utf8");
  assert.match(pageWxml, /<date-strip\b/);
  assert.match(dayPageWxml, /<date-strip\b/);
  assert.match(stripWxml, /src="\/assets\/icons\/booking-calendar\.png"/);
  assert.doesNotMatch(stripWxml, /calendarIconSrc|largeCalendarIcon/);
  assert.match(stripWxss, /\.date-item \{[^}]*width: 52px;[^}]*min-height: 52px;/s);
  assert.match(stripWxss, /\.calendar-button \{[^}]*width: 52px;[^}]*height: 52px;/s);
  assert.doesNotMatch(stripWxss, /\.calendar-button\.calendar-button-large/);
  assert.match(stripWxss, /\.calendar-icon \{[^}]*width: 52rpx;[^}]*height: 52rpx;/s);
  assert.ok(!pageConfig.navigationBarBackgroundColor || pageConfig.navigationBarBackgroundColor === "#FFFFFF");
  assert.ok(!pageConfig.backgroundColor || pageConfig.backgroundColor === "#F8F7FC");
});

test("user-facing copy is concise and avoids internal terms", () => {
  const files = [
    "app.js",
    "pages/booking/index.wxml",
    "pages/member/index.wxml",
    "pages/mine/index.wxml",
    "pages/my-appointments/index.js",
    "pages/admin/slot-appointment/index.js",
    "pages/static/agreement/index.wxml",
    "pages/static/privacy/index.wxml"
  ];
  const copy = files.map((file) => fs.readFileSync(path.join(__dirname, "../../miniprogram", file), "utf8")).join("\n");
  assert.doesNotMatch(copy, /active whitelist|Dashboard|AppSecret|access_token|操作成功|敬请期待|管理员操作会写入审计日志/);
  assert.match(copy, /登录后即可继续预约/);
  assert.doesNotMatch(copy, /关闭.*后预约会自动取消/);
});

test("therapist home shortcuts open only staff schedule and customer appointment views", async () => {
  const navigations = [], tabSwitches = [];
  const page = load("pages/home/index.js", (name) => {
    if (name.includes("config/business")) return {};
    if (name.endsWith("/user")) return { business: async () => ({}) };
    if (name.endsWith("/therapist")) return { list: async () => ({ therapists: [] }) };
    if (name.endsWith("/project")) return { list: async () => ({ items: [] }) };
    return {};
  }, {
    wx: {
      navigateTo: ({ url }) => navigations.push(url),
      switchTab: ({ url }) => tabSwitches.push(url),
      setStorageSync() {}
    },
    getApp: () => ({ globalData: { user: { id: "u", role: "user", therapistId: "t" } } })
  });
  page.onShow();
  await flush();
  assert.deepEqual(Array.from(page.data.quickEntries, (item) => item.text), ["我的排班", "待签到", "日历", "客户预约"]);
  page.tapQuick({ currentTarget: { dataset: { key: "therapistCheckin" } } });
  page.tapQuick({ currentTarget: { dataset: { key: "therapistAppointments" } } });
  page.tapQuick({ currentTarget: { dataset: { key: "therapistBooking" } } });
  assert.deepEqual(navigations, [
    "/pages/my-appointments/index?status=pending&therapist=1",
    "/pages/my-appointments/index?status=all&therapist=1"
  ]);
  assert.deepEqual(tabSwitches, ["/pages/booking/index"]);
});

test("staff and management footer actions share the compact project action width and lavender save color", () => {
  const root = path.join(__dirname, "../../miniprogram");
  const projectTemplate = fs.readFileSync(path.join(root, "pages/projects/index.wxml"), "utf8");
  const targetStyles = [
    ["pages/therapists/index.wxss", /\.bottom-bar \.primary-button \{([^}]*)\}/]
  ];

  assert.match(projectTemplate, /class="footer"><button class="primary-button"[^>]*>新增项目<\/button>/);
  for (const [file, selector] of targetStyles) {
    const styles = fs.readFileSync(path.join(root, file), "utf8");
    const block = styles.match(selector);
    assert.ok(block, `${file} keeps a centered footer action`);
    assert.match(block[1], /margin:\s*0 auto/);
    assert.doesNotMatch(block[1], /(?:max-)?width\s*:/, `${file} inherits the same natural button width as 新增项目`);
  }

  const editTemplate = fs.readFileSync(path.join(root, "pages/admin/project-edit/index.wxml"), "utf8");
  const editStyles = fs.readFileSync(path.join(root, "pages/admin/project-edit/index.wxss"), "utf8");
  assert.match(editTemplate, /class="primary-button save-button"[^>]*>保存项目<\/button>/);
  assert.match(editStyles, /\.save-button \{[^}]*background:#e6e0f8;[^}]*color:#40374f;/s);
  assert.match(editStyles, /\.save-button:active \{[^}]*background:#d8cfef;/s);
});

test("staff detail pages hide customer booking actions", async () => {
  for (const user of [{ role: "admin" }, { role: "user", therapistId: "t" }]) {
    const therapist = load("pages/therapist-detail/index.js", (name) => name.endsWith("/therapist")
      ? { detail: async () => ({ therapist: { id: "t", tags: [] } }) }
      : { today: () => "2999-01-01" }, { wx: {}, getApp: () => ({ globalData: { user } }) });
    therapist.onLoad({ id: "t" });
    therapist.onShow();
    await flush();
    assert.equal(therapist.data.canBook, false);

    const project = load("pages/project-detail/index.js", (name) => name.endsWith("/project")
      ? { detail: async () => ({ item: { id: "p" } }) }
      : { today: () => "2999-01-01" }, { wx: {}, getApp: () => ({ globalData: { user } }) });
    project.onLoad({ id: "p" });
    project.onShow();
    await flush();
    assert.equal(project.data.canBook, false);
  }
  const therapistTemplate = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/therapist-detail/index.wxml"), "utf8");
  const projectTemplate = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/project-detail/index.wxml"), "utf8");
  assert.match(therapistTemplate, /wx:if="{{canBook}}"/);
  assert.match(projectTemplate, /wx:if="{{canBook}}"/);
});

test("administrator appointment filters default to all dates before pagination", async () => {
  let query;
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.includes("utils/date")) return { today: () => "2026-10-14", addDays: (date, days) => days < 0 ? "2026-10-04" : "2026-10-24" };
    if (name.includes("timePicker")) return { range: [], valueFromTime: (time) => time, timeFromValue: (value) => value };
    if (name.endsWith("/admin")) return { appointments: async (value) => { query = value; return { appointments: [], pagination: {} }; } };
    if (name.endsWith("/appointment")) return { filterOptions: async () => ({
      supportsInactiveFilters: true,
      serviceItems: [],
      therapists: [{ id: "t1", name: "甲" }, { id: "t2", name: "乙" }]
    }) };
    if (name.endsWith("/user")) return { serviceItems: async () => ({ items: [] }) };
    if (name.endsWith("/therapist")) return { list: async () => ({ therapists: [{ id: "t1", name: "甲" }, { id: "t2", name: "乙" }] }) };
    return {};
  }, {
    wx: { setNavigationBarTitle() {}, showToast() {} },
    getApp: () => ({ globalData: { user: { id: "admin1", role: "admin" } } })
  });
  page.onLoad({ admin: "1", status: "all" });
  page.onShow();
  await flush();
  assert.equal(query.fromDate, "");
  assert.equal(query.toDate, "");
  assert.equal(query.page, 1);
  assert.equal(query.serviceItemIds.length, 0);
  assert.equal(query.therapistIds.length, 0);
  assert.equal(page.data.filterAllDates, true);
  page.openFilterDrawer(filterEvent(page));
  page.useDateFilter(filterEvent(page));
  assert.equal(page.data.draftAllDates, false);
  page.resetFilterDraft(filterEvent(page));
  assert.equal(page.data.draftAllDates, true);
  page.selectAllTherapists(filterEvent(page));
  assert.deepEqual(page.data.draftFilterTherapistIds, ["t1", "t2", "__inactive_therapists__"]);
  assert.equal(page.data.therapists.every((item) => item.filterChecked), true);
  const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/my-appointments/index.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/my-appointments/index.wxss"), "utf8");
  assert.match(template, /bindtap="useDateFilter"[^>]*>筛选日期<\/button>/);
  assert.doesNotMatch(template, /useTodayFilter|>今天<\/button>/);
  assert.match(template, /class="filter-text-action filter-close"/);
  assert.match(template, /class="filter-text-action filter-link" bindtap="selectAllTherapists"/);
  assert.match(styles, /\.filter-text-action \{[^}]*margin-left:auto;[^}]*justify-content:flex-end;[^}]*text-align:right;/s);
});

test("customer appointment filters query projects, therapists, dates and times before pagination", async () => {
  let query;
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.includes("utils/date")) return { today: () => "2026-10-14", addDays: (date, days) => days < 0 ? "2026-10-04" : "2026-10-24" };
    if (name.includes("timePicker")) return { range: [], valueFromTime: (time) => time, timeFromValue: (value) => value };
    if (name.endsWith("/appointment")) return {
      my: async (status, value) => { query = value; return { appointments: [], pagination: {} }; },
      filterOptions: async () => ({
        supportsInactiveFilters: true,
        serviceItems: [{ id: "p1", name: "项目一", inactive: false }, { id: "p-old", name: "历史项目", inactive: true }],
        therapists: [{ id: "t1", name: "芳疗师一", inactive: false }, { id: "t-old", name: "历史芳疗师", inactive: true }]
      })
    };
    if (name.endsWith("/user")) return { serviceItems: async () => ({ items: [{ id: "p1", name: "项目一" }] }) };
    if (name.endsWith("/therapist")) return { list: async () => ({ therapists: [{ id: "t1", name: "芳疗师一" }] }) };
    return {};
  }, {
    wx: { setNavigationBarTitle() {}, showToast() {} },
    getApp: () => ({ globalData: { user: { id: "u1", role: "user" } } })
  });
  page.onLoad({ status: "all" });
  page.onShow();
  await flush();
  assert.equal(page.data.hasUser, true);
  assert.equal(page.data.serviceItems.length, 2);
  assert.equal(page.data.therapists.length, 2);
  assert.equal(page.data.serviceItems[1].name, "已停用的项目");
  assert.equal(page.data.serviceItems[1].filterInactiveOption, true);
  assert.equal(page.data.therapists[1].name, "已停用的芳疗师");
  assert.equal(page.data.therapists[1].filterInactiveOption, true);
  page.openFilterDrawer(filterEvent(page));
  page.selectAllProjects(filterEvent(page));
  assert.deepEqual(Array.from(page.data.draftFilterServiceItemIds), ["p1", "__inactive_projects__"]);
  assert.equal(page.data.serviceItems.every((item) => item.filterChecked), true);
  const pickStart = value => page.inputFilterStart({ currentTarget: { dataset: { filterVersion: page.data.filterVersion } }, detail: { value } });
  pickStart(45);
  assert.equal(page.data.draftEndTime, "23:59");
  pickStart(47);
  assert.equal(page.data.draftStartTime, "23:30");
  pickStart(48);
  assert.equal(page.data.draftStartTime, "23:30", "all-day end is not a start option");
  assert.equal(page.data.draftEndTime, "23:59");
  page.useAllTimesFilter(filterEvent(page));
  assert.equal(page.data.draftStartTime, "00:00");
  assert.equal(page.data.draftEndTime, "23:59");
  page.setData({
    draftFilterServiceItemIds: ["p1"],
    draftFilterTherapistIds: ["t1"],
    draftAllDates: false,
    draftFromDate: "2026-10-10",
    draftToDate: "2026-10-20",
    draftStartTime: "09:00",
    draftEndTime: "18:00"
  });
  page.confirmFilters(filterEvent(page));
  await flush();
  assert.deepEqual(Array.from(query.serviceItemIds), ["p1"]);
  assert.deepEqual(Array.from(query.therapistIds), ["t1"]);
  assert.equal(query.fromDate, "2026-10-10");
  assert.equal(query.toDate, "2026-10-20");
  assert.equal(query.startTime, "09:00");
  assert.equal(query.endTime, "18:00");
  assert.equal(page.data.activeFilterCount, 4);
  const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/my-appointments/index.wxml"), "utf8");
  assert.match(template, /bindtap="selectAllProjects"[^>]*>全部<\/view>/);
  assert.match(template, /bindtap="useAllTimesFilter"[^>]*>全部时间<\/view>/);
  assert.match(template, /filterInactiveOption[^\n]+>{{item\.name}}<\/text>/);
});

test("inactive appointment filter choices send status flags instead of sentinel ids", async () => {
  let query;
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.includes("utils/date")) return { today: () => "2026-10-14", addDays: () => "2026-10-14" };
    if (name.includes("timePicker")) return { range: [], valueFromTime: (time) => time, timeFromValue: (value) => value };
    if (name.endsWith("/appointment")) return {
      my: async (status, value) => { query = value; return { appointments: [], pagination: {} }; },
      filterOptions: async () => ({
        supportsInactiveFilters: true,
        serviceItems: [{ id: "p1", name: "项目一" }],
        therapists: [{ id: "t1", name: "甲" }]
      })
    };
    return {};
  }, {
    wx: { setNavigationBarTitle() {}, showToast() {} },
    getApp: () => ({ globalData: { user: { id: "u1", role: "user" } } })
  });
  page.onLoad({ status: "all" });
  page.onShow();
  await flush();
  page.openFilterDrawer(filterEvent(page));
  page.selectFilterProjects(filterEvent(page, ["__inactive_projects__"]));
  page.selectFilterTherapists(filterEvent(page, ["__inactive_therapists__"]));
  page.confirmFilters(filterEvent(page));
  await flush();
  assert.deepEqual(Array.from(query.serviceItemIds), []);
  assert.deepEqual(Array.from(query.therapistIds), []);
  assert.equal(query.includeInactiveServiceItems, "1");
  assert.equal(query.includeInactiveTherapists, "1");
  assert.equal(page.data.activeFilterCount, 2);
});

test("appointment filters fall back to active catalogs when the scoped endpoint is not deployed", async () => {
  const toasts = [];
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.includes("utils/date")) return { today: () => "2026-10-14", addDays: (date, days) => days < 0 ? "2026-10-04" : "2026-10-24" };
    if (name.includes("timePicker")) return { range: [], valueFromTime: (time) => time, timeFromValue: (value) => value };
    if (name.endsWith("/appointment")) return {
      my: async () => ({ appointments: [], pagination: {} }),
      filterOptions: async () => { throw { code: "NOT_FOUND", statusCode: 404, message: "接口不存在" }; }
    };
    if (name.endsWith("/user")) return { serviceItems: async () => ({ items: [{ id: "p1", name: "项目一" }] }) };
    if (name.endsWith("/therapist")) return { list: async () => ({ therapists: [{ id: "t1", name: "芳疗师一" }] }) };
    return {};
  }, {
    wx: { setNavigationBarTitle() {}, showToast(value) { toasts.push(value); } },
    getApp: () => ({ globalData: { user: { id: "u1", role: "user" } } })
  });
  page.onLoad({ status: "all" });
  page.onShow();
  await flush();
  assert.deepEqual(Array.from(page.data.serviceItems, (item) => item.id), ["p1"]);
  assert.deepEqual(Array.from(page.data.therapists, (item) => item.id), ["t1"]);
  assert.equal(toasts.some((item) => item.title === "接口不存在"), false);
});

test("administrator appointment requests serialize inactive catalog filters", async () => {
  let requestOptions;
  const admin = loadModule("services/admin.js", (name) => {
    if (name === "../utils/request") return async (options) => { requestOptions = options; return {}; };
    return {};
  });
  await admin.appointments({
    status: "all",
    includeInactiveServiceItems: "1",
    includeInactiveTherapists: "1"
  });
  assert.match(requestOptions.url, /includeInactiveServiceItems=1/);
  assert.match(requestOptions.url, /includeInactiveTherapists=1/);
});

test("selecting every appointment option keeps the visual selection but sends no id filter", async () => {
  let query;
  const options = {
    serviceItems: [{ id: "p1", name: "项目一" }, { id: "p2", name: "项目二" }],
    therapists: [{ id: "t1", name: "甲" }, { id: "t2", name: "乙" }]
  };
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.includes("utils/date")) return { today: () => "2026-10-14", addDays: (date, days) => days < 0 ? "2026-10-04" : "2026-10-24" };
    if (name.includes("timePicker")) return { range: [], valueFromTime: (time) => time, timeFromValue: (value) => value };
    if (name.endsWith("/appointment")) return {
      my: async (status, value) => { query = value; return { appointments: [], pagination: {} }; },
      filterOptions: async () => options
    };
    return {};
  }, {
    wx: { setNavigationBarTitle() {}, showToast() {} },
    getApp: () => ({ globalData: { user: { id: "u1", role: "user" } } })
  });
  page.onLoad({ status: "all" });
  page.onShow();
  await flush();
  page.openFilterDrawer(filterEvent(page));
  page.selectAllProjects(filterEvent(page));
  page.selectAllTherapists(filterEvent(page));
  page.confirmFilters(filterEvent(page));
  await flush();
  assert.deepEqual(Array.from(query.serviceItemIds), []);
  assert.deepEqual(Array.from(query.therapistIds), []);
  assert.equal(page.data.filterAllProjects, true);
  assert.equal(page.data.filterAllTherapists, true);
  assert.equal(page.data.activeFilterCount, 0);
  page.openFilterDrawer(filterEvent(page));
  assert.equal(page.data.serviceItems.every((item) => item.filterChecked), true);
  assert.equal(page.data.therapists.every((item) => item.filterChecked), true);
});

test("therapist customer filters omit the therapist selector and ignore therapist ids", async () => {
  let query;
  let therapistListCalls = 0;
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.includes("utils/date")) return { today: () => "2026-10-14", addDays: (date, days) => days < 0 ? "2026-10-04" : "2026-10-24" };
    if (name.includes("timePicker")) return { range: [], valueFromTime: () => [0, 0], timeFromValue: () => "09:00" };
    if (name.endsWith("therapistPortal")) return { appointments: async (value) => { query = value; return { appointments: [], pagination: {} }; } };
    if (name.endsWith("/appointment")) return { filterOptions: async () => ({
      supportsInactiveFilters: true,
      serviceItems: [{ id: "p1", name: "项目一" }, { id: "p-old", name: "历史项目", inactive: true }],
      therapists: []
    }) };
    if (name.endsWith("/user")) return { serviceItems: async () => ({ items: [{ id: "p1", name: "项目一" }] }) };
    if (name.endsWith("/therapist")) return { list: async () => { therapistListCalls += 1; return { therapists: [] }; } };
    return {};
  }, {
    wx: { setNavigationBarTitle() {}, showToast() {} },
    getApp: () => ({ globalData: { user: { id: "u1", role: "user", therapistId: "t1" } } })
  });
  page.onLoad({ therapist: "1", status: "all" });
  page.onShow();
  await flush();
  page.openFilterDrawer(filterEvent(page));
  page.setData({
    draftFilterServiceItemIds: ["p1"],
    draftFilterTherapistIds: ["other-therapist"],
    draftStartTime: "09:00",
    draftEndTime: "18:00"
  });
  page.confirmFilters(filterEvent(page));
  await flush();
  assert.equal(therapistListCalls, 0);
  assert.deepEqual(Array.from(query.serviceItemIds), ["p1"]);
  assert.deepEqual(Array.from(query.therapistIds), []);
  assert.equal(page.data.activeFilterCount, 2);
  const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/my-appointments/index.wxml"), "utf8");
  assert.match(template, /wx:if="{{!isTherapistMode}}" class="filter-section">\s*<view class="filter-section-head"><view class="filter-section-title">芳疗师<\/view>/s);
  assert.match(template, /<view class="filter-section">\s*<view class="filter-section-head"><view class="filter-section-title">项目<\/view>/s);
});

test("therapist customer appointments show only check-in after the one-hour window opens", async () => {
  class ClockDate extends Date { static now() { return Date.parse("2026-10-14T04:00:00Z"); } }
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.includes("utils/date")) return { today: () => "2026-10-14", addDays: (date, days) => days < 0 ? "2026-10-04" : "2026-10-24" };
    if (name.includes("timePicker")) return { range: [], valueFromTime: () => [0, 0] };
    if (name.endsWith("therapistPortal")) return { appointments: async () => ({ appointments: [
      { id: "today", date: "2026-10-14", startTime: "13:00", status: "booked", slotStatus: "open" },
      { id: "future", date: "2026-10-15", startTime: "13:00", status: "booked", slotStatus: "open" }
    ], pagination: {} }) };
    if (name.endsWith("/user")) return { serviceItems: async () => ({ items: [] }) };
    return {};
  }, { Date: ClockDate, wx: { setNavigationBarTitle() {}, showToast() {} } });
  page.onLoad({ therapist: "1", status: "pending" });
  page.onShow();
  await flush();
  assert.equal(page.data.appointments[0].canCheckIn, true);
  assert.equal(page.data.appointments[0].canCancel, false);
  assert.equal(page.data.appointments[1].canCheckIn, false);
  const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/components/appointment-card/index.wxml"), "utf8");
  assert.match(template, /showActions && .*appointment\.canCheckIn/);
  assert.match(template, /actionMode === 'user'/);
  assert.match(template, /appointment\.canModify[^\n]+class="compact-action modify"/);
  assert.match(template, /wx:if="{{appointment\.canCancel}}" class="compact-action danger"/);
});

test("appointment cards navigate directly by stable ID for each identity", () => {
  for (const mode of ["user", "therapist", "admin"]) {
    const destinations = [];
    const page = load("pages/my-appointments/index.js", () => ({}), { wx: { navigateTo: ({ url }) => destinations.push(url) } });
    Object.assign(page.data, { hasUser: true, loading: false, isAdminMode: mode === "admin", isTherapistMode: mode === "therapist", appointments: [{ id: "appointment-1" }] });
    page.selectAppointment({ currentTarget: { dataset: { id: "appointment-1" } } });
    page.selectAppointment({ currentTarget: { dataset: { id: "appointment-1" } } });
    assert.equal(destinations.length, 1);
    assert.equal(destinations[0], `/pages/${mode === "admin" ? "admin/slot-appointment" : mode === "therapist" ? "therapist/appointment-detail" : "appointment-detail"}/index?appointmentId=appointment-1`);
  }
});

test("therapist appointment detail retries its original ID and does not substitute another customer",async()=>{
  const calls=[]; let result={appointment:{id:"other",status:"booked"}};
  const p=load("pages/therapist/appointment-detail/index.js",name=> name.endsWith("/therapistPortal")
    ? {appointment:async (id,options)=>{assert.equal(options.includeHistory,true);calls.push(id);return result;}} : adminSession,{wx:{setNavigationBarTitle(){}}});
  p.onLoad({appointmentId:"chosen",slotId:"retired"});
  await p.load(); assert.equal(p.data.appointment,null); assert.match(p.data.error,/不存在/);
  result={appointment:{id:"chosen",status:"no_show",date:"2020-01-01",startTime:"09:00",endTime:"10:30"}};
  await p.load(); assert.equal(p.data.appointment.id,"chosen"); assert.equal(p.data.appointment.canCheckIn,true);
  assert.equal(p.data.historyUnavailable,true);
  const revision={id:1,before:{serviceItemName:"历史项目",note:"旧备注"},createdAt:"2026-11-04 10:30:00"};
  result.history=[revision]; await p.load();
  assert.deepEqual(p.data.historyAppointments,[revision]);
  assert.equal(p.data.historyUnavailable,false);
  result={appointment:{id:"other"},history:[revision]}; await p.load();
  assert.equal(p.data.historyAppointments.length,0);
  assert.deepEqual(calls,["chosen","chosen","chosen","chosen"]);
});

test("administrator pending and all appointment cards can check in a customer directly", async () => {
  let modal;
  let checkInCalls = 0;
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.includes("utils/date")) return { today: () => "2026-10-14", addDays: () => "2026-10-14" };
    if (name.includes("timePicker")) return { range: [], valueFromTime: () => [0, 0] };
    if (name.endsWith("/admin")) return { appointment: async () => ({ appointment: { id: "a", status: "booked", slotStatus: "open", date: "2020-01-01", startTime: "09:00" } }), adminCheckInAppointment: async () => { checkInCalls += 1; } };
    return {};
  }, { wx: { showModal: (options) => { modal = options; }, showToast() {} } });
  page.data.isAdminMode = true;
  page.load = () => {};
  page.cardAction({ detail: { type: "checkIn", appointment: { id: "a", status: "booked", canCheckIn: true } } });
  assert.equal(modal.title, "为用户签到");
  modal.success({ confirm: true });
  await flush();
  assert.equal(checkInCalls, 1);
  const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/my-appointments/index.wxml"), "utf8");
  assert.match(template, /showActions="{{!isAdminMode \|\| active === 'pending' \|\| active === 'all'}}"/);
  assert.match(template, /isAdminMode \? 'admin' : 'user'/);
});

test("all appointment details share full information and numbered history below the main card", () => {
  for (const page of ["admin/slot-appointment", "therapist/appointment-detail", "appointment-detail"]) {
    const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages", page, "index.wxml"), "utf8");
    assert.ok(template.indexOf("<appointment-card") < template.indexOf("<include"));
    assert.match(template, /detail="{{true}}"/);
  }
  const history = fs.readFileSync(path.join(__dirname, "../../miniprogram/templates/appointment-history/index.wxml"), "utf8");
  assert.match(history, /记录{{historyAppointments.length - index}}/);
  assert.ok(history.indexOf("预约项目：") < history.indexOf("预约时段："));
  assert.match(history, /备注：{{item.before.note \|\| '暂无备注'}}/);
  const card = fs.readFileSync(path.join(__dirname, "../../miniprogram/components/appointment-card/index.wxml"), "utf8");
  assert.match(card, /下单时间[^]*?签到时间/);
  const styles = fs.readFileSync(path.join(__dirname, "../../miniprogram/components/appointment-card/index.wxss"), "utf8");
  assert.match(styles, /\.info-row \{[^}]*grid-template-columns:128rpx minmax\(0,1fr\)/);
  assert.match(styles, /\.row-value \{[^}]*text-align:right/);
});

test("administrator current appointment formats check-in time and shows an unsigned fallback", async () => {
  let checkedInAt = "2026-10-20 14:05:30";
  const page = adminAppointment(async id => ({appointment: {id,status:checkedInAt?"checked_in":"booked",
    createdAt:"2026-10-18 09:30:45",checkedInAt,date:"2026-10-20",startTime:"14:00",endTime:"15:30"}}));
  page.onLoad({appointmentId:"a"}); await page.load();
  assert.equal(page.data.currentAppointment.bookedText, "2026-10-18 09:30");
  assert.equal(page.data.currentAppointment.checkedInText, "2026-10-20 14:05");

  checkedInAt = null;
  page.load();
  await flush();
  assert.equal(page.data.currentAppointment.checkedInText, "暂未签到");
});

test("editing a therapist phone requires transfer confirmation", async () => {
  let modal, saves = 0;
  const page = load("pages/admin/therapist-edit/index.js", (name) => {
    if (name.endsWith("/therapist")) return { save: async () => { saves++; return { therapist: { id: "t", serviceItemIds: [] } }; } };
    return {};
  }, {
    wx: {
      showModal: (options) => { modal = options; }, showToast() {}, navigateBack() {}
    },
    setTimeout: (callback) => callback()
  });
  page.startEditor();
  Object.assign(page.data, {
    allowed: true, id: "t", name: "甲", phone: "13900139000", originalPhone: "13800138000",
    bio: "", tags: [], imageUrl: "/uploads/therapists/a.png"
  });
  page.save();
  assert.equal(saves, 0);
  assert.match(modal.content, /权限将转移/);
  modal.success({ confirm: true });
  await flush();
  assert.equal(saves, 1);
});

test("catalog saves only navigate from the original visible editor and session", async () => {
  for (const kind of ["project", "therapist"]) {
    for (const outcome of ["visible", "returned", "hidden", "unloaded", "switched", "covered", "leftDuringDelay"]) {
      const app = { globalData: { user: { role: "admin", id: "staff" }, token: "first" } };
      const saving = deferred(), timers = [], stack = [];
      let backs = 0, writes = 0;
      const page = load("pages/admin/" + kind + "-edit/index.js", () => ({
        save() { writes++; return saving.promise; }
      }), { getApp: () => app, getCurrentPages: () => stack,
        wx: { showToast() {}, setNavigationBarTitle() {}, navigateBack() { backs++; } }, setTimeout: fn => timers.push(fn) });
      stack.push(page);
      page.startEditor(); page.onShow();
      Object.assign(page.data, { allowed: true, name: "fixture", price: "0", phone: "13900000001", imageUrl: "/uploads/therapists/a.png" });
      page.save();
      assert.equal(writes, 1);
      if (outcome === "hidden" || outcome === "returned") page.onHide();
      if (outcome === "returned") page.onShow();
      if (outcome === "unloaded") page.onUnload();
      if (outcome === "switched") app.globalData.token = "second";
      if (outcome === "covered") stack.push({});
      saving.resolve({ therapist: { id: "created", serviceItemIds: [] }, item: { id: "created" } }); await flush();
      assert.equal(page.data.id, ["unloaded", "switched"].includes(outcome) ? "" : "created");
      if (outcome === "leftDuringDelay") page.onUnload();
      timers.forEach(fn => fn());
      assert.equal(backs, Number(outcome === "visible" || kind === "project" && outcome === "leftDuringDelay"), kind + "/" + outcome);
    }
  }
});

test("refresh preserves sessions on network/server errors, clears expired sessions, and ignores old-session responses", async () => {
  const requests = [], removed = [];
  const app = load("app.js", () => ({ me: () => { const request = deferred(); requests.push(request); return request.promise; } }), {
    wx: { setStorageSync() {}, removeStorageSync: (key) => removed.push(key) }
  });
  app.setSession("valid", { id: "old" });
  for (const error of [{ code: "NETWORK_ERROR" }, { code: "INTERNAL_ERROR", statusCode: 500 }]) {
    const pending = app.refreshMe(); requests.at(-1).reject(error); await pending;
    assert.equal(app.globalData.token, "valid");
    assert.equal(removed.length, 0);
  }
  let pending = app.refreshMe();
  requests.at(-1).reject({ code: "INVALID_SESSION", statusCode: 401 });
  await pending;
  assert.equal(app.globalData.token, "");
  app.setSession("old-token", { id: "old" });
  pending = app.refreshMe();
  app.setSession("new-token", { id: "new" });
  requests.at(-1).reject({ code: "INVALID_SESSION" });
  await pending;
  assert.equal(app.globalData.token, "new-token");
  pending = app.refreshMe();
  app.clearSession();
  requests.at(-1).resolve({ user: { id: "new" } });
  await pending;
  assert.equal(app.globalData.user, null);
});

test("concurrent session refreshes share one network request", async () => {
  const requests = [];
  const app = load("app.js", () => ({ me: () => { const request = deferred(); requests.push(request); return request.promise; } }), {
    wx: { setStorageSync() {}, removeStorageSync() {} }
  });
  app.setSession("valid", { id: "old" });
  const first = app.refreshMe();
  const second = app.refreshMe();
  assert.equal(first, second);
  assert.equal(requests.length, 1);
  requests[0].resolve({ user: { id: "fresh" } });
  await Promise.all([first, second]);
  assert.equal(app.globalData.user.id, "fresh");
});

test("client dates, weekdays, month boundaries and expiry use Shanghai regardless of device timezone", () => {
  const dates = require("../../miniprogram/utils/date");
  const previous = process.env.TZ;
  const originalNow = Date.now;
  try {
    for (const zone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
      process.env.TZ = zone;
      assert.equal(dates.formatDate(new Date("2026-09-20T16:30:00Z")), "2026-09-21");
      assert.equal(dates.addDays("2026-01-01", -1), "2025-12-31");
      assert.equal(dates.addDays("2024-02-28", 1), "2024-02-29");
      const day = dates.buildDateStrip("2026-09-21")[10];
      assert.equal(day.weekday, "周一");
      assert.equal(day.day, "09.21");
      const current = dates.buildCalendarMonths("2026-09-21").find((month) => month.current);
      assert.equal(current.days[2].date, "2026-09-01");
      assert.equal(current.days.at(-1).date, "2026-09-30");
      Date.now = () => Date.parse("2026-09-21T01:00:00Z");
      assert.equal(dates.isExpired("2026-09-21", "09:00"), true);
      assert.equal(dates.isExpired("2026-09-21", "09:01"), false);
    }
  } finally {
    Date.now = originalNow;
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

function checkInClock(initial = "2026-10-20T15:29:59.999Z") {
  let now = Date.parse(initial);
  let timerId = 0;
  const timers = new Map();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  return {
    globals: {
      Date: ClockDate,
      setInterval: (callback, period) => { assert.equal(period, 1000); timers.set(++timerId, callback); return timerId; },
      clearInterval: (id) => timers.delete(id)
    },
    timers,
    setTime(value) { now = typeof value === "number" ? value : Date.parse(value); },
    tick() { for (const callback of timers.values()) callback(); }
  };
}

test("frontend check-in uses the inclusive Shanghai instant and appointment status even if former slots were closed or deleted", () => {
  const clock = checkInClock();
  const checkIn = loadModule("utils/checkIn.js", () => ({}), clock.globals);
  const appointment = { date: "2026-10-21", startTime: "00:30", status: "booked", slotStatus: "open" };
  assert.equal(checkIn.canCheckIn(appointment), false);
  clock.setTime("2026-10-20T15:30:00Z");
  assert.equal(checkIn.canCheckIn(appointment), true);
  for (const status of ["cancelled", "checked_in", "replaced"]) assert.equal(checkIn.canCheckIn({ ...appointment, status }), false);
  assert.equal(checkIn.canCheckIn({ ...appointment, slotStatus: "disabled" }), true);
  assert.equal(checkIn.canCheckIn({ ...appointment, slotStatus: null }), true);
  assert.equal(checkIn.canCheckIn(appointment, { status: "open", removed: true }), true);
  assert.equal(checkIn.canCheckIn({ ...appointment, startTime: "invalid" }), false);
  assert.equal(checkIn.canCheckIn({ ...appointment, date: "2000-01-01", status: "no_show" }), true);
});

for (const user of [{ id: "customer", role: "user" }, { id: "admin", role: "admin" }, { id: "therapist", role: "user", therapistId: "t" }]) {
  test(`${user.id} list reveals check-in at the boundary without another request and stops hidden timers`, async () => {
    const clock = checkInClock();
    const dates = loadModule("utils/date.js", () => ({}), clock.globals);
    let requests = 0;
    const list = async () => { requests++; return { appointments: [
      { id: "a", date: "2026-10-21", startTime: "00:30", endTime: "01:30", status: "booked", slotStatus: "open" }
    ] }; };
    const page = load("pages/my-appointments/index.js", (name) => {
      if (name.endsWith("/date")) return dates;
      if (name.endsWith("/appointment")) return { my: list, filterOptions: async () => ({ serviceItems: [], therapists: [], supportsInactiveFilters: true }) };
      if (name.endsWith("/admin") || name.endsWith("/therapistPortal")) return { appointments: list };
      return {};
    }, { ...clock.globals, getApp: () => ({ globalData: { user } }), wx: { setNavigationBarTitle() {}, showToast: () => assert.fail("list load failed") } });
    page.onLoad({});
    page.onShow();
    await flush();
    assert.equal(page.data.appointments[0].canCheckIn, false);
    assert.equal(clock.timers.size, 1);
    let patches = 0;
    const setData = page.setData;
    page.setData = (...args) => { patches++; setData(...args); };
    clock.tick();
    assert.equal(patches, 0, "no unchanged data should cross the rendering bridge");
    clock.setTime("2026-10-20T15:30:00Z");
    clock.tick();
    assert.equal(page.data.appointments[0].canCheckIn, true);
    assert.equal(requests, 1, "timer must not refetch the list");
    assert.equal(patches, 1);
    clock.tick();
    assert.equal(patches, 1);
    page.onHide();
    assert.equal(clock.timers.size, 0);
    page.onShow();
    await flush();
    assert.equal(page.data.appointments[0].canCheckIn, true);
    assert.equal(clock.timers.size, 1);
    page.onUnload();
    assert.equal(clock.timers.size, 0);
  });
}

for (const kind of ["admin", "therapist"]) {
  test(`${kind} detail reveals check-in on an already open page and refreshes immediately on return`, async () => {
    const clock = checkInClock();
    const dates = loadModule("utils/date.js", () => ({}), clock.globals);
    const appointment = { id: "a", date: "2026-10-21", startTime: "00:30", endTime: "02:00", status: "booked" };
    let requests = 0;
    const page = load(kind === "admin" ? "pages/admin/slot-appointment/index.js" : "pages/therapist/appointment-detail/index.js", (name) => {
      if (name.endsWith("/loginReturn")) return adminSession;
      if (name.endsWith("/admin") || name.endsWith("/therapistPortal")) return { appointment: async id => {
        assert.equal(id, appointment.id); requests++; return {appointment};
      } };
      return {};
    }, { ...clock.globals, wx: { setNavigationBarTitle() {}, showToast: () => assert.fail("detail load failed") } });
    page.onLoad({ appointmentId: "a" });
    page.onShow();
    await flush();
    const current = () => kind === "admin" ? page.data.currentAppointment : page.data.appointment;
    assert.equal(current().canCheckIn, false);
    clock.setTime("2026-10-20T15:30:00Z");
    clock.tick();
    assert.equal(current().canCheckIn, true);
    assert.equal(requests, 1);
    clock.setTime("2026-10-20T15:29:59.999Z");
    clock.tick();
    assert.equal(current().canCheckIn, false, "clock correction must also hide an early button");
    page.onHide();
    assert.equal(clock.timers.size, 0);
    clock.setTime("2026-10-20T15:30:01Z");
    page.onShow();
    await flush();
    assert.equal(current().canCheckIn, true);
    assert.equal(clock.timers.size, 1);
    page.onUnload();
    assert.equal(clock.timers.size, 0);
    if (kind === "admin") {
      const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/pages/admin/slot-appointment/index.wxml"), "utf8");
      assert.match(template, /appointment="{{currentAppointment}}"[^]*?bind:action="action"/);
    }
  });
}

test("therapist check-in and default date filters use the new Shanghai day after midnight", async () => {
  let now = Date.parse("2026-10-17T15:59:00Z");
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const dates = loadModule("utils/date.js", () => ({}), { Date: ClockDate });
  const page = load("pages/my-appointments/index.js", (name) => {
    if (name.endsWith("/date")) return dates;
    if (name.endsWith("/appointment")) return { filterOptions: async () => ({ serviceItems: [], therapists: [] }) };
    if (name.endsWith("/therapistPortal")) return { appointments: async () => ({ appointments: [
      { id: "a", date: "2026-10-18", startTime: "01:00", status: "booked", slotStatus: "open" }
    ] }) };
    return {};
  }, { Date: ClockDate, getApp: () => ({ globalData: { user: { id: "t-user", role: "user", therapistId: "t1" } } }), wx: { setNavigationBarTitle() {}, showToast() {} } });
  page.onLoad({ therapist: "1" });
  page.onShow(); await flush();
  assert.equal(page.data.appointments[0].canCheckIn, false);
  now = Date.parse("2026-10-17T16:01:00Z");
  page.load(); await flush();
  assert.equal(page.data.appointments[0].canCheckIn, true);
  page.onShow(); await flush();
  assert.equal(page.data.filterFromDate, "2026-10-08");
  assert.equal(page.data.filterToDate, "2026-10-28");
  page.openFilterDrawer(filterEvent(page));
  page.inputFilterDate(filterEvent(page, "2026-10-01", "draftFromDate"));
  page.resetFilterDraft(filterEvent(page));
  assert.equal(page.data.draftFromDate, "2026-10-08");
});

test("drag sorting measures unequal rows and remains stable when the pointer stops or the list scrolls", () => {
  const page = load("pages/projects/index.js", () => ({}), { setInterval: () => 1, clearInterval() {} });
  const heights = [220, 272, 272, 272, 272];
  let top = 100;
  const rects = heights.map((height) => { const row = { top, height }; top += height; return row; });
  page.createSelectorQuery = () => {
    const query = { select() { return this; }, selectAll() { return this; }, boundingClientRect() { return this; },
      exec(callback) { callback([{ top: 100, bottom: 600, height: 500 }, rects, { top: 100, height: 1308 }]); } };
    return query;
  };
  page.data.manage = true; page.data.loading = false;
  page.data.items = heights.map((height, i) => ({ id: String(i) }));
  page.startDrag({ currentTarget: { dataset: { id: "1" } }, touches: [{ clientY: 840 }] });
  page.positionDrag();
  assert.equal(page.data.items.findIndex((item) => item.id === "1"), 2);
  page.positionDrag();
  assert.equal(page.data.items.findIndex((item) => item.id === "1"), 2);
  page.currentScroll = 500; page.pointerY = 840;
  page.positionDrag();
  assert.equal(page.data.items.findIndex((item) => item.id === "1"), 4);
  page.cancelDrag();
  assert.equal(page.data.items.map((item) => item.id).join(), "0,1,2,3,4");
  assert.equal(page.data.dragging, false);
});
