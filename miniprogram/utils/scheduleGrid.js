const dates = require("./date");

function minutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function clock(minute) {
  return String(Math.floor(minute / 60)).padStart(2, "0") + ":" + String(minute % 60).padStart(2, "0");
}

function instant(date, time) {
  return new Date(date + "T" + time + ":00+08:00").getTime();
}

// Each boundary can end the previous cell even if the cell starting there is closed or occupied.
function availability(day, editing, now = Date.now()) {
  const { step, minDuration, date } = day;
  const groups = [];
  const starts = new Map();
  const closed = new Set(day.closed || []);
  const busy = day.busy || [];
  const stopped = editing && (!["booked", "checked_in"].includes(editing.status) || now >= instant(date, editing.endTime));
  const fixed = editing && now >= instant(date, editing.startTime) ? editing.startTime : "";
  for (const range of day.ranges || []) {
    const from = minutes(range.startTime), to = minutes(range.endTime), points = [];
    if (!(step > 0 && minDuration > 0 && from < to)) continue;
    let freeUntil = to;
    for (let m = to; m >= from; m -= step) {
      const time = clock(m), next = clock(m + step);
      const edge = m === to;
      const isBusy = !edge && busy.some((b) => time < b.endTime && next > b.startTime);
      const isClosed = !edge && closed.has(time);
      const passed = !edge && now >= instant(date, next);
      if (isBusy || isClosed) freeUntil = m;
      const ends = [];
      const eligible = fixed ? time === fixed : !passed;
      if (!stopped && eligible && !edge && !isBusy && !isClosed) {
        for (let end = m + minDuration; end <= freeUntil; end += step) {
          const value = clock(end);
          if (now < instant(date, value)) ends.push(value);
        }
      }
      if (ends.length) starts.set(time, ends);
      points.unshift({ time, edge, isBusy, isClosed, passed, manageable: !edge && !isBusy && !passed });
    }
    groups.push({ id: range.startTime, startTime: range.startTime, endTime: range.endTime, points });
  }
  return { groups, starts, fixed, stopped };
}

function windowBounds(today, count) {
  const remaining = Math.floor((Date.parse("9999-12-31") - Date.parse(today)) / 86400000);
  return { first: today, last: dates.addDays(today, Math.min(remaining, Math.max(1, count) - 1)) };
}

module.exports = { minutes, clock, instant, availability, windowBounds };
