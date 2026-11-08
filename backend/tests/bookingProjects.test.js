const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, flush, tap, plain, confirmLatest, inputEvent } = require("./support/scheduleUI");

const pointAt = (board, time) => board.data.groups.flatMap(group => group.points).find(point => point.time === time);
const selected = board => [board.data.start, board.data.end, board.data.nextReady];
const lastToast = h => h.calls.filter(call => call[0] === "toast").at(-1)?.[1].title;

test("valid endings and selected interval interiors are white; endpoints remain yellow without relaxing availability", async () => {
  const fs = require("node:fs"), path = require("node:path");
  const css = fs.readFileSync(path.join(__dirname, "../../miniprogram/components/day-schedule/index.wxss"), "utf8");
  assert.match(css, /\.point\.possible, \.point\.within\s*\{[^}]*background:\s*#fff;/);
  assert.match(css, /\.point\.selected\s*\{[^}]*background:\s*#fff4cf;/);
  const h = setup(), board = h.board(); await flush();
  tap(board, "09:00");
  assert.equal(pointAt(board, "10:30").state, "possible");
  assert.equal(pointAt(board, "10:30").disabled, false);
  assert.equal(pointAt(board, "10:00").disabled, true);
  tap(board, "10:30");
  for (const time of ["09:30", "10:00"]) assert.equal(pointAt(board, time).state, "within");
  for (const time of ["09:00", "10:30"]) assert.equal(pointAt(board, time).state, "selected");
  assert.deepEqual(selected(board), ["09:00", "10:30", true]);
  board.detach();
});

for (const example of [
  { step: 10, minimum: 30, end: "10:00", lastStart: "09:30", tail: ["09:40", "09:50", "10:00"] },
  { step: 15, minimum: 45, end: "10:00", lastStart: "09:15", tail: ["09:45", "10:00"], unavailable: "09:30" },
  { step: 30, minimum: 90, end: "12:00", lastStart: "10:30", tail: ["11:00", "11:30", "12:00"] }
]) {
  test(`end-only points explain rejected starts and become valid ends at ${example.step}-minute precision`, async () => {
    const h = setup(); h.setNow("2026-10-30T08:00:00+08:00");
    Object.assign(h.day, { step: example.step, minDuration: example.minimum,
      ranges: [{ startTime: "09:00", endTime: example.end }] });
    const board = h.board(); await flush();
    assert.equal(pointAt(board, example.lastStart).disabled, false);
    assert.deepEqual(plain(board.data.groups[0].points.filter(p => p.state === "end-only").map(p => p.time)), example.tail);
    assert.equal(board.data.hasEndOnly, true);
    assert.match(board.data.selectionGuide, new RegExp(`至少为${example.minimum}分钟`));
    if (example.unavailable) {
      const point = pointAt(board, example.unavailable);
      assert.equal(point.disabled, true);
      assert.equal(point.state, "limited", "a free point with insufficient time on both sides is outlined but unselectable");
      tap(board, example.unavailable); assert.doesNotMatch(lastToast(h), /可作为结束/);
    }
    for (const time of example.tail) {
      const point = pointAt(board, time);
      assert.equal(point.disabled, true, "an informational tap cannot select an invalid start");
      assert.equal(point.caption, "", "end-only cells have no extra visible text");
      assert.match(point.hint, /仅可结束/);
      tap(board, time);
      assert.deepEqual(selected(board), ["", "", false]);
      assert.match(lastToast(h), /可作为结束时间/);
    }
    tap(board, example.lastStart);
    assert.equal(board.data.hasEndOnly, false);
    assert.match(board.data.selectionGuide, new RegExp(`请选择结束时间.*最早${example.end}`));
    tap(board, example.tail[0]);
    assert.deepEqual(selected(board), [example.lastStart, "", false]);
    assert.match(lastToast(h), new RegExp(`至少为${example.minimum}分钟.*${example.end}`));
    assert.equal(pointAt(board, example.end).disabled, false);
    assert.equal(pointAt(board, example.end).state, "possible");
    tap(board, example.end);
    assert.deepEqual(selected(board), [example.lastStart, example.end, true]);
    assert.equal(board.data.duration, example.minimum);
    assert.equal(pointAt(board, example.lastStart).caption, "开始");
    assert.equal(pointAt(board, example.end).caption, "结束");
    assert.ok(board.data.groups[0].points.every(point => ["", "开始", "结束"].includes(point.caption)));
    board.pickItem(inputEvent(board, [board.data.items[0].id])); board.submit();
    const modal = h.calls.filter(call => call[0] === "modal").at(-1)[1];
    assert.ok(modal.content.includes(`${example.lastStart}–${example.end}`));
    assert.equal(h.calls.filter(call => ["create", "modify", "change"].includes(call[0])).length, 0);
    board.detach();
  });
}

for (const blocked of ["closed", "busy"]) {
  test(`a ${blocked} interval's leading boundary can end a booking but its interior cannot`, async () => {
    const h = setup();
    if (blocked === "closed") h.day.closed = ["10:30", "11:00"];
    else h.day.busy = [{ startTime: "10:30", endTime: "11:30" }];
    const board = h.board(); await flush();
    assert.equal(pointAt(board, "10:30").state, "end-only");
    assert.equal(pointAt(board, "11:00").disabled, true);
    assert.notEqual(pointAt(board, "11:00").state, "end-only");
    tap(board, "10:30");
    assert.deepEqual(selected(board), ["", "", false]);
    assert.match(lastToast(h), blocked === "closed" ? /已关闭.*可作为结束/ : /已被预约.*可作为结束/);
    tap(board, "11:00"); assert.doesNotMatch(lastToast(h), /可作为结束/);
    tap(board, "09:00"); tap(board, "11:30");
    assert.deepEqual(selected(board), ["09:00", "", false]);
    assert.match(lastToast(h), blocked === "closed" ? /范围内有已关闭/ : /范围内有已被他人预约/);
    tap(board, "10:30"); assert.deepEqual(selected(board), ["09:00", "10:30", true]);
    tap(board, "11:30"); tap(board, "13:00");
    assert.deepEqual(selected(board), ["11:30", "13:00", true], "a new booking can start at the blocked interval's end");
    board.detach();
  });
}

test("end-only does not promise an endpoint in a free segment shorter than the minimum", async () => {
  const h = setup(); h.day.ranges = [{ startTime: "09:00", endTime: "10:00" }];
  const board = h.board(); await flush();
  assert.equal(board.data.hasEndOnly, false);
  assert.ok(board.data.groups[0].points.every(point => point.disabled && point.state !== "end-only"));
  tap(board, "09:00"); assert.match(lastToast(h), /不足90分钟/);
  tap(board, "10:00"); assert.match(lastToast(h), /不可作为开始/);
  board.submit(); assert.equal(h.calls.filter(call => call[0] === "modal").length, 0);
  board.detach();
});

test("20:00 is outlined when choosing a start, gray when choosing an end, and remains unselectable at a 90-minute minimum", async () => {
  const h = setup(); h.setNow("2026-10-30T08:00:00+08:00");
  h.day.ranges = [
    { startTime: "09:00", endTime: "12:00" },
    { startTime: "14:00", endTime: "17:00" },
    { startTime: "19:00", endTime: "21:00" }
  ];
  const board = h.board(); await flush();
  assert.equal(pointAt(board, "19:00").disabled, false);
  assert.equal(pointAt(board, "19:30").disabled, false);
  assert.equal(pointAt(board, "20:00").disabled, true);
  assert.equal(pointAt(board, "20:00").state, "limited");
  assert.equal(pointAt(board, "20:00").caption, "");
  assert.doesNotMatch(pointAt(board, "20:00").hint, /仅可结束/);
  for (const time of ["20:30", "21:00"]) assert.equal(pointAt(board, time).state, "end-only");
  tap(board, "20:00"); assert.match(lastToast(h), /不足90分钟/);
  assert.deepEqual(selected(board), ["", "", false]);
  tap(board, "19:00"); tap(board, "20:00");
  assert.equal(pointAt(board, "20:00").state, "");
  assert.equal(pointAt(board, "20:00").disabled, true, "the default disabled style is gray while choosing an end");
  assert.match(lastToast(h), /至少为90分钟.*20:30/);
  assert.deepEqual(selected(board), ["19:00", "", false]);
  board.resetSelection(inputEvent(board));
  assert.equal(pointAt(board, "20:00").state, "limited", "reset restores the starting-step outline");
  tap(board, "19:00");
  assert.equal(pointAt(board, "20:00").state, "");
  tap(board, "20:30"); assert.deepEqual(selected(board), ["19:00", "20:30", true]);
  assert.equal(pointAt(board, "20:00").state, "within", "a completed selection keeps the interval interior white");
  tap(board, "19:30");
  assert.equal(pointAt(board, "20:00").state, "");
  assert.equal(pointAt(board, "20:00").disabled, true);
  tap(board, "21:00");
  assert.deepEqual(selected(board), ["19:30", "21:00", true]);
  h.setNow("2026-10-30T20:30:00+08:00");
  assert.equal(pointAt(board, "20:00").disabled, true);
  assert.notEqual(pointAt(board, "20:00").state, "limited", "elapsed cells return to gray");
  tap(board, "20:00"); assert.match(lastToast(h), /已过/);
  board.detach();

  h.day.minDuration = 60;
  h.setNow("2026-10-30T08:00:00+08:00");
  const shorter = h.board(); await flush();
  assert.equal(pointAt(shorter, "20:00").disabled, false, "at a 60-minute minimum 20:00 may start");
  assert.equal(pointAt(shorter, "20:00").state, "");
  tap(shorter, "19:00"); tap(shorter, "20:00");
  assert.deepEqual(selected(shorter), ["19:00", "20:00", true], "it may also end a 60-minute booking");
  shorter.detach();
});

test("outlined minimum-length restrictions do not make closed, occupied, elapsed or project-less cells white", async () => {
  for (const scenario of ["closed", "occupied", "elapsed", "no-projects"]) {
    const h = setup(); h.setNow("2026-10-30T08:00:00+08:00");
    h.day.ranges = [{ startTime: "19:00", endTime: "21:00" }];
    if (scenario === "closed") h.day.closed = ["20:00"];
    if (scenario === "occupied") h.day.busy = [{ startTime: "20:00", endTime: "21:00" }];
    if (scenario === "elapsed") h.setNow("2026-10-30T20:30:00+08:00");
    if (scenario === "no-projects") h.day.serviceItemIds = [];
    const board = h.board(); await flush();
    assert.equal(pointAt(board, "20:00").disabled, true, scenario);
    assert.equal(pointAt(board, "20:00").state, "", scenario);
    tap(board, "20:00");
    const expected = { closed: /已关闭/, occupied: /已被预约/, elapsed: /已过/, "no-projects": /暂无可约项目/ };
    assert.match(lastToast(h), expected[scenario]);
    assert.deepEqual(selected(board), ["", "", false]);
    board.detach();
  }
});

test("the final aligned time of each precision can end a booking but cannot start one", async () => {
  for (const [step, end] of [[10, "23:50"], [15, "23:45"], [30, "23:30"]]) {
    const h = setup(); Object.assign(h.day, { step, minDuration: 90, ranges: [{ startTime: "22:00", endTime: end }] });
    const board = h.board(); await flush();
    assert.equal(pointAt(board, end).state, "end-only");
    tap(board, end); assert.match(lastToast(h), /排班在此结束/);
    assert.deepEqual(selected(board), ["", "", false]);
    tap(board, "22:00"); tap(board, end);
    assert.deepEqual(selected(board), ["22:00", end, true]);
    const toastCount = h.calls.filter(call => call[0] === "toast").length;
    tap(board, "24:00");
    assert.deepEqual(selected(board), ["22:00", end, true]);
    assert.equal(h.calls.filter(call => call[0] === "toast").length, toastCount);
    board.detach();
  }
});

test("ending choices respect their chosen start and group, and rejected clicks preserve a complete selection", async () => {
  const h = setup(); h.day.ranges = [{ startTime: "09:00", endTime: "12:00" }, { startTime: "14:00", endTime: "17:00" }];
  const board = h.board(); await flush();
  assert.equal(pointAt(board, "16:30").state, "end-only");
  tap(board, "09:00");
  assert.equal(pointAt(board, "16:30").disabled, true);
  assert.notEqual(pointAt(board, "16:30").state, "end-only");
  tap(board, "16:30"); assert.match(lastToast(h), /不可跨排班预约/);
  tap(board, "09:00"); assert.match(lastToast(h), /结束时间需晚于开始时间/);
  tap(board, "10:00"); assert.match(lastToast(h), /至少为90分钟.*10:30/);
  assert.deepEqual(selected(board), ["09:00", "", false]);
  tap(board, "10:30");
  tap(board, "11:00"); assert.match(lastToast(h), /不足90分钟.*可作为结束/);
  assert.deepEqual(selected(board), ["09:00", "10:30", true]);
  tap(board, "14:00"); tap(board, "15:30");
  assert.deepEqual(selected(board), ["14:00", "15:30", true]);
  board.resetSelection(inputEvent(board)); assert.deepEqual(selected(board), ["", "", false]);
  assert.equal(pointAt(board, "16:30").state, "end-only");
  board.detach();
});

test("end-only points expire when the last usable start expires, without reloading the page", async () => {
  const h = setup();
  h.day.ranges = [{ startTime: "09:00", endTime: "11:00" }]; h.day.closed = ["10:30"];
  h.setNow("2026-10-30T09:29:59+08:00");
  const board = h.board(); await flush();
  assert.equal(pointAt(board, "10:30").state, "end-only");
  assert.equal(pointAt(board, "09:00").disabled, false, "the current time cell remains bookable until its end");
  const reads = h.calls.filter(call => call[0] === "day").length;
  h.setNow("2026-10-30T09:30:00+08:00");
  assert.equal(board.data.hasEndOnly, false);
  assert.equal(pointAt(board, "09:00").disabled, true);
  assert.notEqual(pointAt(board, "10:30").state, "end-only");
  tap(board, "09:00"); assert.match(lastToast(h), /已过/);
  assert.equal(h.calls.filter(call => call[0] === "day").length, reads);
  board.detach(); assert.equal(h.intervals.size, 0);
});

test("pre-start edits can move to another complete group while end-only clicks preserve the existing range", async () => {
  const h = setup(); h.setNow("2026-10-30T08:00:00+08:00");
  h.day.ranges = [{ startTime: "09:00", endTime: "12:00" }, { startTime: "14:00", endTime: "17:00" }];
  const board = h.board(true); await flush();
  tap(board, "11:30"); assert.deepEqual(selected(board), ["09:00", "11:00", true]);
  assert.match(lastToast(h), /不足90分钟.*可作为结束/);
  tap(board, "14:00"); tap(board, "16:30"); board.submit(); await confirmLatest(h);
  const write = h.calls.find(call => call[0] === "modify");
  assert.equal(write[1], h.record.id);
  assert.equal(write[2].startTime, "14:00");
  assert.equal(write[2].endTime, "16:30");
  assert.equal(write[2].therapistId, undefined);
  assert.equal(write[2].date, undefined);
  board.detach();
});

test("ongoing checked-in edits keep their start, allow short-gap extensions and stop at the original end", async () => {
  const h = setup(); h.setNow("2026-10-30T09:20:00+08:00");
  h.day.busy = [{ startTime: "11:30", endTime: "13:00" }];
  const board = h.board(true); await flush();
  assert.equal(board.data.hasEndOnly, false);
  tap(board, "09:00"); assert.match(lastToast(h), /不可修改开始时间/);
  tap(board, "10:00"); assert.match(lastToast(h), /至少为90分钟/);
  assert.deepEqual(selected(board), ["09:00", "11:00", true]);
  tap(board, "10:30"); assert.deepEqual(selected(board), ["09:00", "10:30", true], "a valid shorter booking remains allowed");
  h.setNow("2026-10-30T10:45:00+08:00");
  assert.notEqual(pointAt(board, "10:30").state, "limited", "an elapsed ending is not outlined as unused time");
  tap(board, "10:30"); assert.match(lastToast(h), /晚于当前时间/);
  assert.match(board.data.selectionGuide, /开始时间09:00.*不可修改.*请选择结束时间：11:00/);
  assert.equal(pointAt(board, "11:30").disabled, false);
  assert.equal(pointAt(board, "11:30").state, "possible");
  tap(board, "11:30"); assert.deepEqual(selected(board), ["09:00", "11:30", true]);
  tap(board, "12:00"); assert.match(lastToast(h), /范围内有已被他人预约/);
  assert.deepEqual(selected(board), ["09:00", "11:30", true]);
  h.setNow("2026-10-30T11:00:00+08:00");
  tap(board, "11:30"); assert.match(lastToast(h), /已结束或状态已变化/);
  assert.equal(board.data.nextReady, false); assert.equal(board.data.hasEndOnly, false);
  board.submit(); assert.equal(h.calls.filter(call => call[0] === "modal").length, 0);
  board.detach();
});

test("informational clicks cannot act on a hidden page, another account, or staff-only schedules", async () => {
  for (const mode of ["hidden", "account", "therapist", "admin"]) {
    const h = setup();
    if (mode === "therapist") h.app.globalData.user.therapistId = h.day.therapistId;
    if (mode === "admin") h.app.globalData.user.role = "admin";
    const board = h.board(); await flush();
    if (mode === "hidden") { board.properties.visible = false; board.activate(); }
    if (mode === "account") h.app._loginSessionVersion++;
    tap(board, "13:00");
    assert.equal(h.calls.filter(call => call[0] === "toast").length, 0);
    assert.deepEqual(selected(board), ["", "", false]);
    if (mode === "admin" || mode === "therapist") {
      assert.equal(board.data.hasEndOnly, false); assert.equal(board.data.selectionGuide, "");
    }
    board.detach();
  }
});

test("customers choose an uninterrupted range; a blocked starting cell may still be an end point", async () => {
  const h = setup();
  h.day.closed = ["10:30"];
  h.day.busy = [{ startTime: "12:30", endTime: "13:00" }];
  const view = h.board(); await flush();
  view.pickItem(inputEvent(view, [view.data.items[0].id]));
  tap(view, "09:00"); tap(view, "09:30");
  assert.equal(view.data.start, "09:00"); assert.equal(view.data.end, "");
  tap(view, "11:30"); assert.equal(view.data.start, "09:00");
  tap(view, "10:30"); assert.equal(view.data.end, "10:30");
  tap(view, "12:30"); assert.equal(view.data.end, "10:30");
  tap(view, "11:00"); assert.equal(view.data.start, "11:00"); assert.equal(view.data.end, "");
  tap(view, "12:30"); view.submit(); await confirmLatest(h);
  assert.equal(h.calls.find(call => call[0] === "create")[1].startTime, "11:00");
  assert.equal(h.calls.find(call => call[0] === "create")[1].endTime, "12:30");
  view.detach();
});

test("the same day form reloads projects and intervals, preserving the note when the chosen project disappears", async () => {
  const h = setup(), editor = h.board(); await flush();
  editor.pickItem(inputEvent(editor, [editor.data.items[0].id]));
  tap(editor, "09:00"); tap(editor, "10:30");
  assert.deepEqual(plain(editor.data.items.map(item => item.name)), ["项目一"]);
  editor.inputNote(inputEvent(editor, "保留"));
  h.day.serviceItemIds = ["q"];
  await editor.load();
  assert.deepEqual(plain(editor.data.items.map(item => item.name)), ["项目二"]);
  assert.equal(editor.data.itemIndex, -1); assert.equal(editor.data.note, "保留");
  h.day.busy = [{ startTime: "10:00", endTime: "11:00" }]; await editor.load();
  assert.equal(editor.data.nextReady, false);
  await editor.submit(); assert.equal(h.calls.filter(c => c[0] === "create").length, 0);
  editor.detach();
});

test("current-cell expiry, resting breaks and checked-in original start are evaluated with Shanghai time", async () => {
  const h = setup();
  h.day.step = 15; h.day.minDuration = 45;
  h.day.ranges = [{ startTime: "09:00", endTime: "10:00" }, { startTime: "10:15", endTime: "12:00" }];
  const board = h.board(); await flush();
  tap(board, "09:00"); tap(board, "10:15"); assert.equal(board.data.end, "");
  tap(board, "09:45"); assert.equal(board.data.duration, 45);
  h.setNow("2026-10-30T09:15:00+08:00"); assert.equal(board.data.start, "");
  board.detach(); assert.equal(h.intervals.size, 0);
  h.day.ranges = [{ startTime: "09:00", endTime: "12:00" }];
  h.setNow("2026-10-30T10:55:00+08:00");
  const edit = h.board(true); await flush();
  assert.equal(edit.data.fixed, "09:00"); tap(edit, "10:45"); assert.equal(edit.data.end, "11:00");
  tap(edit, "11:15"); assert.equal(edit.data.end, "11:15");
  h.setNow("2026-10-30T11:00:00+08:00"); assert.equal(edit.data.stopped, true); assert.equal(edit.data.nextReady, false);
});

test("administrator can close the current free cell and reopen a closed cell; an occupied or ended cell is immutable", async () => {
  const h = setup(); h.app.globalData.user.role = "admin";
  h.setNow("2026-10-30T09:31:00+08:00");
  h.day.closed = ["10:30"]; h.day.busy = [{ startTime: "11:00", endTime: "12:30" }];
  const board = h.board(); await flush();
  assert.equal(board.data.canCloseChosen, false); assert.equal(board.data.canOpenChosen, false);
  for (const time of ["09:00", "09:30", "10:30", "11:30", "13:00"]) tap(board, time);
  assert.deepEqual(plain(board.data.chosen), ["09:30", "10:30"]);
  assert.equal(board.data.canCloseChosen, true); assert.equal(board.data.canOpenChosen, true);
  await board.applyDay({ currentTarget: { dataset: { action: "close", viewVersion: board.data.viewVersion } } });
  assert.deepEqual(plain(h.calls.find(c => c[0] === "change")[2]), { date: "2026-10-30", expectedStep: 30, close: ["09:30"] });
  assert.equal(board.data.canCloseChosen, false); assert.equal(board.data.canOpenChosen, false);
  tap(board, "10:30");
  assert.equal(board.data.canCloseChosen, false); assert.equal(board.data.canOpenChosen, true);
  await board.applyDay({ currentTarget: { dataset: { action: "open", viewVersion: board.data.viewVersion } } });
  assert.deepEqual(plain(h.calls.filter(c => c[0] === "change").at(-1)[2].open), ["10:30"]);
});

test("guests can browse and choose, then see a login prompt; assigned staff cannot fetch another schedule", async () => {
  const h = setup(); h.app.globalData.user = null; h.app.globalData.token = "";
  const guest = h.board(); await flush();
  guest.pickItem(inputEvent(guest, [guest.data.items[0].id])); tap(guest, "09:00"); tap(guest, "10:30"); guest.submit();
  assert.equal(h.calls.filter(c => c[0] === "modal").length, 1);
  h.app.globalData.user = { id: "staff", therapistId: "other" };
  const before = h.calls.filter(c => c[0] === "day").length;
  const staff = h.board(); await flush(); assert.match(staff.data.error, /无权/);
  assert.equal(h.calls.filter(c => c[0] === "day").length, before);
});

test("staff day cards open the matching role detail and clear private rows when hidden", async () => {
  const h = setup(); h.app.globalData.user.role = "admin"; h.day.appointments = [h.record];
  const board = h.board(); await flush(); assert.equal(board.data.appointments[0].id, h.record.id);
  board.openAppointment({ currentTarget: { dataset: { id: h.record.id } } });
  assert.match(h.calls.find(c => c[0] === "navigate")[1].url, /admin\/slot-appointment\/index\?appointmentId=a$/);
  board.properties.visible = false; board.activate();
  assert.equal(board.data.appointments.length, 0); assert.equal(board.data.day, null); assert.equal(h.intervals.size, 0);

  const staff = setup(); staff.app.globalData.user.therapistId = staff.day.therapistId;
  staff.day.appointments = [staff.record];
  const staffBoard = staff.board(); await flush();
  staffBoard.openAppointment({ currentTarget: { dataset: { id: staff.record.id } } });
  assert.match(staff.calls.find(c => c[0] === "navigate")[1].url, /therapist\/appointment-detail\/index\?appointmentId=a$/);
});

test("no eligible project makes an otherwise long enough opening unavailable", async () => {
  const h = setup(); h.day.serviceItemIds = [];
  const board = h.board(); await flush();
  tap(board, "09:00"); tap(board, "10:30");
  assert.equal(board.data.start, ""); assert.equal(board.data.nextReady, false);
  assert.equal(board.data.hasEndOnly, false);
  assert.ok(board.data.groups[0].points.every(point => point.disabled && point.state !== "end-only"));
  assert.equal(lastToast(h), "当天暂无可约项目");
});
