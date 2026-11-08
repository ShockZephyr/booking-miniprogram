const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setup, flush, plain, tap } = require("./support/scheduleUI");

const eventFor = (board, dataset = {}, detail = {}) => ({
  currentTarget: { dataset: { viewVersion: board.data.viewVersion, ...dataset } }, detail
});
const closeAll = board => board.applyDay(eventFor(board, { action: "closeAll" }));
const openAll = board => board.applyDay(eventFor(board, { action: "openAll" }));
const expectedGrid = day => ({ step: day.step, ranges: plain(day.ranges) });
const latestModal = h => h.calls.filter(call => call[0] === "modal").at(-1)[1];
const writes = h => h.calls.filter(call => call[0] === "change");
function adminSetup(autoConfirm = true) {
  const h = setup();
  h.app.globalData.user.role = "admin";
  if (autoConfirm) {
    const showModal = h.wx.showModal;
    h.wx.showModal = options => { showModal(options); options.success({ confirm: true }); };
  }
  return h;
}

test("day project select-all changes only the draft and preserves individual choices until an explicit save", async () => {
  const h = adminSetup();
  h.deps.schedules.changeDay = async (id, payload) => {
    h.calls.push(["change", id, plain(payload)]);
    h.day.serviceItemIds = [...payload.serviceItemIds];
  };
  const board = h.board(); await flush();
  board.allProjects(eventFor(board)); board.allProjects(eventFor(board));
  assert.deepEqual(plain(board.data.projectIds), ["p", "q"]);
  assert.ok(board.data.projects.every(item => item.checked));
  board.selectProjects(eventFor(board, {}, { value: ["q"] }));
  assert.deepEqual(plain(board.data.projects.map(item => item.checked)), [false, true]);
  board.allProjects(eventFor(board));
  assert.ok(board.data.projects.every(item => item.checked));
  assert.equal(writes(h).length, 0);
  assert.deepEqual(plain(h.day.serviceItemIds), ["p"]);
  await board.applyDay(eventFor(board, { action: "projects" }));
  assert.deepEqual(writes(h)[0].slice(1), [h.day.therapistId, { date: h.day.date, serviceItemIds: ["p", "q"] }]);
  assert.deepEqual(plain(board.data.projectIds), ["p", "q"]);
  board.detach();
});

test("day project select-all ignores busy, hidden, detached, empty and non-admin views", async () => {
  for (const boundary of ["saving", "confirmingDay", "loading", "hidden", "detached", "empty", "customer", "therapist"]) {
    const h = adminSetup(), board = h.board(); await flush();
    const event = eventFor(board);
    if (["saving", "confirmingDay", "loading"].includes(boundary)) board.data[boundary] = true;
    if (boundary === "hidden") { board.properties.visible = false; board.activate(); }
    if (boundary === "detached") board.detach();
    if (boundary === "empty") board.data.projects = [];
    if (["customer", "therapist"].includes(boundary)) board.data.role = boundary;
    const before = plain(board.data);
    board.allProjects(event);
    assert.deepEqual(plain(board.data), before, boundary);
    assert.equal(writes(h).length, 0);
    board.detach();
  }
});

test("close all submits every free unended interval across groups, including the current cell and short gaps", async () => {
  const h = adminSetup(); h.setNow("2026-10-30T09:45:00+08:00");
  h.app.globalData.user.therapistId = h.day.therapistId;
  h.day.ranges = [{ startTime: "09:00", endTime: "12:00" }, { startTime: "14:00", endTime: "16:00" }];
  h.day.closed = ["11:30", "14:30"];
  h.day.busy = [{ startTime: "10:00", endTime: "11:30" }, { startTime: "15:00", endTime: "15:30" }];
  h.day.appointments = [{ ...h.record, startTime: "10:00", endTime: "11:30" }];
  const originalAppointments = plain(h.day.appointments);
  let finish;
  h.deps.schedules.changeDay = async (id, payload) => {
    h.calls.push(["change", id, plain(payload)]);
    await new Promise(resolve => { finish = resolve; });
    h.day.closed = [...h.day.closed, ...payload.close].sort();
  };
  const board = h.board(); await flush();
  assert.equal(board.data.canCloseAll, true);
  assert.equal(board.data.canCloseChosen, false, "no manual selection is required");
  tap(board, "14:00"); tap(board, "14:30");
  board.selectProjects(eventFor(board, {}, { value: ["q"] }));
  const pending = closeAll(board);
  await flush();
  assert.equal(board.data.saving, true);
  await closeAll(board);
  assert.equal(writes(h).length, 1, "repeat taps cannot submit while saving");
  assert.deepEqual(writes(h)[0].slice(1), [h.day.therapistId, {
    date: h.day.date, expectedGrid: expectedGrid(h.day), close: ["09:30", "14:00", "15:30"]
  }], "selected free cells are included, while closed, occupied, elapsed and final boundaries are excluded");
  assert.deepEqual(plain(board.data.day.closed), ["11:30", "14:30"], "no optimistic closure before the server succeeds");
  finish(); await pending;
  assert.deepEqual(plain(board.data.day.closed), ["09:30", "11:30", "14:00", "14:30", "15:30"]);
  assert.deepEqual(plain(board.data.day.appointments), originalAppointments);
  assert.deepEqual(plain(board.data.day.serviceItemIds), ["p"], "closing does not submit unsaved project edits");
  assert.deepEqual(plain(board.data.chosen), []);
  assert.equal(board.data.canCloseAll, false);
  assert.equal(board.data.saving, false);
  await closeAll(board); assert.equal(writes(h).length, 1);
  board.detach();
});

for (const [step, end, expected] of [
  [10, "10:30", ["10:00", "10:10", "10:20"]],
  [15, "10:30", ["10:00", "10:15"]],
  [30, "10:30", ["10:00"]]
]) {
  test(`close all respects ${step}-minute precision without applying customer minimum duration`, async () => {
    const h = adminSetup(); h.setNow("2026-10-30T10:05:00+08:00");
    Object.assign(h.day, { step, ranges: [{ startTime: "09:00", endTime: end }], serviceItemIds: [] });
    const board = h.board(); await flush();
    await closeAll(board);
    assert.deepEqual(plain(writes(h)[0][2]), { date: h.day.date, expectedGrid: expectedGrid(h.day), close: expected });
    board.detach();
  });
}

test("rest, fully occupied, already closed and elapsed days cannot submit an empty close-all request", async () => {
  for (const patch of [
    { ranges: [] },
    { busy: [{ startTime: "09:00", endTime: "13:00" }] },
    { closed: ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30"] }
  ]) {
    const h = adminSetup(); Object.assign(h.day, patch);
    const board = h.board(); await flush();
    assert.equal(board.data.canCloseAll, false);
    await closeAll(board); assert.equal(writes(h).length, 0);
    board.detach();
  }
  const h = adminSetup(); h.setNow("2026-10-30T12:59:59+08:00");
  const board = h.board(); await flush();
  assert.equal(board.data.canCloseAll, true);
  // Simulate a delayed timer: the tap itself must recheck the exact current time.
  h.intervals.clear(); h.setNow("2026-10-30T13:00:00+08:00");
  await closeAll(board);
  assert.equal(board.data.canCloseAll, false);
  assert.equal(writes(h).length, 0);
  board.detach();
});

test("non-admins, hidden components and stale sessions cannot invoke close all", async () => {
  for (const kind of ["customer", "therapist", "hidden", "detached", "account", "session", "loading"]) {
    const h = adminSetup();
    if (["customer", "therapist"].includes(kind)) h.app.globalData.user.role = "user";
    if (kind === "therapist") h.app.globalData.user.therapistId = h.day.therapistId;
    const board = h.board(); await flush();
    if (kind === "hidden") { board.properties.visible = false; board.activate(); }
    if (kind === "detached") board.detach();
    if (kind === "account") h.app.globalData.user.id = "other-admin";
    if (kind === "session") h.app._loginSessionVersion++;
    let reload;
    if (kind === "loading") {
      h.deps.schedules.day = () => new Promise(resolve => { reload = resolve; });
      board.load();
    }
    await closeAll(board); assert.equal(writes(h).length, 0, kind);
    if (reload) { reload(plain(h.day)); await flush(); }
    board.detach();
  }
});

test("a failed close-all retains the prior schedule and can retry; a concurrent booking conflict refreshes it", async () => {
  const h = adminSetup();
  const board = h.board(); await flush();
  tap(board, "09:30");
  board.selectProjects(eventFor(board, {}, { value: ["q"] }));
  h.deps.schedules.changeDay = async () => { throw new Error("测试网络错误"); };
  await closeAll(board);
  assert.equal(board.data.saving, false);
  assert.deepEqual(plain(board.data.day.closed), []);
  assert.deepEqual(plain(board.data.chosen), ["09:30"]);
  assert.deepEqual(plain(board.data.projectIds), ["q"]);
  assert.equal(board.data.canCloseAll, true);
  assert.match(h.calls.at(-1)[1].title, /测试网络错误/);
  h.deps.schedules.changeDay = async () => {
    h.day.busy = [{ startTime: "09:00", endTime: "13:00" }];
    throw Object.assign(new Error("所选时间格已被预约"), { statusCode: 409 });
  };
  await closeAll(board);
  assert.equal(board.data.saving, false);
  assert.deepEqual(plain(board.data.day.closed), []);
  assert.equal(board.data.canCloseAll, false);
  assert.deepEqual(plain(board.data.chosen), []);
  board.detach();
});

test("a changed grid refreshes the day and requires a new confirmation for the new intervals", async () => {
  const h = adminSetup(false);
  const board = h.board(); await flush();
  const payloads = [];
  h.deps.schedules.changeDay = async (id, payload) => {
    payloads.push(plain(payload));
    if (payload.expectedGrid.step !== h.day.step) {
      throw Object.assign(new Error("当天排班已变化，请核对后重新确认"), { statusCode: 409 });
    }
    h.day.closed = [...payload.close];
  };
  const first = closeAll(board);
  h.day.step = 15;
  latestModal(h).success({ confirm: true }); await first;
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].expectedGrid.step, 30);
  assert.equal(board.data.day.step, 15);
  assert.deepEqual(plain(board.data.day.closed), []);
  assert.match(h.calls.filter(call => call[0] === "toast").at(-1)[1].title, /重新确认/);
  const retry = closeAll(board);
  assert.equal(payloads.length, 1);
  latestModal(h).success({ confirm: true }); await retry;
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].expectedGrid.step, 15);
  assert.ok(board.data.day.closed.includes("09:15"));
  board.detach();
});

test("late close-all responses do not refresh another date or notify a different login session", async () => {
  for (const transition of ["date", "account", "hidden", "detached"]) {
    const h = adminSetup(); let finish;
    h.deps.schedules.changeDay = () => new Promise(resolve => { finish = resolve; });
    const board = h.board(); await flush();
    const pending = closeAll(board);
    await flush();
    if (transition === "date") {
      h.day.date = "2026-10-31";
      board.properties.target = { therapistId: h.day.therapistId, date: h.day.date };
      await board.load();
    }
    if (transition === "account") h.app.globalData.user.id = "other-admin";
    if (transition === "hidden") { board.properties.visible = false; board.activate(); }
    if (transition === "detached") board.detach();
    const before = plain(board.data), callCount = h.calls.length;
    finish(); await pending;
    assert.deepEqual(plain(board.data), before, transition);
    assert.equal(h.calls.length, callCount, transition);
    board.detach();
  }
});

test("old rendered controls cannot edit or save a newly loaded date, therapist or login session", async () => {
  for (const transition of ["date", "therapist", "reenter", "reload", "account", "session"]) {
    const h = adminSetup(); h.day.closed = ["10:30"];
    const board = h.board(); await flush();
    const old = eventFor(board, { time: "09:30" }, { value: ["q"] });
    if (transition === "date") h.day.date = "2026-10-31";
    if (transition === "therapist") h.day.therapistId = "10000000-0000-4000-8000-000000000002";
    if (transition === "account") h.app.globalData.user.id = "other-admin";
    if (transition === "session") h.app._loginSessionVersion++;
    if (transition === "reenter") { board.properties.visible = false; board.activate(); board.properties.visible = true; }
    board.properties.target = { therapistId: h.day.therapistId, date: h.day.date };
    await board.load();
    tap(board, "09:30"); tap(board, "10:30");
    const before = plain(board.data);
    board.tapPoint(old); board.selectProjects(old); board.allProjects(old);
    for (const action of ["closeAll", "openAll", "close", "open", "projects"]) {
      old.currentTarget.dataset.action = action;
      await board.applyDay(old);
    }
    assert.deepEqual(plain(board.data), before, transition);
    assert.equal(writes(h).length, 0, transition);
    // Current controls still work; rejecting stale events must not disable the new page.
    board.selectProjects(eventFor(board, {}, { value: ["q"] }));
    await board.applyDay(eventFor(board, { action: "projects" }));
    assert.deepEqual(plain(writes(h)[0].slice(1)), [h.day.therapistId, { date: h.day.date, serviceItemIds: ["q"] }]);
    board.detach();
  }
});

test("admin controls reject missing versions and a target changed before its observer reloads", async () => {
  const h = adminSetup(), board = h.board(); await flush();
  await board.applyDay({ currentTarget: { dataset: { action: "closeAll" } } });
  assert.equal(writes(h).length, 0);
  const event = eventFor(board, { action: "closeAll", time: "09:30" }, { value: ["q"] });
  board.properties.target = { ...board.properties.target, date: "2026-10-31" };
  board.tapPoint(event); board.selectProjects(event); board.allProjects(event); await board.applyDay(event);
  assert.equal(writes(h).length, 0);
  assert.deepEqual(plain(board.data.chosen), []);
  assert.deepEqual(plain(board.data.projectIds), ["p"]);
  board.detach();
});

test("reentering the same date protects new drafts from old success, conflict and network failure callbacks", async () => {
  for (const action of ["closeAll", "openAll", "close", "open", "projects"]) {
    for (const outcome of ["success", "conflict", "network"]) {
      const h = adminSetup(); h.day.closed = ["10:30"];
      let finish, fail;
      h.deps.schedules.changeDay = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const board = h.board(); await flush();
      tap(board, "09:30"); tap(board, "10:30");
      const pending = board.applyDay(eventFor(board, { action }));
      await flush();
      assert.equal(board.data.saving, true);
      board.properties.visible = false; board.activate();
      board.properties.visible = true; board.activate(); await flush();
      board.selectProjects(eventFor(board, {}, { value: ["q"] }));
      tap(board, "11:00");
      const before = plain(board.data), callCount = h.calls.length;
      if (outcome === "success") finish();
      else fail(Object.assign(new Error("旧请求失败"), { statusCode: outcome === "conflict" ? 409 : 503 }));
      await pending;
      assert.deepEqual(plain(board.data), before, action + ":" + outcome);
      assert.equal(h.calls.length, callCount, "old responses must not show toasts or reload the new draft");
      board.detach();
    }
  }
});

test("an old save cannot unlock a new save after returning to the same date", async () => {
  const h = adminSetup(), completions = [];
  h.deps.schedules.changeDay = (...args) => {
    h.calls.push(["change", ...args]);
    return new Promise(resolve => completions.push(resolve));
  };
  const board = h.board(); await flush();
  const old = closeAll(board);
  await flush();
  board.properties.visible = false; board.activate();
  board.properties.visible = true; board.activate(); await flush();
  board.selectProjects(eventFor(board, {}, { value: ["q"] }));
  const current = board.applyDay(eventFor(board, { action: "projects" }));
  const readCount = h.calls.filter(call => call[0] === "day").length;
  completions[0](); await old;
  assert.equal(board.data.saving, true);
  assert.deepEqual(plain(board.data.projectIds), ["q"]);
  assert.equal(h.calls.filter(call => call[0] === "day").length, readCount);
  await closeAll(board); assert.equal(writes(h).length, 2, "still prevent duplicate saves");
  h.day.serviceItemIds = ["q"];
  completions[1](); await current;
  assert.equal(board.data.saving, false);
  assert.deepEqual(plain(board.data.projectIds), ["q"]);
  assert.equal(h.calls.filter(call => call[0] === "toast").length, 1, "only the current save announces success");
  board.detach();
});

test("rendered admin actions and selection controls all carry their day view version", () => {
  const template = fs.readFileSync(path.join(__dirname, "../../miniprogram/components/day-schedule/index.wxml"), "utf8");
  const controls = template.match(/<[^>]+bind(?:tap|change)="(?:applyDay|tapPoint|selectProjects|allProjects)"[^>]*>/g);
  assert.equal(controls.length, 8);
  for (const control of controls) assert.match(control, /data-view-version="\{\{viewVersion\}\}"/);
});

test("close-all uses its own flow row without overflowing its hit area; compact gaps apply only to admins", () => {
  const root = path.join(__dirname, "../../miniprogram/components/day-schedule");
  const styles = fs.readFileSync(path.join(root, "index.wxss"), "utf8");
  const template = fs.readFileSync(path.join(root, "index.wxml"), "utf8");
  const rules = new Map([...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => [match[1].trim(), match[2]]));
  const toolbar = rules.get(".schedule-toolbar"), action = rules.get(".close-all");
  const columns = rules.get(".schedule-toolbar, .points");
  assert.match(columns, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(toolbar, /justify-items:\s*end/);
  assert.match(rules.get(".close-all.open-all"), /grid-column:\s*1 \/ 4/);
  assert.match(action, /grid-column:\s*4;/);
  assert.match(action, /min-height:\s*27px/);
  for (const rule of [toolbar, action, rules.get(".close-all-content")]) {
    assert.doesNotMatch(rule, /position:\s*(absolute|fixed)|(?:^|;)\s*height:|(?:top|bottom):|transform:|margin[^:]*:\s*-/);
  }
  // Flow height grows with enlarged text; no pseudo-element may extend the tap target into neighboring rows.
  assert.doesNotMatch(styles, /\.close-all(?:::?|[\s.#][^{]*::)(?:before|after)\b/);
  assert.match(template, /role === 'admin' \? 'admin-content'/);
  assert.match(template, /role === 'admin' && index === 0 \? 'first-range'/);
  assert.match(rules.get(".schedule-guide"), /margin:\s*16rpx 0 20rpx/);
  assert.match(rules.get(".range"), /margin:\s*26rpx 0/);
  assert.equal(rules.has(".range.first-range"), false);
  assert.doesNotMatch(rules.get(".range-title"), /display:|line-height:/);
  assert.match(rules.get(".admin-content .schedule-guide"), /margin-bottom:\s*4rpx/);
  assert.match(rules.get(".admin-content .range.first-range"), /margin-top:\s*0/);
  assert.match(rules.get(".admin-content .range-title"), /display:\s*block/);
  assert.ok(template.indexOf('data-action="openAll"') < template.indexOf('data-action="closeAll"'));
  assert.match(rules.get(".close-all.open-all"), /color:\s*#356243/);
});

test("close all asks for confirmation, cancel preserves drafts, and duplicate confirmations submit only once", async () => {
  const h = adminSetup(false); h.day.closed = ["10:30"];
  const board = h.board(); await flush();
  tap(board, "09:30"); board.selectProjects(eventFor(board, {}, { value: ["q"] }));
  const pending = closeAll(board), modal = latestModal(h);
  assert.match(modal.content, new RegExp(h.day.date));
  assert.ok(modal.content.includes(h.day.therapistName));
  assert.match(modal.content, /不影响已有预约/);
  assert.equal(board.data.confirmingDay, true);
  assert.equal(board.data.saving, false);
  await closeAll(board); await openAll(board);
  assert.equal(h.calls.filter(call => call[0] === "modal").length, 1);
  assert.equal(writes(h).length, 0, "no write before confirmation");
  modal.success({ cancel: true }); await pending;
  assert.equal(board.data.confirmingDay, false);
  assert.deepEqual(plain(board.data.chosen), ["09:30"]);
  assert.deepEqual(plain(board.data.projectIds), ["q"]);
  assert.deepEqual(plain(board.data.day.closed), ["10:30"]);
  const retry = closeAll(board), confirmation = latestModal(h);
  confirmation.success({ confirm: true }); confirmation.success({ confirm: true }); await retry;
  assert.equal(writes(h).length, 1);
  assert.equal(board.data.confirmingDay, false);
  assert.equal(board.data.saving, false);
  board.detach();
});

test("confirmation errors release the controls and the next close-all can still succeed", async () => {
  for (const synchronous of [true, false]) {
    const h = adminSetup(false), board = h.board(); await flush();
    const original = h.wx.showModal;
    h.wx.showModal = options => {
      if (synchronous) throw new Error("native modal failed");
      options.fail(new Error("native modal failed"));
    };
    await closeAll(board);
    assert.equal(board.data.confirmingDay, false);
    assert.equal(board.data.saving, false);
    assert.equal(writes(h).length, 0);
    assert.match(h.calls.at(-1)[1].title, /无法打开确认/);
    h.wx.showModal = original;
    const pending = closeAll(board); latestModal(h).success({ confirm: true }); await pending;
    assert.equal(writes(h).length, 1);
    board.detach();
  }
});

test("close confirmation recomputes the remaining cells and never sends an empty or elapsed closure", async () => {
  for (const time of ["12:30:00", "13:00:00"]) {
    const h = adminSetup(false); h.setNow("2026-10-30T12:29:59+08:00");
    const board = h.board(); await flush();
    const pending = closeAll(board);
    h.intervals.clear(); h.setNow(`2026-10-30T${time}+08:00`);
    latestModal(h).success({ confirm: true }); await pending;
    if (time === "12:30:00") assert.deepEqual(plain(writes(h)[0][2]), { date: h.day.date, expectedGrid: expectedGrid(h.day), close: ["12:30"] });
    else {
      assert.equal(writes(h).length, 0);
      assert.match(h.calls.at(-1)[1].title, /暂无可关闭/);
    }
    assert.equal(board.data.confirmingDay, false);
    assert.equal(board.data.saving, false);
    board.detach();
  }
});

test("old close confirmations cannot affect changed days, staff, sessions, reloaded or departed views", async () => {
  for (const transition of ["date", "therapist", "reload", "hide-return", "account", "session", "detached"]) {
    const h = adminSetup(false), board = h.board(); await flush();
    const pending = closeAll(board), modal = latestModal(h);
    if (transition === "date") h.day.date = "2026-10-31";
    if (transition === "therapist") h.day.therapistId = "other-therapist";
    if (transition === "account") h.app.globalData.user.id = "other-admin";
    if (transition === "session") h.app._loginSessionVersion++;
    if (transition === "hide-return") { board.properties.visible = false; board.activate(); board.properties.visible = true; }
    if (transition === "detached") board.detach();
    else {
      board.properties.target = { therapistId: h.day.therapistId, date: h.day.date };
      await board.load();
    }
    const before = plain(board.data), count = h.calls.length;
    modal.success({ confirm: true }); await pending;
    assert.equal(writes(h).length, 0, transition);
    assert.deepEqual(plain(board.data), before, transition);
    assert.equal(h.calls.length, count, transition);
    board.detach();
  }
});

test("an old modal finishing cannot release a new view's confirmation lock", async () => {
  const h = adminSetup(false); h.day.closed = ["10:30"];
  const board = h.board(); await flush();
  const previous = openAll(board), oldModal = latestModal(h);
  h.day.date = "2026-10-31";
  board.properties.target = { ...board.properties.target, date: h.day.date };
  await board.load();
  const current = closeAll(board), newModal = latestModal(h);
  oldModal.success({ confirm: true }); await previous;
  assert.equal(board.data.confirmingDay, true);
  assert.equal(writes(h).length, 0);
  await closeAll(board);
  assert.equal(h.calls.filter(call => call[0] === "modal").length, 2);
  newModal.success({ cancel: true }); await current;
  assert.equal(board.data.confirmingDay, false);
  board.detach();
});

for (const step of [10, 15, 30]) {
  test(`open all restores only eligible closed ${step}-minute cells without changing bookings or projects`, async () => {
    const h = adminSetup(false); h.setNow("2026-10-30T10:05:00+08:00");
    Object.assign(h.day, { step, serviceItemIds: [], ranges: [{ startTime: "09:00", endTime: "12:00" }, { startTime: "14:00", endTime: "16:00" }],
      closed: ["09:00", "10:00", "11:00", "12:00", "14:00"], busy: [{ startTime: "11:00", endTime: "12:00" }] });
    let finish;
    h.deps.schedules.changeDay = async (id, payload) => {
      h.calls.push(["change", id, plain(payload)]);
      await new Promise(resolve => { finish = resolve; });
      h.day.closed = h.day.closed.filter(time => !payload.open.includes(time));
    };
    const board = h.board(); await flush();
    assert.equal(board.data.canOpenAll, true);
    assert.equal(board.data.chosen.length, 0);
    const pending = openAll(board); await openAll(board);
    assert.equal(writes(h).length, 0);
    assert.equal(h.calls.filter(call => call[0] === "modal").length, 1);
    const modal = latestModal(h);
    assert.equal(modal.confirmText, "确认开启");
    assert.ok(modal.content.includes(h.day.date) && modal.content.includes(h.day.therapistName));
    modal.success({ confirm: true }); await flush();
    assert.equal(writes(h).length, 1);
    assert.deepEqual(plain(writes(h)[0][2]), { date: h.day.date, expectedGrid: expectedGrid(h.day), open: ["10:00", "14:00"] });
    assert.deepEqual(plain(board.data.day.closed), ["09:00", "10:00", "11:00", "12:00", "14:00"]);
    finish(); await pending;
    assert.deepEqual(plain(board.data.day.closed), ["09:00", "11:00", "12:00"]);
    assert.deepEqual(plain(board.data.day.serviceItemIds), []);
    assert.deepEqual(plain(board.data.day.busy), [{ startTime: "11:00", endTime: "12:00" }]);
    assert.equal(board.data.canOpenAll, false);
    assert.equal(board.data.saving, false);
    await openAll(board); assert.equal(writes(h).length, 1);
    board.detach();
  });
}

test("cancelling open-all keeps the closed cells and selection; retry checks the clock again", async () => {
  const h = adminSetup(false); h.day.closed = ["09:00"];
  const board = h.board(); await flush();
  tap(board, "09:00");
  const cancelled = openAll(board);
  latestModal(h).success({ cancel: true }); await cancelled;
  assert.equal(writes(h).length, 0);
  assert.deepEqual(plain(board.data.day.closed), ["09:00"]);
  assert.deepEqual(plain(board.data.chosen), ["09:00"]);
  const retry = openAll(board);
  h.intervals.clear(); h.setNow("2026-10-30T09:30:00+08:00");
  latestModal(h).success({ confirm: true }); await retry;
  assert.equal(writes(h).length, 0);
  assert.equal(h.calls.at(-1)[1].title, "暂无可开启时段");
  assert.equal(board.data.confirmingDay, false);
  board.detach();
});

test("open-all rejects empty, elapsed, non-admin and stale-session requests", async () => {
  for (const kind of ["rest", "open", "elapsed", "customer", "therapist", "account", "hidden"]) {
    const h = adminSetup(); h.day.closed = ["09:00"];
    if (kind === "rest") h.day.ranges = [];
    if (kind === "open") h.day.closed = [];
    if (kind === "elapsed") h.setNow("2026-10-30T09:30:00+08:00");
    if (["customer", "therapist"].includes(kind)) h.app.globalData.user.role = "user";
    if (kind === "therapist") h.app.globalData.user.therapistId = h.day.therapistId;
    const board = h.board(); await flush();
    if (kind === "account") h.app.globalData.user.id = "another";
    if (kind === "hidden") { board.properties.visible = false; board.activate(); }
    await openAll(board);
    assert.equal(writes(h).length, 0, kind);
    board.detach();
  }
});

for (const [name, action] of [["open", openAll], ["close", closeAll]]) {
  for (const [skew, serverTime, expected] of [
    [120000, "09:29:30", ["09:00", "09:30", "10:00"]],
    [-120000, "09:30:30", ["09:30", "10:00"]]
  ]) {
    test(`bulk ${name} uses the server's current interval when the device clock is off by ${skew} ms`, async () => {
      const h = adminSetup();
      const serverNow = Date.parse(h.day.date + "T" + serverTime + "+08:00");
      h.setNow(new Date(serverNow + skew).toISOString());
      Object.assign(h.day, { serverNowMs: serverNow, ranges: [{ startTime: "09:00", endTime: "10:30" }],
        closed: name === "open" ? ["09:00", "09:30", "10:00"] : [] });
      const board = h.board(); await flush();
      const first = board.data.groups[0].points[0];
      assert.equal(first.manageable, expected.includes("09:00"));
      await action(board);
      assert.equal(writes(h).length, 1);
      assert.deepEqual(plain(writes(h)[0][2][name]), expected);
      assert.deepEqual(plain(writes(h)[0][2].expectedGrid), expectedGrid(h.day));
      board.detach();
    });
  }
}

test("a delayed catalog, timer and open modal all use elapsed time since the day response", async () => {
  let ticks = 100, finishCatalog;
  const h = setup({ performance: { now: () => ticks } });
  h.app.globalData.user.role = "admin";
  h.day.serverNowMs = Date.parse(h.day.date + "T09:29:59+08:00");
  h.day.closed = ["09:00", "09:30", "10:00"];
  h.deps.user.serviceItems = () => new Promise(resolve => { finishCatalog = resolve; });
  const board = h.board(); await flush();
  ticks += 1000;
  finishCatalog({ items: [] }); await flush();
  assert.equal(board.data.groups[0].points[0].passed, true, "catalog wait counts towards the server time");
  const pending = openAll(board);
  ticks += 30 * 60000;
  h.setNow("2026-10-30T03:00:00+08:00"); // Device wall clock changes while the dialog is open.
  assert.equal(board.data.groups[0].points.find(p => p.time === "09:30").passed, true);
  h.deps.user.serviceItems = async () => ({ items: [] });
  latestModal(h).success({ confirm: true }); await pending;
  assert.deepEqual(plain(writes(h)[0][2].open), ["10:00"]);
  board.detach();
});

test("unusable server time blocks bulk actions until a valid day read; late responses cannot replace its clock", async () => {
  const h = adminSetup(); h.day.closed = ["09:00", "10:30"];
  h.deps.schedules.day = async () => plain(h.day); // Older backend without a time sample.
  const board = h.board(); await flush();
  for (const sample of [undefined, 0, "invalid"]) {
    h.day.serverNowMs = sample; await board.load();
    assert.equal(board.data.bulkClockUnavailable, true);
    assert.equal(board.data.canOpenAll || board.data.canCloseAll, false);
    await openAll(board); await closeAll(board);
  }
  assert.equal(h.calls.some(c => c[0] === "modal" || c[0] === "change"), false);
  let finishOld;
  h.deps.schedules.day = () => new Promise(resolve => { finishOld = resolve; });
  const old = board.retryServerClock(eventFor(board));
  h.day.date = "2026-10-31";
  board.properties.target = { ...board.properties.target, date: h.day.date };
  h.day.serverNowMs = Date.parse(h.day.date + "T10:00:00+08:00");
  h.deps.schedules.day = async () => plain(h.day);
  await board.load();
  finishOld({ ...plain(h.day), date: "2026-10-30", serverNowMs: Date.parse("2026-10-30T08:00:00+08:00") });
  await old;
  assert.equal(board.data.bulkClockUnavailable, false);
  await openAll(board);
  assert.deepEqual(plain(writes(h)[0][2].open), ["10:30"]);
  board.detach();
});
