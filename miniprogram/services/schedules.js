const request = require("../utils/request");
const therapistService = require("./therapist");

function decorateDay(day) {
  return Object.assign({}, day, { therapistImageSrc: therapistService.imageUrl(day.therapistImageUrl) });
}

function dayPath(therapistId, date, appointmentId, bookingReturnId = "") {
  const query = "therapistId=" + encodeURIComponent(therapistId) + "&date=" + encodeURIComponent(date);
  return "/pages/schedule-day/index?" + query + (appointmentId ? "&appointmentId=" + encodeURIComponent(appointmentId) : "")
    + (bookingReturnId ? "&from=booking&returnId=" + encodeURIComponent(bookingReturnId) : "");
}

function list(date, filters) {
  const params = ["date=" + encodeURIComponent(date)];
  if (filters) {
    params.push("withFilters=1");
    for (const key of ["serviceItemIds", "therapistIds", "startTime", "endTime"]) {
      const value = Array.isArray(filters[key]) ? filters[key].join(",") : filters[key];
      if (value) params.push(key + "=" + encodeURIComponent(value));
    }
  }
  return request({ url: "/api/schedules?" + params.join("&") });
}

function day(therapistId, date, appointmentId) {
  return request({ url: "/api/schedules/" + encodeURIComponent(therapistId) + "?date=" + encodeURIComponent(date)
    + (appointmentId ? "&appointmentId=" + encodeURIComponent(appointmentId) : "") }).then(decorateDay);
}

function changeDay(therapistId, data) {
  return request({ url: "/api/admin/schedules/day/" + encodeURIComponent(therapistId), method: "PATCH", data });
}

module.exports = { list, day, changeDay, dayPath };
