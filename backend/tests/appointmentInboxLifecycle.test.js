// Regression coverage promoted from the 2026-11-12 hidden-return audit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, 'appointmentInboxFrontend.test.js');
const setup = fs.readFileSync(source, 'utf8').split("for(const role of ['admin','therapist'])test(")[0];
const fixture = { exports: {} };
vm.runInNewContext(setup + '\nmodule.exports={harness,flush,result,readCalls};', {
  module: fixture, require: createRequire(source), __dirname, setImmediate
});
const { harness, flush, result, readCalls } = fixture.exports;
const copy = value => JSON.parse(JSON.stringify(value));

for (const role of ['admin', 'therapist']) {
  test(`${role}: late identity completion after hide/unload cannot start a background list or acknowledge it`, async () => {
    for (const leave of ['onHide', 'onUnload']) {
      const h = harness('list', role);
      let finishIdentity;
      h.app.refreshMe = () => new Promise(resolve => { finishIdentity = resolve; });
      h.page.onShow();
      const before = h.calls.length;
      h.page[leave]();
      finishIdentity(h.app.globalData.user); await flush();
      assert.equal(h.calls.length, before, 'hidden identity continuation must not issue a list request');
      h.render(); await flush();
      assert.equal(readCalls(h).length, 0);
      if (leave === 'onHide') {
        h.page.onShow();
        assert.equal(h.page.data.identityReady, false);
        finishIdentity(h.app.globalData.user); await flush();
        h.calls.at(-1).resolve({ ...result('current', '2', 'modified'), inboxViewId: 'current-view' });
        await flush(); h.render(); await flush();
        assert.deepEqual(copy(readCalls(h)[0].data), {
          viewId: 'current-view', entries: [{ id: 'current', version: '2' }]
        });
        readCalls(h)[0].resolve({ acknowledged: ['current'] }); await flush();
      }
      h.page.onUnload();
    }
  });

  test(`${role}: returning invalidates any hidden reload immediately, before the next identity refresh completes`, async () => {
    const h = harness('list', role);
    h.page.onHide();
    // Another previously confirmed operation may request a reload while hidden.
    // Even such a load cannot grant read permission to the next visible visit.
    h.page.load();
    h.calls.at(-1).resolve(result('hidden', '1', 'created')); await flush();
    let finishIdentity;
    h.app.refreshMe = () => new Promise(resolve => { finishIdentity = resolve; });
    h.page.onShow();
    assert.equal(h.page.data.loading, true);
    assert.equal(h.page.data.identityReady, false);
    assert.equal(h.page.data.appointments.length, 0);
    h.render(); await flush();
    assert.equal(readCalls(h).length, 0, 'old hidden rendering cannot acknowledge on the loading screen');
    finishIdentity(h.app.globalData.user); await flush();
    h.calls.at(-1).resolve({ ...result('current', '2', 'modified'), inboxViewId: 'current-view' });
    await flush(); h.render(); await flush();
    assert.deepEqual(copy(readCalls(h)[0].data.entries), [{ id: 'current', version: '2' }]);
    readCalls(h)[0].resolve({ acknowledged: ['current'] }); await flush(); h.page.onUnload();
  });

  test(`${role}: render and send both require a ready staff identity and the same displayed record version`, async () => {
    for (const stage of ['render', 'send']) for (const change of ['identity', 'guest', 'role', 'loading', 'removed', 'version']) {
      const h = harness('list', role);
      h.calls[0].resolve(result('old', '1')); await flush();
      if (stage === 'send') h.render();
      if (change === 'identity') h.page.data.identityReady = false;
      if (change === 'guest') h.page.data.hasUser = false;
      if (change === 'role') Object.assign(h.page.data, { isAdminMode: false, isTherapistMode: false });
      if (change === 'loading') h.page.data.loading = true;
      if (change === 'removed') h.page.data.appointments = [];
      if (change === 'version') h.page.data.appointments[0].unreadVersion = '2';
      if (stage === 'render') h.render();
      await flush();
      assert.equal(readCalls(h).length, 0, `${stage}/${change}`);
      h.page.onUnload();
    }
  });

  test(`${role}: queued receipt keeps only records still displayed at the shown version`, async () => {
    const h = harness('list', role);
    const response = result('a');
    response.appointments.push({ ...response.appointments[0], id: 'b', unreadVersion: '3' });
    h.calls[0].resolve(response); await flush(); h.render();
    h.page.data.appointments = h.page.data.appointments.filter(item => item.id === 'b');
    await flush();
    assert.deepEqual(copy(readCalls(h)[0].data.entries), [{ id: 'b', version: '3' }]);
    readCalls(h)[0].resolve({ acknowledged: ['b'] }); await flush(); h.page.onUnload();
  });

  test(`${role}: old in-flight receipt completion cannot retry or consume the returned page's read queue`, async () => {
    for (const fail of [false, true]) {
      const h = harness('list', role);
      h.calls[0].resolve(result('old')); await flush(); h.render(); await flush();
      const oldRead = readCalls(h)[0];
      h.page.onHide();
      let finishIdentity;
      h.app.refreshMe = () => new Promise(resolve => { finishIdentity = resolve; });
      h.page.onShow();
      if (fail) oldRead.reject(new Error('offline')); else oldRead.resolve({ acknowledged: ['old'] });
      await flush(); h.render(); await flush();
      assert.equal(readCalls(h).length, 1);
      assert.equal(h.timers.size, 0, 'old failures cannot schedule retries in the new visit');
      finishIdentity(h.app.globalData.user); await flush();
      h.calls.at(-1).resolve({ ...result('current', '2', 'modified'), inboxViewId: 'current-view' });
      await flush(); h.render(); await flush();
      assert.deepEqual(copy(readCalls(h)[1].data), {
        viewId: 'current-view', entries: [{ id: 'current', version: '2' }]
      });
      readCalls(h)[1].resolve({ acknowledged: ['current'] }); await flush(); h.page.onUnload();
    }
  });

  test(`${role}: late identity result from an earlier visit cannot replace the new account or request a list`, async () => {
    const h = harness('list', role);
    const identities = [];
    h.app.refreshMe = () => new Promise(resolve => { identities.push(resolve); });
    const oldUser = h.app.globalData.user;
    h.page.onShow(); h.page.onHide();
    h.app.globalData.user = { id: 'account-b', role: 'admin' };
    h.app.globalData.token = 'session-b';
    h.page.onShow();
    const before = h.calls.length;
    identities[0](oldUser); await flush(); h.render(); await flush();
    assert.equal(h.calls.length, before);
    assert.equal(h.page.data.identityReady, false);
    assert.equal(readCalls(h).length, 0);
    identities[1](h.app.globalData.user); await flush();
    h.calls.at(-1).resolve({ ...result('account-b-record'), inboxViewId: 'account-b-view' });
    await flush(); h.render(); await flush();
    assert.equal(readCalls(h)[0].data.viewId, 'account-b-view');
    readCalls(h)[0].resolve({ acknowledged: ['account-b-record'] }); await flush(); h.page.onUnload();
  });
}
