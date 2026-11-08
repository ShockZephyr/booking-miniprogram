// Regression cases promoted from the 2026-11-12 audit reproductions.
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

test('starting or finishing an append before the first render still acknowledges both displayed pages', async () => {
  for (const role of ['admin', 'therapist']) for (const finishEarly of [false, true]) {
    const h = harness('list', role);
    h.calls[0].resolve(result('first-page', '1', 'created', true));
    await flush();
    assert.equal(h.page.data.appointments.length, 1);
    // Transport data was applied, but the render acknowledgment is still queued.
    h.page.onReachBottom();
    const nextPage = h.calls.at(-1);
    const second = { ...result('second-page', '1', 'created'), pagination: { page: 2, hasMore: false } };
    if (finishEarly) { nextPage.resolve(second); await flush(); }
    h.render(); await flush();
    assert.equal(readCalls(h).length, 1, 'append must not invalidate the displayed first page');
    assert.equal(readCalls(h)[0].data.entries[0].id, 'first-page');
    readCalls(h)[0].resolve({ acknowledged: ['first-page'] }); await flush();
    nextPage.resolve(second);
    await flush(); h.render(); await flush();
    const observed = JSON.parse(JSON.stringify(readCalls(h).flatMap(call => call.data.entries.map(item => item.id))));
    assert.deepEqual(observed, ['first-page', 'second-page']);
    assert.equal(h.page.data.appointments.length, 2, 'both pages are still rendered');
    readCalls(h)[1].resolve({ acknowledged: ['second-page'] }); await flush();
    h.page.onHide();
  }
});

test('failed append still allows the already displayed first page to become read', async () => {
  const h = harness();
  h.calls[0].resolve(result('first-page', '1', 'created', true)); await flush();
  h.page.onReachBottom(); h.calls.at(-1).reject(new Error('offline')); await flush();
  h.render(); await flush();
  assert.equal(readCalls(h)[0].data.entries[0].id, 'first-page');
  assert.equal(h.page.data.moreError, 'offline');
  assert.equal(h.page.data.appointments.length, 1);
  readCalls(h)[0].resolve({ acknowledged: ['first-page'] }); await flush(); h.page.onHide();
});

test('a refresh, tab switch, hidden page or account switch still invalidates old render receipts during append', async () => {
  for (const change of ['refresh', 'tab', 'hide', 'account']) {
    const h = harness();
    h.calls[0].resolve(result('old-page', '1', 'created', true)); await flush();
    h.page.onReachBottom(); const oldAppend = h.calls.at(-1);
    if (change === 'refresh') h.page.load();
    if (change === 'tab') h.page.switchTab({ currentTarget: { dataset: { key: 'cancelled' } } });
    if (change === 'hide') h.page.onHide();
    if (change === 'account') {
      h.app.globalData.user = { id: 'account-b', role: 'admin' };
      h.app.globalData.token = 'session-b';
      h.page.showForUser(h.app.globalData.user);
    }
    h.render(); await flush();
    oldAppend.resolve(result('old-next-page')); await flush(); h.render(); await flush();
    assert.equal(readCalls(h).length, 0, change);
    h.page.onHide();
  }
});

test('invalidated snapshot reload retains the query and acknowledges only the freshly rendered content', async () => {
  const h = harness('list', 'therapist');
  Object.assign(h.page.data, { filterStartTime: '09:00', filterEndTime: '16:00', sort: 'service_asc' });
  h.calls[0].resolve(result('old', '1', 'created', true)); await flush();
  h.page.onReachBottom(); h.calls.at(-1).reject({ code: 'INBOX_VIEW_EXPIRED' }); await flush();
  h.render(); await flush();
  assert.equal(readCalls(h).length, 0, 'old render cannot acknowledge the refreshed query');
  const fresh = h.calls.at(-1);
  const query = new URL(fresh.url, 'http://localhost').searchParams;
  assert.equal(query.get('page'), '1'); assert.equal(query.has('cursor'), false);
  assert.equal(query.get('sort'), 'service_asc'); assert.equal(query.get('startTime'), '09:00');
  assert.equal(query.get('endTime'), '16:00');
  fresh.resolve({ ...result('new', '2', 'modified'), inboxViewId: 'fresh-view' });
  await flush(); h.render(); await flush();
  assert.equal(readCalls(h)[0].data.viewId, 'fresh-view');
  assert.equal(readCalls(h)[0].data.entries[0].version, '2');
  assert.equal(h.page.data.appointments[0].unreadKind, 'modified');
  readCalls(h)[0].resolve({ acknowledged: ['new'] }); await flush(); h.page.onHide();
});

test('neighbor: rendering before append correctly acknowledges both pages', async () => {
  const h = harness();
  h.calls[0].resolve(result('first-page', '1', 'created', true)); await flush(); h.render(); await flush();
  readCalls(h)[0].resolve({ acknowledged: ['first-page'] }); await flush();
  h.page.onReachBottom();
  h.calls.at(-1).resolve({ ...result('second-page'), pagination: { page: 2, hasMore: false } });
  await flush(); h.render(); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(readCalls(h).flatMap(call => call.data.entries.map(item => item.id)))), ['first-page', 'second-page']);
  readCalls(h)[1].resolve({ acknowledged: ['second-page'] }); await flush(); h.page.onHide();
});
