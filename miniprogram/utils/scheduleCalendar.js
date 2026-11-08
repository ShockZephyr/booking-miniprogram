const dates = require("./date");
const appointments = require("../services/appointment");
const loginReturn = require("./loginReturn");

function nextMonths({ months, first, last }, direction) {
  if (!months.length) return months;
  const back = direction === "back";
  const edge = back ? months[0].days.find(day => day.date).date : months[months.length - 1].days.slice(-1)[0].date;
  const anchor = dates.addDays(edge, back ? -1 : 1);
  return anchor < first || anchor > last ? months : dates.buildCalendarMonths(anchor, first, last);
}

// Calendar dates are shared navigation, but their appointment dots belong to this account and month window.
async function refreshDots(page) {
  const id = page._dotsId = (page._dotsId || 0) + 1;
  const user = getApp().globalData.user, months = page.data.months;
  page.setData({ statusMap: {} });
  if (!page.data.visible || !user || user.role === "admin" || user.therapistId || !months.length) return;
  const first = months[0].days.find(day => day.date && !day.disabled);
  const last = months[months.length - 1].days.filter(day => day.date && !day.disabled).pop();
  if (!first || !last) return;
  const owner = loginReturn.sessionKey(), session = getApp()._loginSessionVersion;
  const data = await appointments.calendarStatus(first.date, last.date).catch(() => null);
  if (!data || !page.data.visible || page._dotsId !== id || owner !== loginReturn.sessionKey() || session !== getApp()._loginSessionVersion) return;
  const grouped = {}, statusMap = {};
  for (const item of data.statuses) (grouped[item.date] || (grouped[item.date] = [])).push(item.status);
  for (const date of Object.keys(grouped)) statusMap[date] = dates.statusDot(grouped[date]);
  page.setData({ statusMap });
}

module.exports = { nextMonths, refreshDots };
