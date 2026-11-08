const env = require("../config/env");

const SHANGHAI_OFFSET = "+08:00";

function todayString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: env.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function toShanghaiInstant(dateString, timeString) {
  return new Date(`${dateString}T${timeString}:00${SHANGHAI_OFFSET}`);
}

function formatShanghaiDateTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23"
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function isSlotExpired(slot, now = new Date()) {
  const cutoffTime = slot.startTime || slot.start_time || slot.endTime || slot.end_time;
  return toShanghaiInstant(slot.date, cutoffTime) <= now;
}

function assertDateString(value) {
  if (typeof value !== "string") return false;
  const text = value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  if (text.startsWith("0000-")) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function assertTimeString(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function compareTime(a, b) {
  return String(a).localeCompare(String(b));
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  const current = new Date(`${startDate}T00:00:00${SHANGHAI_OFFSET}`);
  const end = new Date(`${endDate}T00:00:00${SHANGHAI_OFFSET}`);
  while (current <= end) {
    dates.push(todayString(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

module.exports = {
  todayString,
  toShanghaiInstant,
  formatShanghaiDateTime,
  isSlotExpired,
  assertDateString,
  assertTimeString,
  compareTime,
  enumerateDates
};
