const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setup, tap, flush, plain, confirmLatest, inputEvent } = require("./support/scheduleUI");
const root = path.join(__dirname, "../../miniprogram");

async function editorFor(h, editing) {
  const board = h.board(editing); await flush();
  h.stack.push({ route: "pages/schedule-day/index" });
  if (!editing) { board.pickItem(inputEvent(board, [board.data.items[0].id])); tap(board, "09:00"); tap(board, "10:30"); }
  return board;
}
async function submit(h, board) { board.submit(); return confirmLatest(h); }

test("editing confirms on the same page and returns once to the originating filtered list", async () => {
  const h = setup(), list = { route: "pages/my-appointments/index", active: "all", filters: ["p"] };
  h.stack.push(list);
  const board = await editorFor(h, true);
  board.inputNote(inputEvent(board, "更新备注"));
  board.submit(); board.submit();
  assert.equal(h.calls.filter(c => c[0] === "modal").length, 1);
  assert.equal(h.calls.find(c => c[0] === "modal")[1].content,
    "日期：2026-10-30；时段：09:00–11:00；芳疗师：芳疗师；项目：项目一");
  assert.equal(h.calls.filter(c => c[0] === "navigate").length, 0);
  await confirmLatest(h); board.submit();
  assert.equal(board.data.saved, true);
  assert.deepEqual(h.calls.find(c => c[0] === "modify"), ["modify", h.record.id,
    { startTime: "09:00", endTime: "11:00", serviceItemIds: ["p"], note: "更新备注", version: 2 }]);
  h.runTimers(); assert.equal(h.calls.filter(c => c[0] === "back").length, 1);
  assert.equal(h.calls.find(c => c[0] === "back")[1].delta, 1);
  assert.deepEqual(list.filters, ["p"]); assert.equal(list.active, "all"); board.detach();
});

test("a failed return retries only navigation, while new bookings use the pending list", async () => {
  const h = setup(), board = await editorFor(h, false);
  await submit(h, board);
  h.wx.redirectTo = options => { h.calls.push(["redirect", options]); options.fail(); };
  h.runTimers(); board.submit();
  assert.equal(h.calls.filter(c => c[0] === "create").length, 1);
  assert.deepEqual(h.calls.find(c => c[0] === "create")[1], { startTime: "09:00", endTime: "10:30", serviceItemIds: ["p"], note: "", therapistId: h.day.therapistId, date: h.day.date });
  assert.equal(h.calls.filter(c => c[0] === "redirect").length, 2);
  assert.equal(h.calls.find(c => c[0] === "redirect")[1].url, "/pages/my-appointments/index?status=pending"); board.detach();
});

test("a version conflict refreshes the original appointment but requires another confirmation", async () => {
  const h = setup(), board = await editorFor(h, true);
  board.inputNote(inputEvent(board, "保留输入"));
  h.deps.appointment.modify = async () => { h.record.version++; throw Object.assign(new Error("版本已变化"), { statusCode: 409 }); };
  await submit(h, board);
  assert.equal(board.data.saved, false); assert.equal(board.data.note, "保留输入");
  assert.equal(board.data.nextReady, true); assert.match(board.data.notice, /原预约已更新/);
  h.deps.appointment.modify = async (_id, payload) => h.calls.push(["retry", plain(payload)]);
  await submit(h, board); assert.equal(h.calls.find(c => c[0] === "retry")[1].version, 3); board.detach();
});

test("leaving or switching sessions after save cannot navigate from the stale page", async () => {
  for (const action of ["exit", "switch", "hide"]) {
    const h = setup(), board = await editorFor(h, true); await submit(h, board);
    if (action === "exit") board.detach();
    else if (action === "switch") { h.app._loginSessionVersion++; await board.load(); }
    else { board.properties.visible = false; board.activate(); }
    h.runTimers(); assert.equal(h.calls.filter(c => ["back", "redirect"].includes(c[0])).length, 0);
    if (action === "switch") assert.equal(board.data.saved, false);
    board.detach();
  }
});

test("a taken interval refreshes in place without losing the note and still-available project", async () => {
  const h = setup(); h.day.serviceItemIds = ["p", "q"];
  const board = await editorFor(h, false);
  board.pickItem(inputEvent(board, [board.data.items[1].id])); board.inputNote(inputEvent(board, "同一流程的备注"));
  h.deps.appointment.create = async () => {
    h.day.busy = [{ startTime: "09:00", endTime: "10:30" }];
    throw Object.assign(new Error("该时段已被预约"), { statusCode: 409 });
  };
  await submit(h, board); assert.equal(board.data.nextReady, false);
  assert.equal(board.data.note, "同一流程的备注"); assert.equal(board.data.items[board.data.itemIndex].id, "q");
  tap(board, "10:30"); tap(board, "12:00"); assert.equal(board.data.nextReady, true);
  h.day.serviceItemIds = ["p"]; await board.load();
  assert.equal(board.data.itemIndex, -1); assert.equal(board.data.note, "同一流程的备注");
  assert.match(board.data.notice, /原选项目当天不可约/);
  h.app._loginSessionVersion++; await board.load();
  assert.equal(board.data.note, ""); assert.equal(board.data.itemIndex, -1); board.detach();
});

test("unknown create and edit results offer verification without repeating the write", async () => {
  for (const editing of [false, true]) {
    const h = setup(); let writes = 0;
    const board = await editorFor(h, editing);
    h.deps.appointment[editing ? "modify" : "create"] = async () => { writes++; throw Object.assign(new Error("网络连接失败"), { code: "NETWORK_ERROR" }); };
    await submit(h, board); assert.equal(writes, 1); assert.equal(board.data.unknown, true);
    board.properties.visible = false; board.activate(); board.properties.visible = true; board.activate(); await flush();
    assert.equal(board.data.unknown, true);
    h.wx.redirectTo = options => { h.calls.push(["review", options.url]); options.fail(); };
    board.submit(); board.submit(); assert.equal(writes, 1);
    assert.equal(h.calls.at(-2)[1], "/pages/my-appointments/index?status=all");
    assert.doesNotMatch(h.calls.at(-1)[1].title, /已保存|成功/); board.detach();
  }
});

test("leaving a pending submission cannot reopen a second write or replay an unknown result", async () => {
  const h = setup(), board = await editorFor(h, false); let reject, writes = 0;
  h.deps.appointment.create = () => { writes++; return new Promise((_resolve, fail) => { reject = fail; }); };
  board.submit(); const pending = confirmLatest(h); board.detach();
  const next = await editorFor(h, false); next.submit();
  assert.equal(next.data.submitting, true); assert.equal(writes, 1);
  reject({ statusCode: 502 }); await pending;
  h.setNow("2026-10-30T09:12:01+08:00");
  assert.equal(next.data.unknown, true); next.submit();
  assert.equal(writes, 1); assert.equal(h.calls.at(-1)[0], "redirect"); next.detach();
});

for (const editing of [false, true]) {
  for (const target of ["same-day", "other-day", "other-therapist"]) {
    test(`successful ${editing ? "edit" : "create"} left before navigation does not lock a new ${target} booking`, async () => {
      const h = setup(), original = await editorFor(h, editing);
      await submit(h, original); assert.equal(original.data.saved, true);
      original.detach();
      if (target === "other-day") h.day.date = "2026-10-31";
      if (target === "other-therapist") h.day.therapistId = "10000000-0000-4000-8000-000000000002";
      const next = await editorFor(h, false);
      assert.equal(next.data.saved, false); assert.equal(next.bookingLocked(), false);
      next.inputNote(inputEvent(next, "新的预约"));
      assert.equal(next.data.note, "新的预约"); assert.equal(next.data.nextReady, true);
      h.runTimers(); assert.equal(h.calls.filter(c => ["redirect", "back"].includes(c[0])).length, 0);
      await submit(h, next);
      const writes = h.calls.filter(c => ["create", "modify"].includes(c[0]));
      assert.equal(writes.length, 2); assert.equal(writes[1][1].date, h.day.date);
      assert.equal(writes[1][1].therapistId, h.day.therapistId); assert.equal(writes[1][1].note, "新的预约"); next.detach();
    });
  }
}

test("pending writes still block a different target, but late confirmed success releases the new form without navigation", async () => {
  const h = setup(), original = await editorFor(h, false); let resolve, writes = 0;
  h.deps.appointment.create = () => { writes++; return new Promise(done => { resolve = done; }); };
  original.submit(); const pending = confirmLatest(h); original.detach();
  h.day.date = "2026-10-31"; h.day.therapistId = "10000000-0000-4000-8000-000000000002";
  const next = h.board(); await flush();
  next.pickItem(inputEvent(next, ["p"])); tap(next, "09:00"); next.inputNote(inputEvent(next, "不能先写")); next.submit();
  assert.equal(next.data.submitting, true); assert.equal(next.bookingLocked(), true);
  assert.equal(next.data.note, ""); assert.equal(next.data.start, ""); assert.equal(writes, 1);
  const toasts = h.calls.filter(c => c[0] === "toast").length;
  resolve({}); await pending; h.setNow("2026-10-30T09:12:01+08:00"); h.runTimers();
  assert.equal(next.bookingLocked(), false); assert.equal(next.data.saved, false); assert.equal(next.data.submitting, false);
  assert.equal(h.calls.filter(c => c[0] === "toast").length, toasts);
  assert.equal(h.calls.filter(c => ["redirect", "back"].includes(c[0])).length, 0);
  h.deps.appointment.create = async () => { writes++; };
  next.pickItem(inputEvent(next, ["p"])); tap(next, "09:00"); tap(next, "10:30");
  await submit(h, next); assert.equal(writes, 2); next.detach();
});

test("an unknown outcome blocks other therapists and dates until the verification navigation succeeds", async () => {
  const h = setup(), original = await editorFor(h, false); let reject, writes = 0;
  h.deps.appointment.create = () => { writes++; return new Promise((_yes, no) => { reject = no; }); };
  original.submit(); const pending = confirmLatest(h); original.detach();
  h.day.date = "2026-10-31"; h.day.therapistId = "10000000-0000-4000-8000-000000000002";
  const next = h.board(); await flush();
  reject({ code: "NETWORK_ERROR" }); await pending; h.setNow("2026-10-30T09:12:01+08:00");
  assert.equal(next.data.unknown, true); assert.equal(next.bookingLocked(), true);
  next.pickItem(inputEvent(next, ["p"])); next.inputNote(inputEvent(next, "不可提交")); tap(next, "09:00");
  assert.equal(next.data.selectedItemIds.length, 0); assert.equal(next.data.note, ""); assert.equal(next.data.start, "");
  next.submit(); const failed = h.calls.filter(c => c[0] === "redirect").at(-1)[1]; failed.fail();
  assert.equal(next.bookingLocked(), true); next.submit();
  const verified = h.calls.filter(c => c[0] === "redirect").at(-1)[1];
  assert.equal(verified.url, "/pages/my-appointments/index?status=all");
  assert.equal(writes, 1); verified.success(); next.detach();
  const fresh = await editorFor(h, false); assert.equal(fresh.bookingLocked(), false); fresh.detach();
});

test("saved original forms retain their own receipt across reloads, other successful bookings and failed navigation", async () => {
  const h = setup(), original = await editorFor(h, true); await submit(h, original);
  original.properties.visible = false; original.activate();
  const next = await editorFor(h, false); await submit(h, next); next.detach();
  original.properties.visible = true; original.activate(); await flush();
  assert.equal(original.data.saved, true); assert.equal(original.bookingLocked(), true);
  h.wx.redirectTo = options => { h.calls.push(["redirect", options]); options.fail(); };
  original.submit(); original.submit();
  assert.equal(h.calls.filter(c => c[0] === "modify").length, 1);
  assert.equal(h.calls.filter(c => c[0] === "create").length, 1);
  assert.equal(original.data.saved, true); original.detach();
});

test("old-session successful completion cannot clear a new session's pending submission", async () => {
  const h = setup(), original = await editorFor(h, false); let resolveOld, resolveNew;
  h.deps.appointment.create = () => new Promise(resolve => { resolveOld = resolve; });
  original.submit(); const old = confirmLatest(h); original.detach();
  h.app._loginSessionVersion++;
  h.app.globalData.token = "new-session";
  const next = await editorFor(h, false);
  h.deps.appointment.create = () => new Promise(resolve => { resolveNew = resolve; });
  next.submit(); const current = confirmLatest(h), write = h.app._scheduleWrite;
  resolveOld({}); await old; h.setNow("2026-10-30T09:12:01+08:00");
  assert.equal(h.app._scheduleWrite, write); assert.equal(next.data.submitting, true); assert.equal(next.bookingLocked(), true);
  resolveNew({}); await current; assert.equal(next.data.saved, true); next.detach();
});

test("default card actions keep a separate row and every list card retains a note fallback", () => {
  const template = fs.readFileSync(path.join(root, "components/appointment-card/index.wxml"), "utf8");
  assert.match(template, /wx:if="{{!detail}}" class="note">备注：{{noteSummary \|\| '暂无备注'}}/);
  assert.equal((template.match(/class="note"/g) || []).length, 1);
  const css = fs.readFileSync(path.join(root, "components/appointment-card/index.wxss"), "utf8");
  assert.match(css, /\.detail-main \{[^}]*grid-row: 2;/s);
  assert.match(css, /\.compact-actions \{[^}]*grid-column: 1 \/ -1;[^}]*grid-row: 3;/s);
  assert.match(template, /data-type="checkIn" catchtap="action"/);
});
