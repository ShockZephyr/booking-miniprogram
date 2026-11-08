const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setup, flush, tap, plain } = require("./support/scheduleUI");

const pointAt = (board, time) => board.data.groups.flatMap(group => group.points).find(point => point.time === time);
function therapistSetup() {
  const h = setup();
  h.app.globalData.user.therapistId = h.day.therapistId;
  return h;
}

test("therapist cells distinguish elapsed, closed, occupied and free intervals without allowing interaction", async () => {
  const h = therapistSetup(); h.setNow("2026-10-30T09:45:00+08:00");
  h.day.closed = ["10:00"];
  h.day.busy = [{ startTime: "10:30", endTime: "12:00" }];
  h.day.appointments = [{ ...h.record, startTime: "10:30", endTime: "12:00", status: "booked" }];
  const board = h.board(); await flush();
  assert.equal(board.data.role, "therapist");
  for (const time of ["09:00", "10:00"]) assert.equal(pointAt(board, time).state, "inactive");
  assert.equal(pointAt(board, "13:00").state, "");
  for (const time of ["10:30", "11:00", "11:30"]) {
    assert.equal(pointAt(board, time).state, "booked");
    assert.equal(pointAt(board, time).caption, "已预约");
  }
  // The current free cell, booking end and short free tail are still shown as free.
  for (const time of ["09:30", "12:00", "12:30"]) {
    assert.equal(pointAt(board, time).state, "");
    assert.equal(pointAt(board, time).caption, "");
  }
  const callsBefore = h.calls.length;
  for (const point of board.data.groups[0].points) {
    assert.equal(point.disabled, true);
    tap(board, point.time);
  }
  assert.equal(h.calls.length, callsBefore, "no selection, toast, navigation or write from a cell tap");
  assert.deepEqual(plain([board.data.start, board.data.end, board.data.chosen]), ["", "", []]);
  assert.equal(board.data.nextReady, false);
  board.openAppointment({ currentTarget: { dataset: { id: h.record.id } } });
  assert.equal(h.calls.at(-1)[1].url, "/pages/therapist/appointment-detail/index?appointmentId=a");
  board.detach();
});

for (const role of ["therapist", "admin"]) {
  test(`${role} day schedule truncates appointment projects at 16 characters and notes at 18 characters`, async () => {
    const h = role === "therapist" ? therapistSetup() : setup();
    if (role === "admin") h.app.globalData.user.role = "admin";
    h.day.appointments = [{
      ...h.record,
      serviceItemName: "一二三四五六七八九十甲乙丙丁戊己庚",
      note: "一二三四五六七八九十甲乙丙丁戊己庚辛壬"
    }];
    const board = h.board(); await flush();
    assert.equal(board.data.appointments[0].projectSummary, "一二三四五六七八九十甲乙丙丁戊己…");
    assert.equal(board.data.appointments[0].notePreview, "一二三四五六七八九十甲乙丙丁戊己庚辛...");
    board.detach();
  });
}

test("therapist cells turn gray and show unsigned status at each cell end without reloading or mutating the appointment", async () => {
  const h = therapistSetup(); h.setNow("2026-10-30T09:29:59+08:00");
  h.day.busy = [{ startTime: "09:30", endTime: "11:00" }];
  h.day.appointments = [{ ...h.record, startTime: "09:30", endTime: "11:00", status: "booked" }];
  const board = h.board(); await flush();
  const reads = h.calls.filter(call => call[0] === "day").length;
  assert.equal(pointAt(board, "09:00").state, "");
  h.setNow("2026-10-30T09:30:00+08:00");
  assert.equal(pointAt(board, "09:00").state, "inactive");
  assert.equal(pointAt(board, "09:30").state, "booked");
  h.setNow("2026-10-30T10:00:00+08:00");
  assert.equal(pointAt(board, "09:30").state, "inactive");
  assert.equal(pointAt(board, "09:30").caption, "未签到");
  assert.match(pointAt(board, "09:30").hint, /已结束/);
  assert.equal(pointAt(board, "10:00").state, "booked");
  h.setNow("2026-10-30T11:00:00+08:00");
  assert.equal(pointAt(board, "10:30").state, "inactive");
  assert.equal(pointAt(board, "10:30").caption, "未签到");
  assert.equal(pointAt(board, "11:00").state, "");
  assert.equal(pointAt(board, "11:00").caption, "");
  assert.equal(board.data.day.appointments[0].status, "booked");
  assert.equal(h.calls.filter(call => call[0] === "day").length, reads);
  board.detach(); assert.equal(h.intervals.size, 0);
});

test("elapsed cells retain no-show and checked-in labels after reload without labeling cancelled or empty intervals", async () => {
  const h = therapistSetup(); h.setNow("2026-10-30T13:00:00+08:00");
  h.day.ranges = [{ startTime: "09:00", endTime: "15:00" }];
  h.day.busy = [{ startTime: "10:30", endTime: "12:00" }];
  h.day.closed = ["12:30"];
  h.day.appointments = [
    { ...h.record, id: "cancelled-before-rebooking", status: "cancelled", startTime: "09:00", endTime: "10:30" },
    { ...h.record, id: "unsigned", status: "no_show", startTime: "09:00", endTime: "10:30" },
    { ...h.record, id: "signed", status: "checked_in", startTime: "10:30", endTime: "12:00" },
    { ...h.record, id: "cancelled", status: "cancelled", startTime: "12:00", endTime: "13:30" }
  ];
  const board = h.board(); await flush();
  for (let pass = 0; pass < 2; pass++) {
    for (const time of ["09:00", "09:30", "10:00"]) {
      assert.equal(pointAt(board, time).state, "inactive");
      assert.equal(pointAt(board, time).caption, "未签到");
    }
    for (const time of ["10:30", "11:00", "11:30"]) {
      assert.equal(pointAt(board, time).state, "inactive");
      assert.equal(pointAt(board, time).caption, "已签到");
    }
    for (const time of ["12:00", "12:30", "13:00", "15:00"]) assert.equal(pointAt(board, time).caption, "");
    assert.equal(pointAt(board, "12:00").state, "inactive");
    assert.equal(pointAt(board, "12:30").state, "inactive");
    assert.equal(pointAt(board, "13:00").state, "");
    await board.load();
  }
  board.detach();
});

test("a checked-in appointment keeps lavender future cells and reveals its check-in label as each cell ends", async () => {
  const h = therapistSetup(); h.setNow("2026-10-30T09:29:59+08:00");
  h.day.busy = [{ startTime: "09:00", endTime: "11:00" }];
  h.day.appointments = [h.record];
  const board = h.board(); await flush();
  assert.equal(pointAt(board, "09:00").state, "booked");
  assert.equal(pointAt(board, "09:00").caption, "已预约");
  h.setNow("2026-10-30T09:30:00+08:00");
  assert.equal(pointAt(board, "09:00").state, "inactive");
  assert.equal(pointAt(board, "09:00").caption, "已签到");
  assert.match(pointAt(board, "09:00").hint, /已签到，已结束/);
  assert.equal(pointAt(board, "09:30").state, "booked");
  assert.equal(pointAt(board, "09:30").caption, "已预约");
  board.detach();
});

test("refreshing after staff check-in or undo replaces the elapsed-cell status and never labels the final boundary", async () => {
  const h = therapistSetup(); h.setNow("2026-10-30T13:00:00+08:00");
  h.day.ranges = [{ startTime: "09:00", endTime: "11:00" }];
  h.day.appointments = [{ ...h.record, status: "no_show" }];
  const board = h.board(); await flush();
  for (const status of ["no_show", "checked_in", "no_show"]) {
    h.day.appointments[0].status = status;
    h.day.busy = status === "checked_in" ? [{ startTime: "09:00", endTime: "11:00" }] : [];
    await board.load();
    for (const time of ["09:00", "09:30", "10:00", "10:30"]) {
      assert.equal(pointAt(board, time).state, "inactive");
      assert.equal(pointAt(board, time).caption, status === "checked_in" ? "已签到" : "未签到");
    }
    assert.equal(pointAt(board, "11:00").caption, "");
    assert.equal(pointAt(board, "11:00").state, "", "a past final boundary remains white");
  }
  board.detach();
});

for (const step of [10, 15, 30]) {
  test(`therapist free intervals do not inherit customer minimum-duration restrictions at ${step}-minute precision`, async () => {
    const h = therapistSetup(); h.setNow("2026-10-30T08:00:00+08:00");
    Object.assign(h.day, { step, ranges: [{ startTime: "19:00", endTime: "21:00" }] });
    const board = h.board(); await flush();
    assert.equal(pointAt(board, "20:00").state, "");
    assert.equal(pointAt(board, "20:00").disabled, true);
    assert.equal(pointAt(board, "21:00").state, "", "last endpoint is white but cannot be selected");
    assert.equal(pointAt(board, "21:00").disabled, true);
    tap(board, "21:00");
    assert.deepEqual(plain([board.data.start, board.data.end, board.data.chosen]), ["", "", []]);
    h.setNow("2026-10-30T21:00:00+08:00");
    assert.equal(pointAt(board, "21:00").state, "");
    board.detach();
  });
}

test("an administrator who is also a therapist retains admin closing and reopening interactions", async () => {
  const h = therapistSetup(); h.app.globalData.user.role = "admin";
  h.day.closed = ["10:00"];
  const board = h.board(); await flush();
  assert.equal(board.data.role, "admin");
  assert.equal(pointAt(board, "10:00").state, "closed");
  tap(board, "10:00");
  assert.equal(board.data.canOpenChosen, true);
  tap(board, "09:30");
  assert.equal(board.data.canCloseChosen, true);
  assert.deepEqual(plain(board.data.chosen), ["10:00", "09:30"]);
  board.detach();
});

for (const combined of [false, true]) {
  test(`administrator${combined ? " with therapist identity" : ""} sees appointment colors and past check-in labels while retaining schedule controls`, async () => {
    const h = setup(); h.app.globalData.user.role = "admin";
    if (combined) h.app.globalData.user.therapistId = h.day.therapistId;
    h.setNow("2026-10-30T13:15:00+08:00");
    h.day.ranges = [{ startTime: "09:00", endTime: "18:00" }];
    h.day.closed = ["12:30", "16:00"];
    h.day.busy = [{ startTime: "10:30", endTime: "12:00" }, { startTime: "14:00", endTime: "15:30" }];
    h.day.appointments = [
      { ...h.record, id: "unsigned", startTime: "09:00", endTime: "10:30", status: "no_show" },
      { ...h.record, id: "signed", startTime: "10:30", endTime: "12:00", status: "checked_in" },
      { ...h.record, id: "cancelled", startTime: "12:00", endTime: "13:30", status: "cancelled" },
      { ...h.record, id: "future", startTime: "14:00", endTime: "15:30", status: "booked" }
    ];
    const board = h.board(); await flush();
    for (const [time, caption] of [["09:00", "未签到"], ["10:00", "未签到"], ["10:30", "已签到"], ["11:30", "已签到"], ["12:00", ""], ["12:30", ""]]) {
      const point = pointAt(board, time);
      assert.equal(point.state, "inactive", time);
      assert.equal(point.caption, caption, time);
      assert.equal(point.disabled, true, time);
    }
    for (const time of ["14:00", "14:30", "15:00"]) {
      assert.equal(pointAt(board, time).state, "booked");
      assert.equal(pointAt(board, time).caption, "已预约");
      assert.equal(pointAt(board, time).disabled, true);
    }
    for (const time of ["13:00", "15:30", "17:30"]) {
      assert.equal(pointAt(board, time).state, "");
      assert.equal(pointAt(board, time).caption, "");
      assert.equal(pointAt(board, time).disabled, false);
    }
    assert.equal(pointAt(board, "16:00").state, "closed");
    assert.equal(pointAt(board, "16:00").caption, "已关闭");
    assert.equal(pointAt(board, "18:00").state, "inactive");
    assert.equal(pointAt(board, "18:00").caption, "边界");
    assert.equal(pointAt(board, "18:00").disabled, true);
    for (const time of ["09:00", "12:30", "14:00", "18:00"]) tap(board, time);
    assert.deepEqual(plain(board.data.chosen), []);
    tap(board, "13:00"); tap(board, "16:00"); tap(board, "17:30");
    assert.deepEqual(plain(board.data.chosen), ["13:00", "16:00", "17:30"]);
    assert.equal(board.data.canCloseChosen, true);
    assert.equal(board.data.canOpenChosen, true);
    for (const time of board.data.chosen) assert.equal(pointAt(board, time).state, "selected");
    board.detach();
  });
}

test("administrator clock updates hide elapsed empty-cell text, reveal check-in state and clear expired selections", async () => {
  const h = setup(); h.app.globalData.user.role = "admin";
  h.setNow("2026-10-30T09:29:59+08:00");
  h.day.closed = ["09:00"];
  h.day.busy = [{ startTime: "09:30", endTime: "11:00" }];
  h.day.appointments = [{ ...h.record, startTime: "09:30", endTime: "11:00", status: "booked" }];
  const board = h.board(); await flush();
  tap(board, "09:00"); assert.equal(board.data.canOpenChosen, true);
  const reads = h.calls.filter(call => call[0] === "day").length;
  h.setNow("2026-10-30T09:30:00+08:00");
  assert.equal(pointAt(board, "09:00").state, "inactive");
  assert.equal(pointAt(board, "09:00").caption, "");
  assert.deepEqual(plain(board.data.chosen), []);
  assert.equal(board.data.canOpenChosen, false);
  h.setNow("2026-10-30T10:00:00+08:00");
  assert.equal(pointAt(board, "09:30").state, "inactive");
  assert.equal(pointAt(board, "09:30").caption, "未签到");
  assert.equal(pointAt(board, "10:00").state, "booked");
  assert.equal(pointAt(board, "10:00").caption, "已预约");
  assert.equal(h.calls.filter(call => call[0] === "day").length, reads);
  h.day.appointments[0].status = "checked_in";
  await board.load();
  assert.equal(pointAt(board, "09:30").caption, "已签到");
  assert.equal(pointAt(board, "09:30").state, "inactive");
  assert.equal(pointAt(board, "10:00").state, "booked");
  h.setNow("2026-10-30T13:00:00+08:00");
  assert.equal(pointAt(board, "13:00").state, "inactive");
  assert.equal(pointAt(board, "13:00").caption, "边界");
  assert.equal(pointAt(board, "13:00").disabled, true);
  tap(board, "13:00");
  assert.deepEqual(plain(board.data.chosen), []);
  board.detach();
});

test("therapist markup uses passive cells so global disabled-button colors cannot hide occupancy", () => {
  const base = path.join(__dirname, "../../miniprogram/components/day-schedule/index");
  const template = fs.readFileSync(base + ".wxml", "utf8");
  const css = fs.readFileSync(base + ".wxss", "utf8");
  const passive = template.match(/<block wx:if="{{role === 'therapist'}}">([\s\S]*?)<\/block>/);
  assert.ok(passive);
  assert.match(passive[1], /<view[^>]*class="point readonly {{item.state}}"/);
  assert.match(passive[1], /{{item.caption}}/);
  assert.doesNotMatch(passive[1], /<button|bindtap|catchtap|hover-class/);
  assert.match(css, /\.point\s*\{[^}]*background:\s*#fff;/);
  assert.match(css, /\.point\.inactive\s*\{[^}]*background:\s*#efedf1;/);
  assert.match(css, /\.point\.booked\s*\{[^}]*background:\s*#e6e0f8;/);
  assert.match(template, /{{role === 'customer' && item\.disabled && item\.state !== 'end-only' && item\.state !== 'limited' \? 'inactive' : ''}}/,
    "staff colors come from explicit state rather than the customer disabled style");
});
