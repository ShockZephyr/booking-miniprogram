const request = require("../utils/request");
const loginReturn = require("../utils/loginReturn");
const pendingCancellations = new Map();

function create(data) {
  return request({ url: "/api/appointments", method: "POST", data });
}

function modify(id, data) {
  return request({ url: `/api/appointments/${id}/modify`, method: "PATCH", data });
}

function queryString(query = {}) {
  return Object.keys(query).reduce((params, key) => {
    const value = query[key];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return params;
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent(Array.isArray(value) ? value.join(",") : value)}`);
    return params;
  }, []).join("&");
}

function my(status, query = {}) {
  const params = Object.assign({}, query, {
    status: status || "all",
    page: query.page || 1,
    pageSize: query.pageSize || 20
  });
  return request({ url: `/api/appointments/my?${queryString(params)}` });
}

function calendarStatus(from, to) {
  return request({ url: `/api/appointments/calendar-status?from=${from}&to=${to}` });
}

function filterOptions() {
  return request({ url: "/api/appointments/filter-options" });
}

function cancel(id) {
  // Re-entering a list/detail while a request is pending must not send it again.
  // Failed/unknown requests are never automatically replayed here.
  const app = typeof getApp === "function" ? getApp() : null;
  const key = JSON.stringify([loginReturn.sessionKey(), app && app._loginSessionVersion || 0, id]);
  if (pendingCancellations.has(key)) return pendingCancellations.get(key);
  const pending = request({ url: `/api/appointments/${id}/cancel`, method: "PATCH" })
    .finally(() => { if (pendingCancellations.get(key) === pending) pendingCancellations.delete(key); });
  pendingCancellations.set(key, pending);
  return pending;
}

function checkIn(id) {
  return request({ url: `/api/appointments/${id}/check-in`, method: "PATCH" });
}

module.exports = {
  detail(id, options = {}) { return request({ url: `/api/appointments/${id}${options.includeHistory ? "?includeHistory=1" : ""}` }); },
  create,
  modify,
  my,
  calendarStatus,
  filterOptions,
  cancel,
  checkIn
};
