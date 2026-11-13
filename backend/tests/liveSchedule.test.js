process.env.NODE_TEST_CONTEXT = "1";
process.env.DATABASE_URL = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRule, changeClosures } = require("../src/utils/liveSchedule");
const { availability } = require("../../miniprogram/utils/scheduleGrid");
const range = (startTime, endTime) => ({ startTime, endTime });
const rule = patch => ({ therapistId: "fixture", step: 30, minDuration: 90,
  ranges: [range("14:00", "17:00")], serviceItemIds: [], manualClosedRanges: [], ...patch });

test("removed base hours survive only as live appointment occupancy and disappear when released", () => {
  const source = rule(), booking = range("10:00", "11:30");
  assert.deepEqual(resolveRule(source, [booking]).ranges, [booking, ...source.ranges]);
  assert.deepEqual(resolveRule(source, [range("10:00", "11:00")]).ranges[0], range("10:00", "11:00"));
  assert.deepEqual(resolveRule(source, []).ranges, source.ranges);
  assert.deepEqual(resolveRule(rule({ ranges: [] }), [booking]).ranges, [booking]);
  assert.deepEqual(resolveRule(rule({ ranges: [] }), []).ranges, []);
});

test("overlapping and adjacent base/occupancy merge without opening a gap", () => {
  const source = rule({ ranges: [range("09:00", "11:00"), range("12:00", "14:00")] });
  assert.deepEqual(resolveRule(source, [range("10:30", "11:30")]).ranges,
    [range("09:00", "11:30"), range("12:00", "14:00")]);
  assert.deepEqual(resolveRule(source, [range("10:30", "12:00")]).ranges, [range("09:00", "14:00")]);
});

test("incompatible precision/minimum retains actual parameters and fits new base inward", () => {
  const source = rule({ step: 15, minDuration: 120, fallbackStep: 10, fallbackMinDuration: 90,
    ranges: [range("14:15", "17:15")] });
  const resolved = resolveRule(source, [range("09:10", "10:40")]);
  assert.equal(resolved.step, 10); assert.equal(resolved.minDuration, 90); assert.equal(resolved.parametersDeferred, true);
  assert.deepEqual(resolved.ranges, [range("09:10", "10:40"), range("14:20", "17:10")]);
  const released = resolveRule(source, []);
  assert.equal(released.step, 15); assert.equal(released.minDuration, 120); assert.equal(released.parametersDeferred, false);
  assert.deepEqual(released.ranges, source.ranges);
  assert.equal(resolveRule(source, [range("09:00", "11:00")]).parametersDeferred, false);
});

test("manual closure survives template removal/re-add and precision round trips without expansion in storage", () => {
  const manual = [range("09:10", "09:20")];
  assert.deepEqual(resolveRule(rule({ ranges: [], manualClosedRanges: manual })).closed, []);
  assert.deepEqual(resolveRule(rule({ ranges: [range("09:00", "12:00")], manualClosedRanges: manual })).closed, ["09:00"]);
  assert.deepEqual(resolveRule(rule({ step: 10, ranges: [range("09:00", "12:00")], manualClosedRanges: manual })).closed, ["09:10"]);
  const changed = changeClosures([range("09:00", "10:00"),range("18:00", "18:30")], ["09:15"], ["11:00"], 15);
  assert.deepEqual(changed,[range("09:00","09:15"),range("09:30","10:00"),range("11:00","11:15"),range("18:00","18:30")]);
  assert.deepEqual(manual,[range("09:10","09:20")]);
});

test("grid does not offer protected occupancy to a new booking but lets its owner retain or shrink it", () => {
  const original = range("10:00","12:00");
  const day = { ...resolveRule(rule(),[original]),date:"2090-01-01",busy:[original] };
  const at=Date.parse("2090-01-01T09:00:00+08:00");
  assert.equal(availability(day,null,at).starts.has("10:00"),false);
  const editing=availability({...day,busy:[]},{...original,status:"booked"},at);
  assert.deepEqual(editing.starts.get("10:00"),["11:30","12:00"]);
  assert.equal(editing.starts.get("10:00").includes("14:00"),false);
});
