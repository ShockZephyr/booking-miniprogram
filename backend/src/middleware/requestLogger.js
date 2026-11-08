const { logger } = require("../config/logger");
const metrics = require("../services/metricsService");
const logRepository = require("../repositories/logRepository");
const { sanitizeLogPayload } = require("../utils/privacy");

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  let recorded = false;
  function recordRequest() {
    if (recorded) return;
    recorded = true;
    const aborted = !res.writableFinished;
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const record = sanitizeLogPayload({
      timestamp: new Date().toISOString(),
      requestId: req.requestId,
      method: req.method,
      path: req.route ? req.baseUrl + req.route.path : String(req.originalUrl || "").split("?")[0],
      route: String(req.originalUrl || "").split("?")[0],
      statusCode: aborted ? 499 : res.statusCode,
      aborted,
      durationMs: Number(durationMs.toFixed(2)),
      userId: req.user && req.user.id,
      effectiveRole: req.user && req.user.effectiveRole,
      ip: req.ip,
      userAgent: req.get("user-agent")
    });
    logger.info(record, "http_request");
    metrics.observeHttp(req, { statusCode: record.statusCode }, durationMs);
    logRepository.createHttpRequest(record).catch((error) => {
      logger.warn({ requestId: req.requestId, error: error.message }, "failed_to_persist_http_request_log");
    });
  }
  res.once("finish", recordRequest);
  res.once("close", recordRequest);
  next();
}

module.exports = requestLogger;

