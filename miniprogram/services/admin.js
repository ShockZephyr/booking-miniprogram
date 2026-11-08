const request = require("../utils/request");

function appointments(query = {}) {
  const params = [];
  params.push(`status=${encodeURIComponent(query.status || "all")}`);
  params.push(`page=${encodeURIComponent(query.page || 1)}`);
  params.push(`pageSize=${encodeURIComponent(query.pageSize || 20)}`);
  ["serviceItemIds", "therapistIds"].forEach((key) => {
    if (Array.isArray(query[key]) && query[key].length) params.push(`${key}=${encodeURIComponent(query[key].join(","))}`);
  });
  ["unread", "sort", "cursor", "fromDate", "toDate", "startTime", "endTime"].forEach((key) => {
    if (query[key]) params.push(`${key}=${encodeURIComponent(query[key])}`);
  });
  ["includeInactiveServiceItems", "includeInactiveTherapists"].forEach((key) => {
    if (query[key]) params.push(`${key}=${encodeURIComponent(query[key])}`);
  });
  return request({ url: `/api/admin/appointments?${params.join("&")}` });
}

function appointment(id) {
  return request({ url: `/api/admin/appointments/${id}` });
}

function adminCancelAppointment(id) {
  return request({ url: `/api/admin/appointments/${id}/cancel`, method: "PATCH" });
}

function adminCheckInAppointment(id) {
  return request({ url: `/api/admin/appointments/${id}/check-in`, method: "PATCH" });
}

function adminUncheckInAppointment(id) {
  return request({ url: `/api/admin/appointments/${id}/uncheck-in`, method: "PATCH" });
}

function whitelist(query) {
  const params = [];
  if (query && query.keyword) params.push(`keyword=${encodeURIComponent(query.keyword)}`);
  if (query && query.status) params.push(`status=${encodeURIComponent(query.status)}`);
  if (query && query.cursor) params.push(`cursor=${encodeURIComponent(query.cursor)}`);
  return request({ url: `/api/admin/whitelist${params.length ? `?${params.join("&")}` : ""}` });
}

function addWhitelist(data) {
  return request({ url: "/api/admin/whitelist", method: "POST", data });
}

function updateWhitelist(id, data) {
  return request({ url: `/api/admin/whitelist/${id}`, method: "PATCH", data });
}

function deleteWhitelist(id) {
  return request({ url: `/api/admin/whitelist/${id}`, method: "DELETE" });
}

function batchDeleteWhitelist(ids) {
  return request({ url: "/api/admin/whitelist/batch-delete", method: "POST", data: { ids } });
}

module.exports = {
  scheduleSettings: () => request({ url: "/api/admin/schedules/settings" }),
  setScheduleSettings: (daysVisible) => request({ url: "/api/admin/schedules/settings", method: "PATCH", data: { daysVisible } }),
  weekly: (id, weekday) => request({ url: "/api/admin/schedules/weekly/" + encodeURIComponent(id) + "?weekday=" + weekday }),
  saveWeekly: (data) => request({ url: "/api/admin/schedules/weekly", method: "PUT", data }),
  saveWeeklyDays: (id, days) => request({ url: "/api/admin/schedules/weekly/" + encodeURIComponent(id), method: "PUT", data: { days } }),
  appointments,
  appointment,
  adminCancelAppointment,
  adminCheckInAppointment,
  adminUncheckInAppointment,
  whitelist,
  addWhitelist,
  updateWhitelist,
  deleteWhitelist,
  batchDeleteWhitelist
};
