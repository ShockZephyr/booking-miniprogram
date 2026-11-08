const steps = [10, 15, 30];
let nextSaveOrder = 0;
const completedSaves = new Map();

function storageKey() {
  const app = typeof getApp === "function" ? getApp() : null;
  const user = app && app.globalData && app.globalData.user;
  return user && user.role === "admin" && user.id ? "batchSchedule:lastSaved:v1:" + user.id : "";
}

function read(key, therapists, projects) {
  if (!key) return null;
  try {
    const saved = wx.getStorageSync(key);
    if (!saved || saved.version !== 1 || !Array.isArray(saved.therapistIds) || !Array.isArray(saved.weekdays)) return null;
    const hasSchedule = Object.prototype.hasOwnProperty.call(saved, "schedule");
    const hasProjects = Object.prototype.hasOwnProperty.call(saved, "serviceItemIds");
    // Older partial saves cannot supply a complete form once both sections are always submitted.
    if (!hasSchedule || !hasProjects || !Array.isArray(saved.serviceItemIds)) return null;
    const result = {
      therapistIds: [...new Set(saved.therapistIds.filter(id => therapists.some(t => t.id === id)))],
      selectedDays: [...new Set(saved.weekdays.filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b),
      projectIds: [...new Set(saved.serviceItemIds.filter(id => projects.some(p => p.id === id)))]
    };
    if (hasSchedule) {
      const rule = saved.schedule;
      if (!rule || !steps.includes(rule.step) || !Number.isInteger(rule.minDuration)
        || rule.minDuration <= 0 || rule.minDuration > 2147483647 || rule.minDuration % rule.step
        || !Array.isArray(rule.ranges)) return null;
      const validTime = value => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
        && (Number(value.slice(0, 2)) * 60 + Number(value.slice(3))) % rule.step === 0;
      if (rule.ranges.some(r => !r || !validTime(r.startTime) || !validTime(r.endTime) || r.startTime >= r.endTime)) return null;
      const ranges = rule.ranges.map(({ startTime, endTime }) => ({ startTime, endTime }))
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      if (ranges.some((r, i) => i > 0 && r.startTime < ranges[i - 1].endTime)) return null;
      const continuous = [];
      for (const range of ranges) {
        const previous = continuous[continuous.length - 1];
        if (previous && previous.endTime === range.startTime) previous.endTime = range.endTime;
        else continuous.push({ ...range });
      }
      const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
      if (continuous.some(range => minute(range.endTime) - minute(range.startTime) < rule.minDuration)) return null;
      Object.assign(result, { step: rule.step, minDuration: String(rule.minDuration), ranges });
    }
    return result;
  } catch (_) {
    // A missing or unreadable local preference must not prevent editing schedules.
    return null;
  }
}

function beginSave(key) {
  return key ? { key, order: ++nextSaveOrder } : null;
}

function write(save, body) {
  if (!save) return true;
  const { key, order } = save;
  if (order <= (completedSaves.get(key) || 0)) return true;
  // Only successful requests reach here. Record their order even if local storage fails.
  completedSaves.set(key, order);
  try {
    wx.setStorageSync(key, { version: 1, ...body });
    return true;
  } catch (_) {
    // The server save already succeeded; a full device cache is not a business failure.
    return false;
  }
}

module.exports = { storageKey, read, beginSave, write };
