const logRepository = require("../repositories/logRepository");
const { sanitizeErrorPayload } = require("../utils/privacy");
const { AppError } = require("../utils/errors");

function textField(value, limit) {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new AppError("INVALID_CLIENT_ERROR", "异常上报字段格式无效", 400);
  return value.slice(0, limit);
}

async function report(input, context) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("INVALID_CLIENT_ERROR", "异常上报格式无效", 400);
  }
  const sourceRequestId = textField(input.sourceRequestId, 128);
  if (sourceRequestId && !/^[A-Za-z0-9_.:/-]{1,128}$/.test(sourceRequestId)) {
    throw new AppError("INVALID_CLIENT_ERROR", "来源请求编号无效", 400);
  }
  const systemInfo = {};
  if (input.systemInfo && (typeof input.systemInfo !== "object" || Array.isArray(input.systemInfo))) {
    throw new AppError("INVALID_CLIENT_ERROR", "设备信息格式无效", 400);
  }
  for (const key of ["brand", "model", "platform", "system", "version", "SDKVersion", "language", "pixelRatio", "screenWidth", "screenHeight", "windowWidth", "windowHeight"]) {
    const value = input.systemInfo && input.systemInfo[key];
    if (typeof value === "string") systemInfo[key] = value.slice(0, 128);
    else if (typeof value === "number" && Number.isFinite(value)) systemInfo[key] = value;
  }
  const sanitized = sanitizeErrorPayload({
    page: textField(input.page, 256), message: textField(input.message, 2048),
    stack: textField(input.stack, 8192), appVersion: textField(input.appVersion, 64), systemInfo
  });
  return logRepository.createClientError({
    userId: context.user && context.user.id,
    effectiveRole: context.user && context.user.effectiveRole,
    page: sanitized.page,
    message: sanitized.message || "unknown client error",
    stack: sanitized.stack,
    appVersion: sanitized.appVersion,
    systemInfo: sanitized.systemInfo,
    requestId: context.requestId,
    sourceRequestId
  });
}

module.exports = {
  report
};

