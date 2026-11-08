const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../../miniprogram');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function loadPage(file, mocks, globals = {}) {
  let page;
  const modules = new Map();
  function load(relative) {
    if (Object.hasOwn(mocks, relative)) return mocks[relative];
    if (modules.has(relative)) return modules.get(relative).exports;
    const module = { exports: {} }; modules.set(relative, module);
    vm.runInNewContext(fs.readFileSync(path.join(root, relative), 'utf8'), {
      module, exports: module.exports, Page: value => { page = value; },
      require: name => load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), name + '.js'))),
      setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout, console, ...globals
    }, { filename: relative });
    return module.exports;
  }
  load(file);
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback(); };
  return page;
}

test('AUDIT async: a slow previous whitelist search cannot replace the newest search results', async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const page = loadPage('pages/admin/whitelist/index.js', {
    'services/admin.js': { whitelist: () => (++calls === 1 ? first.promise : second.promise) }
  }, { wx: { showToast() {} } });
  page.setData({ keyword: '旧查询' }); page.load();
  page.setData({ keyword: '新查询' }); page.load();
  second.resolve({ items: [{ id: 'new-result', remarkName: '新查询成员' }] }); await flush();
  assert.equal(page.data.items[0].id, 'new-result');
  first.resolve({ items: [{ id: 'old-result', remarkName: '旧查询成员' }] }); await flush();
  assert.equal(page.data.items[0].id, 'new-result', 'visible keyword and editable/deletable member rows must describe the same request');
});

function loadLoginReturn(app, wx, extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/loginReturn.js'), 'utf8'), {
    module, getApp: () => app, wx, Date, ...extra
  });
  return module.exports;
}

test('appointment login return accepts only known pages and resumes exactly once after login', async () => {
  const app = { globalData: { token: '', user: null } };
  const actions = [];
  const wx = {
    showModal: options => { actions.push(options.title); options.success({ confirm: true }); options.complete(); },
    switchTab: options => actions.push(options.url), navigateTo: options => actions.push(options.url)
  };
  const nav = loadLoginReturn(app, wx);
  assert.equal(nav.normalize('https://external.example'), '');
  assert.equal(nav.normalize('/pages/admin/slot-appointment/index?slotId=invalid'), '');
  assert.equal(await nav.ensure('/pages/my-appointments/index?status=checked_in'), false);
  assert.deepEqual(actions, ['请先登录', '/pages/mine/index']);
  assert.equal(app._loginReturn.url, '/pages/my-appointments/index?status=checked_in');
  app.globalData = { token: 'synthetic', user: { id: 'user', role: 'user' } };
  nav.resume(); nav.resume();
  assert.equal(actions.filter(a => a === '/pages/my-appointments/index?status=checked_in').length, 1);
  assert.equal(app._loginReturn, null);
});

test('expired appointment sessions request login and wrong-role accounts return to their own list', async () => {
  const app = { globalData: { token: 'expired', user: { id: 'old', role: 'admin' } } };
  app.refreshMe = async () => { app.globalData = { token: '', user: null }; return null; };
  const actions = [];
  const wx = {
    showModal: options => { options.success({ confirm: true }); options.complete(); },
    switchTab: options => actions.push(options.url), navigateTo: options => actions.push(options.url),
    redirectTo: options => actions.push(options.url)
  };
  const nav = loadLoginReturn(app, wx);
  const target = '/pages/admin/slot-appointment/index?appointmentId=11111111-1111-4111-8111-111111111111';
  assert.equal(await nav.ensure(target, 'admin'), false);
  assert.equal(app._loginReturn.url, target);
  app.globalData = { token: 'fresh', user: { id: 'other', role: 'user' } };
  nav.resume();
  assert.equal(actions.at(-1), '/pages/my-appointments/index?status=pending');
  app._loginReturn = { url: target, expiresAt: Date.now() - 1 };
  const count = actions.length; nav.resume(); assert.equal(actions.length, count);
});

test('admin appointment cold start sends no protected request before login and reloads after return', async () => {
  const app = { globalData: { user: null, token: '' } };
  let calls = 0;
  const wx = {
    showModal: options => { options.success({ confirm: true }); options.complete(); },
    switchTab() {}, showToast() {}
  };
  const appointment = { id: '22222222-2222-4222-8222-222222222222', date: '2999-01-01', startTime: '09:00', endTime: '10:00', status: 'booked' };
  const page = loadPage('pages/admin/slot-appointment/index.js', {
    'services/admin.js': { appointment: async () => { calls++; return { appointment, history: [] }; } },
    'services/user.js': { serviceItems: async () => ({ items: [] }) },
    'services/therapist.js': { list: async () => ({ therapists: [] }) },
  }, { getApp: () => app, wx });
  page.onLoad({ appointmentId: appointment.id }); page.onShow(); await flush();
  assert.equal(calls, 0);
  assert.equal(page.data.currentAppointment, null);
  assert.ok(app._loginReturn);
  app.globalData = { token: 'fresh', user: { id: 'admin', role: 'admin' } };
  app.refreshMe = async () => app.globalData.user;
  page.onShow(); await flush();
  assert.equal(calls, 1);
  assert.equal(page.data.currentAppointment.id, appointment.id);
  page.onHide(); assert.equal(page._checkInTimer, undefined);
});

test('customer pagination sends the cursor, deduplicates appended IDs and resets on filter reload', async () => {
  const queries = [];
  const page = loadPage('pages/my-appointments/index.js', {
    'services/appointment.js': { my: async (status, query) => {
      queries.push(query);
      return queries.length === 1
        ? { appointments: [{ id: 'a' }], pagination: { hasMore: true, nextCursor: 'first-cursor' } }
        : { appointments: [{ id: 'a' }, { id: 'b' }], pagination: { hasMore: false, nextCursor: '' } };
    } },
    'services/admin.js': {}, 'services/therapistPortal.js': {},
    'services/user.js': {}, 'services/therapist.js': {}
  }, { wx: { showToast() {} } });
  page.load(); await flush();
  page.onReachBottom(); await flush();
  assert.equal(queries[1].cursor, 'first-cursor');
  assert.equal(page.data.appointments.length, 2);
  page.load(); await flush();
  assert.equal(queries[2].cursor, undefined);
  assert.equal(page.data.nextCursor, '');
});

test('parked customer list removes modification at service end while retaining cancellation', async () => {
  let instant = Date.parse('2026-10-20T09:59:59+08:00');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [instant])); } static now() { return instant; } }
  const page = loadPage('pages/my-appointments/index.js', {
    'services/appointment.js': { my: async () => ({ appointments: [{ id: 'a', status: 'booked', date: '2026-10-20', startTime: '09:00', endTime: '10:00' }] }) },
    'services/admin.js': {}, 'services/therapistPortal.js': {}, 'services/user.js': {}, 'services/therapist.js': {}
  }, { Date: Clock, wx: { showToast() {} } });
  page.data.canBook = true;
  page.load(); await flush();
  assert.equal(page.data.appointments[0].canModify, true);
  instant += 1000; page.refreshCheckInAvailability();
  assert.equal(page.data.appointments[0].canModify, false);
  assert.equal(page.data.appointments[0].canCancel, true);
  assert.equal(page.data.appointments[0].canCheckIn, true);
});
