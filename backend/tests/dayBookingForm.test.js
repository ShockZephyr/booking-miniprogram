const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setup, flush, tap, plain, confirmLatest, inputEvent } = require("./support/scheduleUI");

test("new bookings never preselect a project, including one option, reloads and date changes", async () => {
  for (const ids of [["p"], ["p", "q"]]) {
    const h = setup(); h.day.serviceItemIds = ids;
    const board = h.board(); await flush();
    assert.equal(board.data.itemIndex, -1);
    tap(board, "09:00"); tap(board, "10:30"); board.submit();
    assert.match(board.data.formHint, /请选择可约项目/);
    assert.equal(h.calls.filter(c => c[0] === "modal").length, 0);
    await board.load(); assert.equal(board.data.itemIndex, -1);
    h.day.date = "2026-10-31";
    board.properties.target = { ...board.properties.target, date: h.day.date };
    board.activate(); await flush(); assert.equal(board.data.itemIndex, -1);
    board.pickItem(inputEvent(board, [board.data.items[0].id]));
    assert.equal(board.data.items[board.data.itemIndex].id, "p");
    await board.load(); assert.equal(board.data.items[board.data.itemIndex].id, "p");
    tap(board, "09:00"); tap(board, "10:30"); board.submit(); await confirmLatest(h);
    assert.equal(h.calls.find(c => c[0] === "create")[1].serviceItemIds.join(), "p");
    board.detach();
  }
});

test("editing keeps the original eligible project but never substitutes an unavailable original", async () => {
  const h = setup(), board = h.board(true); await flush();
  assert.equal(board.data.items[board.data.itemIndex].id, h.record.serviceItemId);
  await board.load(); assert.equal(board.data.items[board.data.itemIndex].id, h.record.serviceItemId);
  h.day.serviceItemIds = ["q"]; await board.load();
  assert.equal(board.data.itemIndex, -1);
  board.submit(); assert.equal(h.calls.filter(c => c[0] === "modal").length, 0);
  board.detach();
});

test("project and note can precede time selection; cancellation keeps input and confirmation writes once", async () => {
  const h = setup(); h.day.serviceItemIds = ["p", "q"];
  const board = h.board(); await flush();
  board.pickItem(inputEvent(board, [board.data.items[1].id]));
  board.inputNote(inputEvent(board, "希望轻柔一些"));
  board.submit(); assert.equal(h.calls.filter(c => c[0] === "modal").length, 0);
  assert.match(board.data.formHint, /请选择开始/);
  tap(board, "09:00"); assert.match(board.data.formHint, /请选择结束/);
  tap(board, "10:30"); board.submit(); await confirmLatest(h, false);
  assert.equal(board.data.confirming, false);
  assert.equal(board.data.note, "希望轻柔一些"); assert.equal(board.data.items[board.data.itemIndex].id, "q");
  board.submit();
  assert.equal(h.calls.filter(c => c[0] === "modal").at(-1)[1].content,
    "日期：2026-10-30；时段：09:00–10:30；芳疗师：芳疗师；项目：项目二");
  await confirmLatest(h);
  assert.equal(h.calls.filter(c => c[0] === "create").length, 1);
  assert.equal(h.calls.find(c => c[0] === "create")[1].note, "希望轻柔一些");
  assert.equal(h.calls.filter(c => c[0] === "navigate").length, 0);
  board.detach();
});

test("same-day reselection retains input, while switching dates clears time and only retains eligible projects", async () => {
  const h = setup(); h.day.serviceItemIds = ["p", "q"];
  const board = h.board(); await flush();
  board.pickItem(inputEvent(board, [board.data.items[1].id])); board.inputNote(inputEvent(board, "保留备注"));
  tap(board, "09:00"); tap(board, "10:30"); board.resetSelection(inputEvent(board));
  assert.equal(board.data.itemIndex, 1); assert.equal(board.data.note, "保留备注");
  tap(board, "10:00"); tap(board, "12:00");
  h.day.date = "2026-10-31";
  board.properties.target = { ...board.properties.target, date: h.day.date }; board.activate(); await flush();
  assert.deepEqual([board.data.start, board.data.end], ["", ""]);
  assert.equal(board.data.items[board.data.itemIndex].id, "q"); assert.equal(board.data.note, "保留备注");
  h.day.date = "2026-11-01"; h.day.serviceItemIds = ["p"];
  board.properties.target = { ...board.properties.target, date: h.day.date }; board.activate(); await flush();
  assert.equal(board.data.itemIndex, -1); assert.match(board.data.notice, /当天不可约/);
  assert.equal(board.data.note, "保留备注");
  tap(board, "09:00"); tap(board, "10:30"); board.submit();
  assert.equal(h.calls.filter(c => c[0] === "modal").length, 0);
  assert.match(board.data.formHint, /请选择可约项目/);
  board.pickItem(inputEvent(board, [board.data.items[0].id])); board.submit(); await confirmLatest(h);
  assert.equal(h.calls.find(c => c[0] === "create")[1].date, "2026-11-01");
  board.detach();
});

test("a failed catalog reload preserves the draft and retries the original day without a false empty result", async () => {
  const h = setup(), board = h.board(); await flush();
  board.pickItem(inputEvent(board, [board.data.items[0].id]));
  tap(board, "09:00"); tap(board, "10:30"); board.inputNote(inputEvent(board, "恢复后还在"));
  const catalog = h.deps.user.serviceItems;
  h.deps.user.serviceItems = async () => { throw new Error("项目加载失败"); };
  await board.load(); assert.equal(board.data.error, "项目加载失败"); assert.equal(board.data.note, "恢复后还在");
  board.submit(); assert.equal(h.calls.filter(c => c[0] === "modal").length, 0);
  h.deps.user.serviceItems = catalog; await board.load();
  assert.equal(board.data.error, ""); assert.equal(board.data.note, "恢复后还在");
  assert.deepEqual([board.data.start, board.data.end, board.data.items[board.data.itemIndex].id], ["09:00", "10:30", "p"]);
  board.detach();
});

for (const change of ["reload", "date", "clock", "account", "hide", "membership"]) {
  test(`confirmation cannot submit stale inputs after ${change}`, async () => {
    const h = setup(), board = h.board(); await flush();
    board.pickItem(inputEvent(board, [board.data.items[0].id]));
    tap(board, "09:00"); tap(board, "10:30"); board.submit();
    if (change === "reload") await board.load();
    if (change === "date") {
      h.day.date = "2026-10-31"; board.properties.target = { ...board.properties.target, date: h.day.date };
      board.activate(); await flush();
    }
    if (change === "clock") h.setNow("2026-10-30T09:30:00+08:00");
    if (change === "account") h.app._loginSessionVersion++;
    if (change === "hide") { board.properties.visible = false; board.activate(); }
    if (change === "membership") h.app.globalData.user.effectiveRole = "non_member";
    await confirmLatest(h);
    assert.equal(h.calls.filter(c => ["create", "modify"].includes(c[0])).length, 0);
    assert.equal(h.app._scheduleWrite, undefined);
    board.detach();
  });
}

test("date controls and form input are locked only for confirmation or a pending write", async () => {
  const h = setup(), board = h.board(); await flush();
  board.pickItem(inputEvent(board, [board.data.items[0].id]));
  const page = h.page("pages/schedule-day"); page.onLoad({ therapistId: h.day.therapistId, date: h.day.date });
  page.data.visible = true; page.data.last = "2026-11-05";
  board.triggerEvent = (name, detail) => { if (name === "busy") page.bookingState({ detail }); };
  tap(board, "09:00"); tap(board, "10:30"); board.submit();
  page.changeDate({ detail: { date: "2026-11-01" } }); page.openCalendar();
  assert.equal(page.data.target.date, h.day.date); assert.equal(page.data.calendarVisible, false);
  board.inputNote(inputEvent(board, "不应覆盖")); board.resetSelection(inputEvent(board));
  assert.equal(board.data.note, ""); assert.equal(board.data.start, "09:00");
  await confirmLatest(h, false); assert.equal(page.data.bookingBusy, false);
  page.changeDate({ detail: { date: "2026-11-01" } }); assert.equal(page.data.target.date, "2026-11-01");
  board.detach();
});

test("guest login resumes only the explicitly confirmed draft and rechecks occupied time", async () => {
  const h = setup(); h.app.globalData.user = null; h.app.globalData.token = "";
  const board = h.board(); await flush();
  board.pickItem(inputEvent(board, [board.data.items[0].id]));
  tap(board, "09:00"); tap(board, "10:30"); board.inputNote(inputEvent(board, "登录后保留")); board.submit();
  assert.match(h.calls.filter(c => c[0] === "modal").at(-1)[1].title, /请先登录/);
  await confirmLatest(h);
  assert.equal(h.calls.at(-1)[0], "tab"); assert.equal(h.app._loginReturn.bookingDraft.note, "登录后保留");
  board.detach();
  h.app.globalData = { token: "new-session", user: { id: "new", role: "user", effectiveRole: "member" } };
  h.app._loginSessionVersion++;
  h.loginReturn().resume();
  h.day.busy = [{ startTime: "09:00", endTime: "10:30" }];
  const resumed = h.board(); await flush();
  assert.equal(h.app._bookingResume, undefined, "a resume is consumed only once");
  assert.equal(resumed.data.note, "登录后保留"); assert.equal(resumed.data.items[resumed.data.itemIndex].id, "p");
  assert.equal(resumed.data.start, ""); assert.equal(resumed.data.nextReady, false);
  resumed.submit(); assert.equal(h.calls.filter(c => c[0] === "create").length, 0);
  resumed.detach();
  const unrelated = h.board(); await flush(); assert.equal(unrelated.data.note, ""); unrelated.detach();
});

test("an available guest draft resumes with the same date, interval, project and limited note", async () => {
  const h = setup(); h.app.globalData.user = null; h.app.globalData.token = "";
  const guest = h.board(); await flush();
  guest.pickItem(inputEvent(guest, [guest.data.items[0].id]));
  tap(guest, "09:00"); tap(guest, "10:30"); guest.inputNote(inputEvent(guest, "备".repeat(300)));
  guest.submit(); await confirmLatest(h); guest.detach();
  h.app.globalData = { token: "signed-in", user: { id: "member", role: "user", effectiveRole: "member" } };
  h.app._loginSessionVersion++; h.loginReturn().resume();
  const board = h.board(); await flush();
  assert.deepEqual([board.data.day.date, board.data.start, board.data.end, board.data.nextReady], [h.day.date, "09:00", "10:30", true]);
  assert.equal(board.data.note.length, 250);
  board.submit(); await confirmLatest(h);
  assert.deepEqual(h.calls.find(c => c[0] === "create")[1], {
    date: h.day.date, therapistId: h.day.therapistId, startTime: "09:00", endTime: "10:30", serviceItemIds: ["p"], note: "备".repeat(250)
  });
  board.detach();
});

test("real session setters clear private resume and operation state while profile refresh preserves it", () => {
  let app;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../miniprogram/app.js"), "utf8"), {
    App: value => { app = value; }, require: () => ({}), wx: { setStorageSync() {}, removeStorageSync() {} }
  });
  const member = { id: "member", role: "user" };
  app.setSession("test-token", member);
  app._bookingResume = { note: "private" }; app._scheduleWrite = { state: "pending" };
  app.setSession("test-token", member, { preserveLoginSession: true });
  assert.equal(app._bookingResume.note, "private"); assert.equal(app._scheduleWrite.state, "pending");
  app.setSession("next-token", { id: "next", role: "user" });
  assert.equal(app._bookingResume, undefined); assert.equal(app._scheduleWrite, undefined);
  app._bookingResume = {}; app._scheduleWrite = {}; app.clearSession();
  assert.equal(app._bookingResume, undefined); assert.equal(app._scheduleWrite, undefined);
});

test("cancelled login, account changes and staff identities do not inherit or submit guest inputs", async () => {
  for (const mode of ["cancel", "admin", "therapist", "expired"]) {
    const h = setup(); h.app.globalData.user = null; h.app.globalData.token = "";
    const board = h.board(); await flush();
    board.pickItem(inputEvent(board, [board.data.items[0].id]));
    tap(board, "09:00"); tap(board, "10:30"); board.inputNote(inputEvent(board, "临时草稿")); board.submit();
    await confirmLatest(h, mode !== "cancel"); board.detach();
    h.app.globalData = { token: "next", user: { id: "next", role: mode === "admin" ? "admin" : "user", effectiveRole: "member" } };
    if (mode === "therapist") h.app.globalData.user.therapistId = h.day.therapistId;
    h.app._loginSessionVersion++;
    if (mode === "expired") h.setNow("2026-10-30T09:23:00+08:00");
    h.loginReturn().resume();
    const next = h.board(); await flush();
    assert.equal(next.data.note, ""); next.submit();
    assert.equal(h.calls.filter(c => c[0] === "create").length, 0);
    next.detach();
  }
});

test("one-page template retains native controls and has no legacy confirmation route or dashed legend", () => {
  const root = path.join(__dirname, "../../miniprogram");
  const template = fs.readFileSync(path.join(root, "components/day-schedule/index.wxml"), "utf8");
  assert.match(template, /checkbox-group[^>]*bindchange="pickItem"/);
  assert.match(template, /disabled="\{\{confirming \|\| submitting \|\| saved \|\| unknown\}\}"/);
  assert.doesNotMatch(template, /<radio(?:-group)?\b/);
  assert.match(template, /textarea[^>]*maxlength="250"[^>]*bindinput="inputNote"/);
  assert.match(template, /保存修改.*提交预约/);
  assert.doesNotMatch(template, /下一步|虚线框时间点仅可作为结束/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8")).pages.includes("pages/appointment-detail/index"), true);
  const styles = fs.readFileSync(path.join(root, "components/day-schedule/index.wxss"), "utf8");
  assert.match(styles, /\.customer-content[^}]*padding-bottom:[^}]*safe-area-inset-bottom/);
  assert.match(styles, /\.booking-note[^}]*width: 100%/);
});
test("old customer controls cannot modify the newly rendered day", async () => {
  const h = setup(), board = h.board();
  await flush();
  const old = inputEvent(board, "0");
  old.currentTarget.dataset.time = "09:00";
  h.day.date = "2026-10-31";
  h.day.serviceItemIds = ["q"];
  board.properties.target = { ...board.properties.target, date: h.day.date };
  board.activate(); await flush();
  board.tapPoint(old); board.pickItem(old); board.inputNote(old);
  assert.deepEqual([board.data.start, board.data.itemIndex, board.data.note], ["", -1, ""]);
  tap(board, "09:00"); board.pickItem(inputEvent(board, [board.data.items[0].id])); board.inputNote(inputEvent(board, "新草稿"));
  board.resetSelection(old);
  assert.deepEqual([board.data.start, board.data.items[board.data.itemIndex].id, board.data.note], ["09:00", "q", "新草稿"]);
  board.detach();
});
