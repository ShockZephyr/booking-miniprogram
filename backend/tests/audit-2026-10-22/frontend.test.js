// Regression tests for the whitelist draft and expired-home-session fixes.
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

test('A5 regression: previous whitelist save preserves the next unsaved member draft', async () => {
  const pending = deferred();
  const page = loadPage('pages/admin/whitelist/index.js', {
    'services/admin.js': { updateWhitelist: () => pending.promise, whitelist: async () => ({ items: [] }) }
  }, { wx: { showToast() {} } });
  page.onShow(); await flush();
  page.setData({ editingId: 'first', phone: '13900000001', remarkName: 'first draft', items: [
    { id: 'second', phone: '13900000002', remarkName: 'second original' }
  ] });
  page.save();
  page.edit({ currentTarget: { dataset: { id: 'second' } } });
  page.input({ currentTarget: { dataset: { key: 'remarkName' } }, detail: { value: 'second unsaved change' } });
  assert.equal(page.data.editingId, 'second');
  pending.resolve({}); await flush();
  assert.equal(page.data.editingId, 'second');
  assert.equal(page.data.remarkName, 'second unsaved change');
  assert.equal(page.data.saving, false);
});

test('A6 regression: home catalogs load anonymously after expired session clearance', async () => {
  const identity = deferred();
  const error = { code: 'INVALID_SESSION', message: '登录状态已失效，请重新登录' };
  const app = { globalData: { token: 'expired-test-token', user: { id: 'user', role: 'user' } },
    refreshMe: () => identity.promise };
  let projectCalls = 0, therapistCalls = 0;
  const page = loadPage('pages/home/index.js', {
    'config/business.js': {}, 'services/user.js': {},
    'services/project.js': { list: () => { projectCalls++; return app.globalData.token ? Promise.reject(error) : Promise.resolve({ items: [{ id: 'public-project' }] }); } },
    'services/therapist.js': { list: () => { therapistCalls++; return app.globalData.token ? Promise.reject(error) : Promise.resolve({ therapists: [{ id: 'public-therapist' }] }); } }
  }, { getApp: () => app });
  page.onShow(); await flush();
  assert.equal(projectCalls, 0); assert.equal(therapistCalls, 0);
  app.globalData = { token: '', user: null }; identity.resolve(null); await flush();
  assert.equal(page.data.projectError, '');
  assert.equal(page.data.therapistError, '');
  assert.equal(projectCalls, 1); assert.equal(therapistCalls, 1);
  // Positive neighbor: reopening the same page after session clearance succeeds.
  page.onShow(); await flush();
  assert.equal(page.data.projects[0].id, 'public-project');
  assert.equal(page.data.therapists[0].id, 'public-therapist');
});

test('A5 save ignores duplicate taps, retains edits made to the same member and handles retry', async () => {
  const first = deferred(), second = deferred();
  const pending = [first, second];
  let calls = 0;
  const toasts = [];
  const page = loadPage('pages/admin/whitelist/index.js', {
    'services/admin.js': { updateWhitelist: () => pending[calls++].promise, whitelist: async () => ({ items: [] }) }
  }, { wx: { showToast: value => toasts.push(value.title) } });
  page.onShow(); await flush();
  page.setData({ editingId: 'member', phone: 'synthetic-phone', remarkName: 'before' });
  page.save(); page.save();
  assert.equal(calls, 1);
  page.input({ currentTarget: { dataset: { key: 'remarkName' } }, detail: { value: 'newer draft' } });
  first.reject(new Error('simulated failure')); await flush();
  assert.equal(page.data.saving, false);
  assert.equal(page.data.remarkName, 'newer draft');
  page.save(); second.resolve({}); await flush();
  assert.equal(calls, 2);
  assert.equal(page.data.editingId, '');
  assert.equal(page.data.remarkName, '');
  assert.equal(toasts.at(-1), '已更新');
});

test('A5 save cannot clear a cancelled/new draft or a different login', async () => {
  for (const scenario of ['cancel', 'account', 'unload']) {
    const pending = deferred(), toasts = [];
    const app = { globalData: { token: 'one', user: { id: 'one', role: 'admin' } } };
    const page = loadPage('pages/admin/whitelist/index.js', {
      'services/admin.js': { addWhitelist: () => pending.promise, whitelist: async () => ({ items: [] }) }
    }, { getApp: () => app, wx: { showToast: value => toasts.push(value.title) } });
    page.onShow(); await flush();
    page.setData({ remarkName: 'old' }); page.save();
    if (scenario === 'cancel') page.cancelEdit();
    if (scenario === 'account') {
      app.globalData = { token: 'two', user: { id: 'two', role: 'admin' } };
      page.onShow();
    }
    if (scenario === 'unload') page.onUnload();
    page.input({ currentTarget: { dataset: { key: 'remarkName' } }, detail: { value: 'new draft' } });
    pending.resolve({}); await flush();
    assert.equal(page.data.remarkName, 'new draft');
    if (scenario !== 'cancel') assert.equal(toasts.length, 0);
  }
});

test('A6 home waits for current session and ignores a hidden page refresh', async (t) => {
  for (const scenario of ['active', 'guest', 'hidden', 'new-login']) {
    const identity = deferred();
    const app = { globalData: { token: scenario === 'guest' ? '' : 'valid', user: { id: 'one', role: 'admin' } },
      refreshMe: () => identity.promise };
    const observed = [];
    const page = loadPage('pages/home/index.js', {
      'config/business.js': {}, 'services/user.js': {},
      'services/appointmentInbox.js': { summary: async () => ({ created: 0, changed: 0, total: 0 }) },
      'services/project.js': { list: async () => { observed.push(app.globalData.token); return { items: [] }; } },
      'services/therapist.js': { list: async () => ({ therapists: [] }) }
    }, { getApp: () => app });
    t.after(() => page.onHide());
    page.onShow();
    if (scenario === 'hidden') page.onHide();
    if (scenario === 'new-login') app.globalData = { token: 'new', user: { id: 'two', role: 'user', therapistId: 'assigned' } };
    identity.resolve({ id: 'old-result', role: 'admin' }); await flush();
    assert.deepEqual(observed, scenario === 'hidden' ? [] : [app.globalData.token]);
    if (scenario === 'new-login') {
      assert.equal(page.data.isAdmin, false);
      assert.equal(page.data.isTherapist, true);
    }
  }
});
