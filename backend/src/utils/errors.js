class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function notLoggedIn() {
  return new AppError("NOT_LOGGED_IN", "请先登录", 401);
}

function normalizePgError(error) {
  if (error && error.constraint === 'slot_project_active') {
    return new AppError('INVALID_SERVICE_ITEMS', '所选项目不存在或已停用，请重新选择', 409);
  }
  if (error && error.code === "23P01") {
    if (error.constraint === "no_overlapping_appointments_per_therapist") {
      return new AppError("APPOINTMENT_CONFLICT", "该芳疗师在所选时间已有预约，请重新选择", 409);
    }
    if (error.constraint === "no_overlapping_appointments_per_user") {
      return new AppError("APPOINTMENT_CONFLICT", "同一时间已有预约", 409);
    }
    if (error.constraint === "no_overlapping_slots_per_therapist") {
      return new AppError("SLOT_OVERLAP", "该芳疗师在此时间已有排期", 409);
    }
    if ((error.constraint || "").includes("no_overlapping_slots_per_date")) {
      return new AppError("SLOT_OVERLAP", "该时间段与已有时间段重叠", 409);
    }
  }
  if (error && error.code === "23505") {
    if ((error.constraint || "").includes("uniq_appointment_slot")) {
      return new AppError("SLOT_ALREADY_EXISTS", "该时间段已存在", 409);
    }
    if ((error.constraint || "").includes("appointments") || (error.detail || "").includes("slot_id")) {
      return new AppError("SLOT_ALREADY_BOOKED", "该时间段刚刚被其他用户预约", 409);
    }
    if ((error.detail || "").includes("member_whitelist") || (error.constraint || "").includes("member_whitelist")) {
      return new AppError("WHITELIST_PHONE_EXISTS", "该手机号已存在于白名单", 409);
    }
  }
  return error;
}

module.exports = {
  AppError,
  notLoggedIn,
  normalizePgError
};
