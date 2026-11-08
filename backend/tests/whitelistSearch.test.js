const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "../../miniprogram/pages/admin/whitelist");
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const members = [
  { id: "a", phone: "synthetic-phone-a", remarkName: "测试甲" },
  { id: "b", phone: "synthetic-phone-b", remarkName: "测试乙" }
];

test("fixed test membership edits omit the identifier; inactive membership requires explicit restore", async () => {
  const h = harness(); await h.ready();
  h.page.setData({ items: [{ id: "review", phone: "review:user", isReviewMember: true, status: "active", remarkName: "审核会员" }] });
  h.page.edit({ currentTarget: { dataset: { id: "review" } } });
  h.page.input({ currentTarget: { dataset: { key: "phone" } }, detail: { value: "13900000006" } });
  assert.equal(h.page.data.phone, "review:user");
  h.page.input({ currentTarget: { dataset: { key: "remarkName" } }, detail: { value: "更新备注" } });
  await h.page.save();
  assert.deepEqual(h.saves[0], { id: "review", remarkName: "更新备注" });
  h.requests.at(-1).resolve({ items: [{ id: "review", isReviewMember: true, status: "inactive" }] }); await flush();
  h.page.selectItems({ detail: { value: ["review"] } });
  assert.deepEqual(plain(h.page.data.selectedIds), []);
  h.page.setData({ phone: "未提交", remarkName: "草稿" });
  const action = h.page.restoreReviewMember({ currentTarget: { dataset: { id: "review" } } });
  h.page.restoreReviewMember({ currentTarget: { dataset: { id: "review" } } });
  await flush();
  assert.deepEqual(h.saves[1], { id: "review", status: "active" });
  assert.equal(h.saves.length, 2);
  h.requests.at(-1).resolve({ items: [] }); await action;
  assert.equal(h.page.data.phone, "未提交"); assert.equal(h.page.data.remarkName, "草稿");
});

test("test member restore ignores late results after hide or account switch", async () => {
  for (const mode of ["hide", "switch"]) {
    const h = harness(); await h.ready();
    h.page.setData({ items: [{ id: "review", isReviewMember: true, status: "inactive" }] });
    const action = h.page.restoreReviewMember({ currentTarget: { dataset: { id: "review" } } });
    if (mode === "hide") h.page.onHide(); else h.app.globalData.token = "other-session";
    await action;
    assert.equal(h.requests.length, 1, "no stale list refresh");
    h.page.onShow();
    assert.equal(h.page.data.restoringId, "");
  }
});

// Virtual debounce clock and fake services: no real timers, requests or member data.
function harness() {
  let page, now = 0, nextTimer = 0;
  const timers = new Map(), requests = [], modals = [], scrolls = [], removals = [], saves = [];
  const app = { _loginSessionVersion: 1, globalData: { token: "test-token", user: { id: "admin-a", role: "admin" } } };
  const api = {
    whitelist: (query) => {
      const request = { ...deferred(), query: plain(query) }; requests.push(request); return request.promise;
    },
    batchDeleteWhitelist: (ids) => {
      const request = { ...deferred(), ids: plain(ids) }; removals.push(request); return request.promise;
    },
    addWhitelist: (payload) => { saves.push(plain(payload)); return Promise.resolve({}); },
    updateWhitelist: (id, payload) => { saves.push({ id, ...plain(payload) }); return Promise.resolve({}); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "index.js"), "utf8"), {
    Page: (definition) => { page = definition; }, require: () => api, getApp: () => app,
    wx: { showToast() {}, showModal: (options) => modals.push(options), pageScrollTo: (options) => scrolls.push(options) },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id)
  });
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) callback(); };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = end;
  };
  const input = (value) => page.input({ currentTarget: { dataset: { key: "keyword" } }, detail: { value } });
  const ready = async () => {
    page.onShow();
    requests[0].resolve({ items: members, pagination: { hasMore: true, nextCursor: "cursor-1" } });
    await flush();
  };
  return { page, app, timers, requests, modals, scrolls, removals, saves, advance, input, ready };
}

test("keyword changes immediately uncheck retained rows and lock all old-list operations until new results arrive", async () => {
  const h = harness(); await h.ready();
  h.page.selectItems({ detail: { value: ["a", "b"] } });
  h.input(" 测试 ");
  assert.deepEqual(plain(h.page.data.selectedIds), []);
  assert.deepEqual(plain(h.page.data.items.map((item) => item.id)), ["a", "b"]);
  assert.ok(h.page.data.items.every((item) => !item.checked));
  assert.equal(h.page.data.searchPending, true);
  assert.equal(h.page.data.resultsStale, true);
  assert.equal(h.page.data.hasMore, false);
  h.page.selectItems({ detail: { value: ["a"] } });
  h.page.edit({ currentTarget: { dataset: { id: "a" } } });
  h.page.batchRemove(); h.page.onReachBottom();
  assert.equal(h.page.data.editingId, "");
  assert.deepEqual(plain(h.page.data.selectedIds), []);
  assert.equal(h.modals.length, 0);
  assert.equal(h.requests.length, 1);
  h.advance(399); assert.equal(h.requests.length, 1);
  h.advance(1); assert.deepEqual(h.requests[1].query, { keyword: "测试", status: "active", includeInactiveReview: true, cursor: "" });
  assert.equal(h.page.data.loading, true);
  assert.equal(h.page.data.items.length, 2);
  h.requests[1].resolve({ items: [{ id: "c", phone: "synthetic-phone-c" }] }); await flush();
  assert.equal(h.page.canUseResults(), true);
  h.page.selectItems({ detail: { value: ["c"] } });
  h.page.edit({ currentTarget: { dataset: { id: "c" } } });
  assert.equal(h.page.data.editingId, "c");
  assert.deepEqual(plain(h.page.data.selectedIds), ["c"]);
});

test("debounce restarts on every changed keyword; button and keyboard search submit once immediately", async () => {
  const h = harness(); await h.ready();
  h.input("1"); h.advance(300); h.input("12"); h.advance(300);
  assert.equal(h.requests.length, 1);
  h.page.search(); h.page.search();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].query.keyword, "12");
  assert.equal(h.timers.size, 0);
  h.advance(1000); assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ items: members }); await flush();
  h.page.selectItems({ detail: { value: ["a"] } });
  h.input("12");
  assert.deepEqual(plain(h.page.data.selectedIds), ["a"], "unchanged input events are not keyword changes");
  h.input("123");
  assert.deepEqual(plain(h.page.data.selectedIds), []);
  h.advance(400); assert.equal(h.requests.at(-1).query.keyword, "123");
});

test("clear immediately requests the unfiltered first page, cancels debounce, scrolls to the list start and retains the form", async () => {
  const h = harness(); await h.ready();
  h.page.edit({ currentTarget: { dataset: { id: "a" } } });
  h.page.input({ currentTarget: { dataset: { key: "remarkName" } }, detail: { value: "未保存修改" } });
  h.page.selectItems({ detail: { value: ["b"] } });
  h.input("备注");
  h.page.clearSearch();
  assert.equal(h.page.data.keyword, "");
  assert.deepEqual(plain(h.page.data.selectedIds), []);
  assert.ok(h.page.data.items.every((item) => !item.checked));
  assert.deepEqual(h.requests[1].query, { keyword: "", status: "active", includeInactiveReview: true, cursor: "" });
  assert.deepEqual(plain(h.scrolls), [{ selector: ".search", duration: 0 }]);
  assert.equal(h.page.data.editingId, "a");
  assert.equal(h.page.data.phone, "synthetic-phone-a");
  assert.equal(h.page.data.remarkName, "未保存修改");
  h.advance(1000); assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ items: members, pagination: { hasMore: true, nextCursor: "all-first-page" } }); await flush();
  assert.equal(h.page.data.resultKeyword, "");
  assert.equal(h.page.data.hasMore, true, "clear restores pagination, not an all-records fetch");
  assert.equal(h.page.data.nextCursor, "all-first-page");
});

test("deleting the last character or entering only whitespace also immediately restores an unfiltered query", async () => {
  for (const empty of ["", "   "]) {
    const h = harness(); await h.ready();
    h.input("名字"); h.advance(400);
    h.input(empty);
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].query.keyword, "");
    h.requests[2].resolve({ items: [] }); await flush();
    h.requests[1].resolve({ items: [{ id: "stale" }] }); await flush();
    assert.deepEqual(plain(h.page.data.items), []);
    assert.equal(h.page.data.resultKeyword, "");
    assert.equal(h.page.data.resultsStale, false);
  }
});

test("late success and failure cannot overwrite newer results even when the keyword changes back", async () => {
  const h = harness(); await h.ready();
  h.input("甲"); h.advance(400);
  h.input("乙"); h.advance(400);
  h.input("甲"); h.advance(400);
  h.requests[3].resolve({ items: [{ id: "new-a" }] }); await flush();
  h.requests[1].resolve({ items: [{ id: "old-a" }] });
  h.requests[2].reject(new Error("old failure")); await flush();
  assert.deepEqual(plain(h.page.data.items.map((item) => item.id)), ["new-a"]);
  assert.equal(h.page.data.resultKeyword, "甲");
  assert.equal(h.page.data.error, "");
});

test("failed replacement keeps stale rows locked, exposes retry and distinguishes successful empty results", async () => {
  const h = harness(); await h.ready();
  h.input("不存在"); h.advance(400);
  h.requests[1].reject(new Error("网络连接失败")); await flush();
  assert.equal(h.page.data.error, "网络连接失败");
  assert.equal(h.page.data.items.length, 2);
  assert.equal(h.page.canUseResults(), false);
  h.page.retrySearch(); h.page.retrySearch();
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve({ items: [] }); await flush();
  assert.equal(h.page.data.error, "");
  assert.equal(h.page.data.resultsStale, false);
  assert.equal(h.page.data.resultKeyword, "不存在");
  assert.equal(h.page.data.items.length, 0);
});

test("search invalidates an old append, starts at the first cursor, and retries failed pagination without losing rows", async () => {
  const h = harness(); await h.ready();
  h.page.onReachBottom();
  assert.equal(h.requests[1].query.cursor, "cursor-1");
  h.input("乙"); h.page.onReachBottom(); h.advance(400);
  assert.equal(h.requests[2].query.cursor, "");
  h.requests[1].resolve({ items: [{ id: "old-append" }], pagination: { hasMore: true, nextCursor: "old-cursor" } });
  h.requests[2].resolve({ items: [{ id: "match-1" }], pagination: { hasMore: true, nextCursor: "match-cursor" } }); await flush();
  h.page.onReachBottom(); h.page.onReachBottom();
  assert.equal(h.requests.length, 4);
  h.requests[3].reject(new Error("append failed")); await flush();
  assert.equal(h.page.data.failedAppend, true);
  assert.deepEqual(plain(h.page.data.items.map((item) => item.id)), ["match-1"]);
  h.page.retrySearch();
  assert.deepEqual(h.requests[4].query, { keyword: "乙", status: "active", includeInactiveReview: true, cursor: "match-cursor" });
  h.requests[4].resolve({ items: [{ id: "match-1" }, { id: "match-2" }], pagination: { hasMore: false } }); await flush();
  assert.deepEqual(plain(h.page.data.items.map((item) => item.id)), ["match-1", "match-2"]);
  assert.equal(h.page.data.hasMore, false);
});

test("leaving or changing login cancels pending searches and ignores old network results", async () => {
  for (const mode of ["hide", "unload", "account", "same-account-new-login"]) {
    const h = harness(); await h.ready();
    h.input("未提交");
    if (mode === "hide") h.page.onHide();
    if (mode === "unload") h.page.onUnload();
    if (mode === "account") h.app.globalData = { token: "other", user: { id: "admin-b", role: "admin" } };
    if (mode === "same-account-new-login") h.app._loginSessionVersion++;
    h.advance(1000);
    assert.equal(h.requests.length, 1, mode);
    h.page.onShow();
    assert.equal(h.requests[1].query.keyword, mode === "hide" || mode === "unload" ? "未提交" : "");
  }
  const h = harness(); await h.ready();
  h.input("甲"); h.advance(400); h.page.onHide();
  h.requests[1].resolve({ items: [{ id: "late-hidden" }] }); await flush();
  assert.deepEqual(plain(h.page.data.items.map((item) => item.id)), ["a", "b"]);
});

test("keyword changes invalidate removal confirmations for one or multiple selected members", async () => {
  for (const ids of [["a"], ["a", "b"]]) {
    const h = harness(); await h.ready();
    h.page.selectItems({ detail: { value: ids } });
    h.page.batchRemove();
    assert.equal(h.modals.length, 1);
    h.input("乙"); h.advance(400);
    h.requests[1].resolve({ items: members }); await flush();
    h.modals[0].success({ confirm: true });
    assert.equal(h.removals.length, 0, "even matching new rows cannot revive a stale confirmation");
    assert.deepEqual(plain(h.page.data.selectedIds), []);
  }
});

test("confirmed batch removal uses captured ids and refreshes the latest query without discarding the form", async () => {
  const h = harness(); await h.ready();
  h.page.data.phone = "synthetic-new-member"; h.page.data.remarkName = "未保存";
  h.page.selectItems({ detail: { value: ["a", "b"] } }); h.page.batchRemove();
  h.modals[0].success({ confirm: true });
  h.input("新结果"); h.advance(400);
  h.requests[1].resolve({ items: [{ id: "c" }] }); await flush();
  h.page.selectItems({ detail: { value: ["c"] } });
  h.removals[0].resolve({}); await flush();
  assert.deepEqual(h.removals[0].ids, ["a", "b"]);
  assert.deepEqual(plain(h.page.data.items.map((item) => item.id)), ["c"]);
  assert.equal(h.requests[2].query.keyword, "新结果");
  assert.equal(h.page.data.phone, "synthetic-new-member");
  assert.equal(h.page.data.remarkName, "未保存");
});

test("form fields never schedule search, and saving the form cancels a redundant queued search", async () => {
  const h = harness(); await h.ready();
  h.page.input({ currentTarget: { dataset: { key: "phone" } }, detail: { value: "synthetic-phone" } });
  h.page.input({ currentTarget: { dataset: { key: "remarkName" } }, detail: { value: "草稿" } });
  assert.equal(h.timers.size, 0);
  h.input("乙"); await h.page.save();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].query.keyword, "乙");
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.saves, [{ phone: "synthetic-phone", remarkName: "草稿" }]);
});

test("late save events cannot start member writes before show, after leaving or under a different session", async () => {
  for (const editing of [false, true]) {
    for (const phase of ["before-show", "hide", "unload", "account", "login-version", "token", "role", "logout"]) {
      const h = harness();
      if (phase !== "before-show") await h.ready();
      h.page.setData({ editingId: editing ? "a" : "", phone: "synthetic-draft-phone", remarkName: "原草稿" });
      if (phase === "hide") h.page.onHide();
      if (phase === "unload") h.page.onUnload();
      if (phase === "account") h.app.globalData.user.id = "admin-b";
      if (phase === "login-version") h.app._loginSessionVersion++;
      if (phase === "token") h.app.globalData.token = "new-test-session";
      if (phase === "role") h.app.globalData.user.role = "user";
      if (phase === "logout") h.app.globalData = { token: "", user: null };
      const before = plain(h.page.data), saveId = h.page._saveId, reads = h.requests.length;
      await h.page.save();
      assert.equal(h.saves.length, 0, `${phase}, editing=${editing}`);
      assert.deepEqual(plain(h.page.data), before, "ignored taps must neither clear drafts nor leave saving enabled");
      assert.equal(h.page._saveId, saveId);
      assert.equal(h.requests.length, reads);
    }
  }
});

test("visible member forms can save while searches are pending, loading, failed or refreshing after return", async () => {
  for (const editing of [false, true]) {
    for (const phase of ["debounce", "loading", "failed", "returned"]) {
      const h = harness(); await h.ready();
      const payload = { phone: "synthetic-draft-phone", remarkName: "正常草稿" };
      h.page.setData({ ...payload, editingId: editing ? "a" : "" });
      if (phase === "returned") { h.page.onHide(); h.page.onShow(); }
      else {
        h.input("新搜索");
        if (phase !== "debounce") h.advance(400);
        if (phase === "failed") { h.requests.at(-1).reject(new Error("simulated list failure")); await flush(); }
      }
      const saving = h.page.save();
      h.page.save();
      await saving;
      assert.deepEqual(h.saves, [editing ? { id: "a", ...payload } : payload], phase);
      assert.equal(h.page.data.saving, false);
      assert.equal(h.page.data.editingId, "");
    }
  }
});

test("a new login must reinitialize before saving and then submits only its fresh member draft", async () => {
  for (const sameAccount of [false, true]) {
    const h = harness(); await h.ready();
    h.page.setData({ editingId: "a", phone: "synthetic-old-phone", remarkName: "旧草稿" });
    h.app._loginSessionVersion++;
    if (!sameAccount) h.app.globalData.user.id = "admin-b";
    await h.page.save();
    assert.equal(h.saves.length, 0);
    h.page.onShow();
    assert.equal(h.page.data.editingId, "");
    assert.equal(h.page.data.phone, "");
    assert.equal(h.page.data.remarkName, "");
    h.page.input({ currentTarget: { dataset: { key: "phone" } }, detail: { value: "synthetic-new-phone" } });
    h.page.input({ currentTarget: { dataset: { key: "remarkName" } }, detail: { value: "新草稿" } });
    await h.page.save();
    assert.deepEqual(h.saves, [{ phone: "synthetic-new-phone", remarkName: "新草稿" }]);
  }
});

test("leaving does not cancel an already submitted member save or allow a second late submission", async () => {
  const h = harness(); await h.ready();
  h.page.setData({ phone: "synthetic-submitted-phone", remarkName: "已提交" });
  const saving = h.page.save();
  h.page.onHide();
  await saving;
  assert.deepEqual(h.saves, [{ phone: "synthetic-submitted-phone", remarkName: "已提交" }]);
  assert.equal(h.page.data.saving, false);
  assert.equal(h.page.data.phone, "");
  assert.equal(h.requests.length, 1, "completion must not reload a hidden list");
  await h.page.save();
  assert.equal(h.saves.length, 1);
});

test("missing action icons leave member drafts, selection and actions intact; hidden/session-stale errors are ignored", async () => {
  const h = harness(); await h.ready();
  const iconError = (icon) => h.page.actionIconError({ currentTarget: { dataset: { icon } } });
  h.page.selectItems({ detail: { value: ["a"] } });
  h.page.data.phone = "synthetic-draft";
  h.page.data.remarkName = "未保存";
  const before = plain(h.page.data);
  iconError("edit"); iconError("edit"); iconError("search"); iconError("delete"); iconError("unknown");
  assert.deepEqual(plain(h.page.data), { ...before, failedActionIcons: { edit: true, search: true, delete: true } });
  assert.equal(h.requests.length, 1);
  assert.equal(h.saves.length, 0);
  assert.equal(h.removals.length, 0);
  h.page.edit({ currentTarget: { dataset: { id: "a" } } });
  assert.equal(h.page.data.editingId, "a");
  assert.deepEqual(plain(h.page.data.selectedIds), ["a"]);
  h.page.batchRemove();
  assert.equal(h.modals.length, 1);
  for (const mode of ["hide", "unload", "account"]) {
    const stale = harness(); await stale.ready();
    if (mode === "hide") stale.page.onHide();
    if (mode === "unload") stale.page.onUnload();
    if (mode === "account") stale.app._loginSessionVersion++;
    const unchanged = plain(stale.page.data);
    stale.page.actionIconError({ currentTarget: { dataset: { icon: "edit" } } });
    assert.deepEqual(plain(stale.page.data), unchanged, mode);
  }
});

test("markup shows only the search status while pending/loading, with keyboard search and accessible clear/retry", () => {
  const markup = fs.readFileSync(path.join(root, "index.wxml"), "utf8");
  assert.match(markup, /confirm-type="search" bindconfirm="search"/);
  assert.match(markup, /wx:if="\{\{keyword\}\}"[^>]*catchtap="clearSearch"[^>]*aria-label="清除搜索"/);
  assert.match(markup, /bindtap="retrySearch">重试/);
  assert.match(markup, /resultKeyword \? '未找到匹配成员' : '暂无白名单成员'/);
  assert.match(markup, /<checkbox-group wx:if="\{\{items.length\}\}"/);
  const state = markup.match(/<view wx:if="\{\{searchPending \|\| loading\}\}" class="search-status">([\s\S]*?)<\/view>\s*<block wx:else>([\s\S]*?)<\/block>/);
  assert.ok(state, "both debounce and first-page requests replace the results area");
  assert.match(state[1], /src="\/assets\/icons\/search\.png"[^>]*aria-hidden="true"/);
  assert.match(state[1], /<text>搜索中<\/text>/);
  assert.doesNotMatch(markup, /结果待更新/);
  assert.match(state[2], /class="batch-row"/);
  assert.match(state[2], /<checkbox-group/);
  assert.match(state[2], /bindtap="onReachBottom"/);
  for (const binding of ["edit", "batchRemove"]) {
    assert.match(markup, new RegExp(`(?:catchtap|bindtap)="${binding}" disabled="[^"\\n]*resultsStale`));
  }
  assert.doesNotMatch(markup, /catchtap="remove"|remove-member|一键删除/);
  assert.match(markup, /bindtap="batchRemove"[^>]*><text>删除<\/text>/);
  assert.match(markup, /<checkbox [^>]*disabled="[^"\n]*resultsStale/);
});
