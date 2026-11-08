const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../miniprogram');
const flush = () => new Promise(resolve => setImmediate(resolve));

// Keep app, request, cache and services real; only replace the WeChat transport
// and merchant configuration. No external network or personal data is used.
function fixture() {
  let app, home;
  const modules = new Map(), calls = [];
  const mocks = {
    'config/env.js': { API_BASE_URL: 'https://audit.invalid', REQUEST_TIMEOUT: 15000 },
    'config/business.js': { name: 'synthetic fallback' }
  };
  const wx = {
    request: options => calls.push(options), uploadFile: options => calls.push(options),
    setStorageSync() {}, removeStorageSync() {}, getStorageSync() { return ''; }
  };
  function load(relative) {
    if (Object.hasOwn(mocks, relative)) return mocks[relative];
    if (modules.has(relative)) return modules.get(relative).exports;
    const module = { exports: {} }; modules.set(relative, module);
    vm.runInNewContext(fs.readFileSync(path.join(root, relative), 'utf8'), {
      module, exports: module.exports, wx, console, setTimeout, clearTimeout,
      App: value => { app = value; }, Page: value => { home = value; }, getApp: () => app,
      require: name => load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), name + '.js')))
    }, { filename: relative });
    return module.exports;
  }
  load('app.js'); load('pages/home/index.js');
  home.setData = patch => Object.assign(home.data, patch);
  app.setSession('synthetic-session', { id: 'synthetic-user', role: 'user' });
  const requests = route => calls.filter(call => new URL(call.url).pathname === route);
  function respond(call, status, data) {
    assert.ok(call, 'request must exist');
    call.success({ statusCode: status, data: status === 200 ? { success: true, data }
      : { success: false, code: 'INVALID_SESSION', message: 'synthetic expired session' } });
  }
  function catalogsOk() {
    respond(requests('/api/projects').at(-1), 200, { items: [{ id: 'project', name: 'synthetic project' }] });
    respond(requests('/api/therapists').at(-1), 200, { therapists: [{ id: 'therapist', name: 'synthetic therapist' }] });
  }
  return { app, home, load, requests, respond, catalogsOk };
}

test('cold home stays loading until identity and catalog requests finish, including empty results', async () => {
  const { home, app, requests, respond } = fixture();
  home.onShow(); await flush();
  assert.equal(requests('/api/projects').length, 0);
  assert.equal(home.data.projectsLoading, true);
  assert.equal(home.data.therapistsLoading, true);
  respond(requests('/api/auth/me')[0], 200, { user: app.globalData.user }); await flush();
  assert.equal(home.data.projectsLoading, true);
  respond(requests('/api/projects')[0], 200, { items: [] });
  respond(requests('/api/therapists')[0], 200, { therapists: [] }); await flush();
  assert.equal(home.data.projectsLoading, false);
  assert.equal(home.data.therapistsLoading, false);
  assert.equal(home.data.projectError, '');
  assert.equal(home.data.projects.length, 0);
});

test('expired cold login still displays server merchant metadata and public catalogs without reentry', async () => {
  const { home, app, requests, respond, catalogsOk } = fixture();
  home.onLoad(); home.onShow(); await flush();
  assert.equal(requests('/api/meta/business')[0].header.authorization, undefined);
  respond(requests('/api/meta/business')[0], 200, { name: 'server merchant' });
  respond(requests('/api/auth/me')[0], 401); await flush();
  assert.equal(app.globalData.token, '');
  assert.equal(requests('/api/projects')[0].header.authorization, undefined);
  assert.equal(requests('/api/therapists')[0].header.authorization, undefined);
  catalogsOk(); await flush();
  assert.equal(home.data.business.name, 'server merchant');
  assert.equal(home.data.projectError, ''); assert.equal(home.data.projects.length, 1);
  assert.equal(home.data.therapistError, ''); assert.equal(home.data.therapists.length, 1);
});

test('shared pending public catalog requests remain usable across session revocation and page return', async () => {
  const { home, app, requests, respond, catalogsOk } = fixture();
  home.onShow();
  respond(requests('/api/auth/me')[0], 200, { user: app.globalData.user }); await flush();
  assert.equal(requests('/api/projects')[0].header.authorization, undefined);
  assert.equal(requests('/api/therapists')[0].header.authorization, undefined);
  home.onHide(); home.onShow();
  respond(requests('/api/auth/me')[1], 401); await flush();
  assert.equal(app.globalData.token, '');
  assert.equal(requests('/api/projects').length, 1, 'public concurrent cache deduplication is retained');
  catalogsOk(); await flush();
  assert.equal(home.data.projectError, ''); assert.equal(home.data.projects.length, 1);
  assert.equal(home.data.therapistError, ''); assert.equal(home.data.therapists.length, 1);
});

test('only public DTO reads omit authorization; protected requests and uploads keep it and preserve 401', async () => {
  const { load, app, requests, respond } = fixture();
  const user = load('services/user.js'), project = load('services/project.js'), therapist = load('services/therapist.js');
  const publicCalls = [user.business(), user.serviceItems(), project.list(), project.detail('p'), therapist.list(), therapist.detail('t')];
  await flush();
  for (const [route, data] of [['/api/meta/business', { name: 'server' }], ['/api/meta/service-items', { items: [] }],
    ['/api/projects', { items: [] }], ['/api/projects/p', { item: {} }],
    ['/api/therapists', { therapists: [] }], ['/api/therapists/t', { therapist: {} }]]) {
    assert.equal(requests(route)[0].header.authorization, undefined, route);
    respond(requests(route)[0], 200, data);
  }
  await Promise.all(publicCalls);
  const request = load('utils/request.js');
  const protectedCalls = [
    ['/api/appointments/my', request({ url: '/api/appointments/my' })],
    ['/api/slots', request({ url: '/api/slots' })],
    ['/api/admin/projects/p', project.save('p', {})],
    ['/api/admin/projects/recycle-bin', project.recycleBin()],
    ['/api/admin/therapists/t', therapist.adminDetail('t')],
    ['/api/admin/therapist-images', therapist.upload('synthetic-file')]
  ];
  for (const [route, promise] of protectedCalls) {
    const denied = assert.rejects(promise, error => error.statusCode === 401 && error.code === 'INVALID_SESSION');
    assert.equal(requests(route)[0].header.authorization, 'Bearer synthetic-session', route);
    respond(requests(route)[0], 401); await denied;
  }
  assert.equal(app.globalData.token, 'synthetic-session', 'transport does not swallow 401 or clear a newer session');
});

test('home network failure can retry and cached content is not replaced by loading or empty states', async () => {
  const { home, app, requests, respond, catalogsOk } = fixture();
  app.clearSession(); home.onShow(); await flush();
  requests('/api/projects')[0].fail({ errMsg: 'simulated offline' });
  requests('/api/therapists')[0].fail({ errMsg: 'simulated offline' }); await flush();
  assert.equal(home.data.projectsLoading, false); assert.ok(home.data.projectError);
  home.loadProjects(); home.loadTherapists(); await flush();
  catalogsOk(); await flush();
  assert.equal(home.data.projects.length, 1); assert.equal(home.data.projectError, '');
  app.setSession('new-session', { id: 'new-user', role: 'admin' });
  home.onShow();
  assert.equal(home.data.projectsLoading, false); assert.equal(home.data.projects.length, 1);
  home.onHide(); respond(requests('/api/auth/me').at(-1), 200, { user: app.globalData.user }); await flush();
  assert.equal(requests('/api/projects').length, 2, 'hidden page does not start another catalog load');
});

test('authenticated project changes still invalidate the public catalog cache', async () => {
  const { load, requests, respond } = fixture();
  const project = load('services/project.js');
  let pending = project.list(); await flush(); respond(requests('/api/projects')[0], 200, { items: [{ id: 'p', name: 'before' }] }); await pending;
  pending = project.save('p', { name: 'after' });
  assert.equal(requests('/api/admin/projects/p')[0].header.authorization, 'Bearer synthetic-session');
  respond(requests('/api/admin/projects/p')[0], 200, { item: { id: 'p', name: 'after' } }); await pending;
  pending = project.list(); await flush();
  assert.equal(requests('/api/projects').length, 2);
  assert.equal(requests('/api/projects')[1].header.authorization, undefined);
  respond(requests('/api/projects')[1], 200, { items: [{ id: 'p', name: 'after' }] });
  assert.equal((await pending).items[0].name, 'after');
});
