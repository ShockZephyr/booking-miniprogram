const request = require("../utils/request");

function queryString(query = {}) {
  return Object.keys(query).reduce((params, key) => {
    const value = query[key];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return params;
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent(Array.isArray(value) ? value.join(",") : value)}`);
    return params;
  }, []).join("&");
}

module.exports = {
  appointments(query) {
    return request({ url: `/api/therapist/appointments?${queryString(query)}` });
  },
  appointment(id, { includeHistory = false } = {}) {
    return request({ url: `/api/therapist/appointments/${id}${includeHistory ? "?includeHistory=1" : ""}` });
  },
  checkIn(id) {
    return request({ url: `/api/therapist/appointments/${id}/check-in`, method: "PATCH" });
  }
};
