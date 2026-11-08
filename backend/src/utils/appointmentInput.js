const { AppError } = require("./errors");
const { assertDateString, assertTimeString } = require("./date");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function appointmentId(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new AppError("APPOINTMENT_NOT_FOUND", "预约不存在", 404);
  }
  return value;
}

function appointmentNote(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length > 250) {
    throw new AppError("INVALID_APPOINTMENT_NOTE", "预约备注需为文字，且不超过 250 字", 400);
  }
  return value;
}

function appointmentInput(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("INVALID_APPOINTMENT_INPUT", "预约信息格式不正确", 400);
  }
  const editable = ["startTime", "endTime", "serviceItemId", "serviceItemIds", "note"];
  const allowed = partial ? [...editable, "version"] : [...editable, "date", "therapistId"];
  if (Object.keys(input).some((key) => !allowed.includes(key))
    || (partial && !editable.some((field) => Object.hasOwn(input, field)))) {
    throw new AppError("INVALID_APPOINTMENT_INPUT", "预约包含不支持的字段或缺少修改内容", 400);
  }
  if (Object.hasOwn(input, "serviceItemIds")) {
    if (Object.hasOwn(input, "serviceItemId") || !Array.isArray(input.serviceItemIds) || !input.serviceItemIds.length
      || input.serviceItemIds.some(id => typeof id !== "string" || !UUID.test(id))
      || new Set(input.serviceItemIds.map(id => id.toLowerCase())).size !== input.serviceItemIds.length) {
      throw new AppError("INVALID_APPOINTMENT_INPUT", "请选择至少一个有效项目，项目不可重复", 400);
    }
  }
  for (const field of (partial ? ["serviceItemId"] : ["therapistId", ...(input.serviceItemIds ? [] : ["serviceItemId"])])) {
    if ((input[field] !== undefined || !partial)
      && (typeof input[field] !== "string" || !UUID.test(input[field]))) {
      throw new AppError("INVALID_APPOINTMENT_INPUT", "芳疗师或项目无效", 400);
    }
  }
  if (!partial && !assertDateString(input.date)) throw new AppError("INVALID_DATE", "日期格式不正确", 400);
  for (const field of ["startTime", "endTime"]) {
    if ((!partial || input[field] !== undefined) && !assertTimeString(input[field])) {
      throw new AppError("INVALID_TIME_RANGE", "预约时间格式不正确", 400);
    }
  }
  if (input.startTime && input.endTime && input.startTime >= input.endTime) {
    throw new AppError("INVALID_TIME_RANGE", "结束时间须晚于开始时间", 400);
  }
  if (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1)) {
    throw new AppError("INVALID_APPOINTMENT_INPUT", "预约版本无效", 400);
  }
  appointmentNote(input.note);
  return input;
}

function calendarRange(from, to) {
  if (typeof from !== "string" || typeof to !== "string"
    || !assertDateString(from) || !assertDateString(to) || from > to) {
    throw new AppError("INVALID_DATE", "日期范围无效", 400);
  }
  return { from, to };
}

module.exports = { appointmentId, appointmentNote, appointmentInput, calendarRange };
