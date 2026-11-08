const { AppError } = require("./errors");
const { assertDateString, assertTimeString } = require("./date");
const { parseAppointmentSort } = require("./appointmentSort");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPOINTMENT_STATUSES = new Set(["pending", "checked_in", "cancelled", "all"]);

function list(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function idList(value, label) {
  const values = list(value);
  if (values.length > 50) {
    throw new AppError("INVALID_FILTER", `${label}筛选项过多，请缩小范围`, 400);
  }
  if (values.some((id) => !UUID.test(id))) {
    throw new AppError("INVALID_FILTER", `${label}筛选条件无效`, 400);
  }
  return values;
}

function booleanFlag(value, label) {
  if (value === undefined || value === null || value === "" || value === false || value === "0") return false;
  if (value === true || value === "1" || value === "true") return true;
  throw new AppError("INVALID_FILTER", `${label}筛选条件无效`, 400);
}

function parseAppointmentFilters(query = {}, { therapists = true } = {}) {
  const status = query.status || "all";
  const fromDate = query.fromDate || "";
  const toDate = query.toDate || "";
  const startTime = query.startTime || "";
  const endTime = query.endTime || "";
  if ((fromDate && !assertDateString(fromDate)) || (toDate && !assertDateString(toDate)) || (fromDate && toDate && fromDate > toDate)) {
    throw new AppError("INVALID_FILTER", "日期范围无效", 400);
  }
  if ((startTime && !assertTimeString(startTime)) || (endTime && !assertTimeString(endTime)) || (startTime && endTime && startTime >= endTime)) {
    throw new AppError("INVALID_FILTER", "时间范围无效", 400);
  }
  if (!APPOINTMENT_STATUSES.has(status)) {
    throw new AppError("INVALID_FILTER", "预约状态筛选条件无效", 400);
  }
  return {
    status,
    sort: parseAppointmentSort(query.sort),
    page: query.page,
    cursor: query.cursor,
    pageSize: query.pageSize,
    serviceItemIds: idList(query.serviceItemIds, "项目"),
    therapistIds: therapists ? idList(query.therapistIds, "芳疗师") : [],
    includeInactiveServiceItems: booleanFlag(query.includeInactiveServiceItems, "已停用项目"),
    includeInactiveTherapists: therapists ? booleanFlag(query.includeInactiveTherapists, "已停用芳疗师") : false,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    startTime: startTime || undefined,
    endTime: endTime || undefined
  };
}

module.exports = { parseAppointmentFilters };
