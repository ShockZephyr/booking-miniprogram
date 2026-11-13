const { minutes } = require("./schedule");

const clock = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const intervals = ranges => ranges.map(r => [minutes(r.startTime), minutes(r.endTime)]);
const ranges = values => values.map(([a, b]) => ({ startTime: clock(a), endTime: clock(b) }));

function union(values) {
  const merged = [];
  for (const [a, b] of values.filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

function compatible(step, minimum, appointments) {
  return appointments.every(a => minutes(a.startTime) % step === 0 && minutes(a.endTime) % step === 0
    && minutes(a.endTime) - minutes(a.startTime) >= minimum);
}

// Base ranges never include protected-only occupancy. That occupancy is derived
// afresh from the current appointments, so cancellation/shrinking releases it
// without converting it into new availability or writing during a read.
function resolveRule(rule, appointments = []) {
  const deferred = !compatible(rule.step, rule.minDuration, appointments);
  const step = deferred && rule.fallbackStep || rule.step;
  const minDuration = deferred && rule.fallbackMinDuration || rule.minDuration;
  const base = intervals(rule.ranges).map(([a, b]) => [Math.ceil(a / step) * step, Math.floor(b / step) * step]);
  const effective = union([...base, ...intervals(appointments)]);
  const manual = intervals(rule.manualClosedRanges || []);
  const closed = [];
  for (const [from, to] of effective) {
    for (let start = from; start < to; start += step) {
      // A grid cell is usable only if its entire interval is open. The exact
      // closure is retained even when a coarser grid temporarily masks more.
      if (manual.some(([a, b]) => a < start + step && b > start)) closed.push(clock(start));
    }
  }
  return { therapistId: rule.therapistId, step, minDuration, ranges: ranges(effective),
    serviceItemIds: rule.serviceItemIds, closed, parametersDeferred: deferred };
}

function changeClosures(existing, open, close, step) {
  let values = intervals(existing);
  for (const time of open) {
    const start = minutes(time), end = start + step;
    values = values.flatMap(([a, b]) => b <= start || a >= end ? [[a, b]]
      : [[a, Math.min(b, start)], [Math.max(a, end), b]].filter(([x, y]) => x < y));
  }
  return ranges(union([...values, ...close.map(time => [minutes(time), minutes(time) + step])]));
}

module.exports = { resolveRule, changeClosures, compatible };
