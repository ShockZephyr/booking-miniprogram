const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function pad(value) {
  return value < 10 ? `0${value}` : String(value);
}

function formatDate(date) {
  return calendarDate(new Date(date.getTime() + 8 * 60 * 60 * 1000));
}

// Date-only calendar arithmetic uses UTC fields; instants are shifted to Shanghai.
function calendarDate(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function today() {
  return formatDate(new Date());
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return calendarDate(date);
}

function buildDateStrip(base = today(), first, last) {
  let start = addDays(base, -10);
  if (first && last) {
    if (addDays(start, 20) > last) start = addDays(last, -20);
    if (start < first) start = first;
  }
  const length = first && last ? Math.min(21, Math.round((Date.parse(last) - Date.parse(start)) / 86400000) + 1) : 21;
  return Array.from({ length }).map((_, index) => {
    const date = addDays(start, index);
    const d = new Date(`${date}T00:00:00Z`);
    return {
      date,
      day: `${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`,
      displayDate: `${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`,
      weekday: WEEKDAYS[d.getUTCDay()]
    };
  });
}

function buildCalendarMonths(base = today(), first, last) {
  const current = new Date(`${base}T00:00:00Z`);
  current.setUTCDate(1);
  const months = [];
  for (let offset = -2; offset <= 3; offset += 1) {
    const monthDate = new Date(current);
    monthDate.setUTCMonth(current.getUTCMonth() + offset);
    const year = monthDate.getUTCFullYear();
    const month = monthDate.getUTCMonth();
    const prefix = `${year}-${pad(month + 1)}`;
    if (first && (prefix < first.slice(0, 7) || prefix > last.slice(0, 7))) continue;
    const id = `month_${year}_${pad(month + 1)}`;
    const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const days = [];
    for (let blank = 0; blank < firstDay; blank += 1) {
      days.push({ blank: true });
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = calendarDate(new Date(Date.UTC(year, month, day)));
      days.push({ date, day, past: date < today(), disabled: !!first && (date < first || date > last) });
    }
    months.push({
      id,
      hasEarlier: !!first && prefix > first.slice(0, 7),
      hasLater: !!last && prefix < last.slice(0, 7),
      title: `${year}年${month + 1}月`,
      current: first ? base.startsWith(`${year}-${pad(month + 1)}-`) : offset === 0,
      days
    });
  }
  return months;
}

function statusDot(statuses) {
  const priority = ["booked", "cancelled", "no_show", "checked_in"];
  const found = priority.find((status) => statuses.indexOf(status) >= 0);
  return found || "";
}

function isExpired(date, time) {
  const dateParts = String(date || "").split("-").map(Number);
  const timeParts = String(time || "").split(":").map(Number);
  if (dateParts.length < 3 || timeParts.length < 2) return false;
  const target = Date.UTC(
    dateParts[0],
    dateParts[1] - 1,
    dateParts[2],
    timeParts[0],
    timeParts[1],
    0
  ) - 8 * 60 * 60 * 1000;
  return target <= Date.now();
}

module.exports = {
  today,
  addDays,
  formatDate,
  buildDateStrip,
  buildCalendarMonths,
  statusDot,
  isExpired
};
