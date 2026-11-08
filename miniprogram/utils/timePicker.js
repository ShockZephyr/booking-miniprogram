function pad(value) {
  return String(value).padStart(2, "0");
}

const hours = Array.from({ length: 24 }, (_, index) => `${pad(index)} 时`);
const minutes = Array.from({ length: 60 }, (_, index) => `${pad(index)} 分`);
const range = [hours, minutes];

function normalizeTime(time, fallback = "09:00") {
  const value = String(time || fallback);
  const match = value.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return fallback;
  const hour = Math.min(Math.max(Number(match[1]), 0), 23);
  const minute = Math.min(Math.max(Number(match[2]), 0), 59);
  return `${pad(hour)}:${pad(minute)}`;
}

function valueFromTime(time) {
  const normalized = normalizeTime(time);
  const parts = normalized.split(":").map(Number);
  return [parts[0], parts[1]];
}

function timeFromValue(value) {
  const parts = Array.isArray(value) ? value.map(Number) : [9, 0];
  return `${pad(parts[0] || 0)}:${pad(parts[1] || 0)}`;
}

module.exports = {
  range,
  normalizeTime,
  valueFromTime,
  timeFromValue
};
