// Read-only follow-up audit: no application source substitution or database access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const original = path.resolve(__dirname, '../appointmentInboxFrontend.test.js');
const setup = fs.readFileSync(original, 'utf8').split("for(const role of ['admin','therapist'])test(")[0];
const fixture = { exports: {} };
vm.runInNewContext(setup + '\nmodule.exports={harness,flush,result,readCalls};', {
  require: createRequire(original), module: fixture, __dirname: path.dirname(original), setImmediate
});
const { harness, flush, result, readCalls } = fixture.exports;
const clone = value => JSON.parse(JSON.stringify(value));
const listCalls = h => h.calls.filter(call => call.url.includes('/appointments?'));

for (const role of ['admin', 'therapist']) {
  test(`${role}: returning while refreshMe is deduplicated still loads and acknowledges the new visible visit`, async () => {
    const h = harness('list', role);
    let completeIdentity;
    const pending = new Promise(resolve => { completeIdentity = resolve; });
    h.app.refreshMe = () => pending;
    h.page.onShow(); h.page.onHide(); h.page.onShow();
    const before = listCalls(h).length;
    completeIdentity(h.app.globalData.user); await flush();
    assert.equal(listCalls(h).length, before + 1, 'only the newest visible callback loads');
    listCalls(h).at(-1).resolve({ ...result('visible'), inboxViewId: 'visible-view' });
    await flush(); h.render(); await flush();
    assert.deepEqual(clone(readCalls(h)[0].data), {
      viewId: 'visible-view', entries: [{ id: 'visible', version: '1' }]
    });
    readCalls(h)[0].resolve({ acknowledged: ['visible'] }); await flush(); h.page.onUnload();
  });

  test(`${role}: old receipt finishing after the fresh list is rendered releases the new queue once`, async () => {
    for (const fail of [false, true]) {
      const h = harness('list', role);
      h.calls[0].resolve(result('old')); await flush(); h.render(); await flush();
      const old = readCalls(h)[0];
      Object.assign(h.page.data, { sort: 'created_asc', filterStartTime: '09:00', filterEndTime: '16:00' });
      h.page.onHide(); h.page.onShow(); await flush();
      const list = listCalls(h).at(-1);
      const query = new URL(list.url, 'http://localhost').searchParams;
      assert.equal(query.get('sort'), 'created_asc');
      assert.equal(query.get('startTime'), '09:00'); assert.equal(query.get('endTime'), '16:00');
      list.resolve({ ...result('fresh', '2', 'modified'), inboxViewId: 'fresh-view' });
      await flush(); h.render(); await flush();
      assert.equal(readCalls(h).length, 1, 'one in-flight request still serializes transport');
      if (fail) old.reject(new Error('old offline')); else old.resolve({ acknowledged: ['old'] });
      await flush();
      assert.equal(readCalls(h).length, 2); assert.equal(h.timers.size, 0);
      assert.deepEqual(clone(readCalls(h)[1].data), {
        viewId: 'fresh-view', entries: [{ id: 'fresh', version: '2' }]
      });
      readCalls(h)[1].resolve({ acknowledged: ['fresh'] }); await flush();
      assert.equal(readCalls(h).length, 2); assert.equal(h.page.data.appointments[0].unreadKind, 'modified');
      h.page.onUnload();
    }
  });

  test(`${role}: returning with a retained filter drawer delays fresh confirmations until the drawer closes`, async () => {
    const h = harness('list', role);
    h.page.data.filterDrawerVisible = true;
    h.page.onHide(); h.page.onShow(); await flush();
    listCalls(h).at(-1).resolve({ ...result('fresh'), inboxViewId: 'fresh-view' });
    await flush(); h.render(); await flush();
    assert.equal(readCalls(h).length, 0);
    h.page.closeFilterDrawer({ currentTarget: { dataset: { filterVersion: h.page.data.filterVersion } } });
    h.render(); await flush();
    assert.equal(readCalls(h).length, 1); assert.equal(readCalls(h)[0].data.viewId, 'fresh-view');
    readCalls(h)[0].resolve({ acknowledged: ['fresh'] }); await flush(); h.page.onUnload();
  });

  test(`${role}: reverse render completion across three pages neither loses nor duplicates receipts`, async () => {
    const h = harness('list', role);
    for (let page = 1; page <= 3; page++) {
      if (page > 1) h.page.onReachBottom();
      listCalls(h).at(-1).resolve({ ...result(`page-${page}`, `${page}`, 'created', page < 3),
        pagination: { page, hasMore: page < 3, nextCursor: `cursor-${page}` } });
      await flush();
    }
    assert.equal(readCalls(h).length, 0);
    while (h.renders.length) h.renders.pop()();
    await flush();
    for (let n = 0; n < 3; n++) {
      assert.equal(readCalls(h).length, n + 1);
      const call = readCalls(h)[n];
      call.resolve({ acknowledged: call.data.entries.map(entry => entry.id) }); await flush();
    }
    assert.deepEqual(clone(readCalls(h).flatMap(call => call.data.entries)).sort((a, b) => a.id.localeCompare(b.id)), [
      { id: 'page-1', version: '1' }, { id: 'page-2', version: '2' }, { id: 'page-3', version: '3' }
    ]);
    assert.deepEqual(clone(h.page.data.appointments.map(item => item.id)), ['page-1', 'page-2', 'page-3']);
    h.page.onUnload();
  });

  test(`${role}: logging back into the same account invalidates the old session render and retry`, async () => {
    const h = harness('list', role);
    h.calls[0].resolve(result('old')); await flush();
    h.page.onHide();
    h.app.globalData.token = 'replacement-session'; h.app._loginSessionVersion++;
    h.page.onShow(); h.render(); await flush();
    assert.equal(readCalls(h).length, 0);
    listCalls(h).at(-1).resolve({ ...result('new-session', '2'), inboxViewId: 'new-session-view' });
    await flush(); h.render(); await flush();
    assert.equal(readCalls(h).length, 1); assert.equal(readCalls(h)[0].data.viewId, 'new-session-view');
    readCalls(h)[0].resolve({ acknowledged: ['new-session'] }); await flush(); h.page.onUnload();
  });
}
