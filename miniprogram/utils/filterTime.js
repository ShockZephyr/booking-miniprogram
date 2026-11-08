// Filter boundaries are independent of each therapist's booking grid.
const STEP = 30;
const LAST = 1439;
const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const format = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const startTimes = Array.from({ length: 48 }, (_, index) => format(index * STEP));
const endTimes = startTimes.concat("23:59");
const startLabels = startTimes.slice();
const endLabels = startTimes.concat("全天结束（23:59）");
const timesFor = field => field === "endTime" ? endTimes : startTimes;
const indexFromTime = (time, field) => timesFor(field).indexOf(time);

function timeFromIndex(value, field) {
  if (!["startTime", "endTime"].includes(field)
    || !["number", "string"].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
  return timesFor(field)[Number(value)] || null;
}

// Manual edits retain the chosen endpoint. Failure leaves the previous draft intact.
function editRange(previous, field, time, minimum) {
  if (indexFromTime(time, field) < 0) return null;
  let start = minutes(field === "startTime" ? time : previous.startTime);
  let end = minutes(field === "endTime" ? time : previous.endTime);
  const duration = minimum || 1;
  if (end - start < duration) {
    if (field === "startTime") {
      if (start + duration > LAST) return null;
      end = Math.min(LAST, Math.ceil((start + duration) / STEP) * STEP);
    } else {
      if (end - duration < 0) return null;
      start = Math.floor((end - duration) / STEP) * STEP;
    }
  }
  return { startTime: format(start), endTime: format(end) };
}

// A new date/category may require a wider range, including moving both boundaries
// near midnight. Keep this in sync with backend utils/schedule.expandFilterRange.
function expandRange(startTime, endTime, minimum) {
  const duration = minimum || 1;
  let start = minutes(startTime), end = minutes(endTime);
  if (end - start < duration) {
    end = Math.min(LAST, Math.ceil((start + duration) / STEP) * STEP);
    if (end - start < duration) start = Math.max(0, Math.floor((end - duration) / STEP) * STEP);
  }
  return { startTime: format(start), endTime: format(end) };
}

module.exports = { startLabels, endLabels, indexFromTime, timeFromIndex, editRange, expandRange };
