const { AppError } = require("../utils/errors");
const { logger } = require("../config/logger");

function errorHandler(error, req, res, next) {
  if (error.type === "entity.parse.failed") error = new AppError("INVALID_JSON", "请求内容格式不正确", 400);
  if (error.type === "entity.too.large") error = new AppError("REQUEST_TOO_LARGE", "请求内容过大", 413);
  const isKnown = error instanceof AppError || error.name === "AppError";
  const status = isKnown ? error.status : 500;
  const code = isKnown ? error.code : "INTERNAL_ERROR";
  const message = isKnown ? error.message : "服务暂时不可用，请稍后再试";

  logger.error({
    requestId: req.requestId,
    errorName: error.name,
    errorCode: code,
    message: error.message,
    stack: error.stack,
    route: req.originalUrl,
    userId: req.user && req.user.id,
    effectiveRole: req.user && req.user.effectiveRole
  });

  res.status(status).json({
    success: false,
    code,
    message,
    requestId: req.requestId
  });
}

module.exports = errorHandler;

