const { assertTimeString, toShanghaiInstant } = require("./date");
const { AppError } = require("./errors");

function invalid(message) {
  throw new AppError("INVALID_SCHEDULE", message, 400);
}

function minutes(time) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

function normalizeSchedule(input) {
  if (!input || ![10, 15, 30].includes(input.step)) invalid("时间精度须为10、15或30分钟");
  const { step, minDuration } = input;
  if (!Number.isInteger(minDuration) || minDuration <= 0 || minDuration > 2147483647 || minDuration % step) {
    invalid("最短时长须为时间精度的正整数倍");
  }
  if (!Array.isArray(input.ranges)) invalid("请设置排班分组");
  const sorted = input.ranges.map((range) => {
    if (!range || ![range.startTime, range.endTime].every(time => assertTimeString(time) && minutes(time) % step === 0)
      || range.startTime >= range.endTime) invalid("排班起止须对齐格点，且结束晚于开始");
    return { startTime: range.startTime, endTime: range.endTime };
  }).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const ranges = [];
  for (const range of sorted) {
    const previous = ranges.at(-1);
    if (previous && range.startTime < previous.endTime) invalid("同一天的排班分组不能重叠");
    if (previous && range.startTime === previous.endTime) previous.endTime = range.endTime;
    else ranges.push(range);
  }
  if (ranges.some(range => minutes(range.endTime) - minutes(range.startTime) < minDuration)) {
    invalid(`每段连续排班至少需要 ${minDuration} 分钟，相邻排班合并后计算`);
  }
  return { step, minDuration, ranges };
}

function availability(day, now = new Date(), window = {}) {
  if (!day.ranges.length) return "off";
  if (!day.serviceItemIds.length) return "full";
  const blocks = [
    ...day.closed.map(time => [minutes(time), minutes(time) + day.step]),
    ...day.busy.map(range => [minutes(range.startTime), minutes(range.endTime)])
  ];
  const elapsed = (now - toShanghaiInstant(day.date, "00:00")) / 60000;
  const first = Math.floor(elapsed / day.step) * day.step;
  for (const range of day.ranges) {
    const end = Math.min(minutes(range.endTime), minutes(window.endTime || "23:59"));
    const lower = Math.ceil(minutes(window.startTime || "00:00") / day.step) * day.step;
    for (let start = Math.max(minutes(range.startTime), first, lower); start + day.minDuration <= end; start += day.step) {
      if (blocks.every(([a, b]) => a >= start + day.minDuration || b <= start)) return "available";
    }
  }
  return "full";
}

function parseRosterFilters(query = {}) {
  const fail = () => { throw new AppError("INVALID_FILTER", "筛选条件无效", 400); };
  function ids(value) {
    if (value === undefined || value === "") return [];
    if (typeof value !== "string") return fail();
    const values = [...new Set(value.split(",").map(id => id.trim().toLowerCase()))];
    if (values.length > 50 || values.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) return fail();
    return values;
  }
  const startTime = query.startTime === undefined ? "00:00" : query.startTime;
  const endTime = query.endTime === undefined ? "23:59" : query.endTime;
  if (!assertTimeString(startTime) || !assertTimeString(endTime) || startTime >= endTime) fail();
  return { serviceItemIds: ids(query.serviceItemIds), therapistIds: ids(query.therapistIds), startTime, endTime };
}

// Expands short ranges without shortening a valid one; the browser uses the same rule.
function expandFilterRange(startTime, endTime, minimum) {
  const duration = minimum || 1;
  let start = minutes(startTime), end = minutes(endTime);
  if (end - start < duration) {
    end = Math.min(1439, Math.ceil((start + duration) / 30) * 30);
    if (end - start < duration) start = Math.max(0, Math.floor((end - duration) / 30) * 30);
  }
  const format = value => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  return { startTime: format(start), endTime: format(end) };
}

module.exports = { invalid, minutes, normalizeSchedule, availability, parseRosterFilters, expandFilterRange };
