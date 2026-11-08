const fs = require("fs");
const path = require("path");
const os = require("os");
const pino = require("pino");
const env = require("./env");
const { sanitizeLogPayload } = require("../utils/privacy");

const hooks = { logMethod(args, method) { return method.apply(this, args.map((arg) => sanitizeLogPayload(arg))); } };

const logsDir = process.env.NODE_TEST_CONTEXT
  ? path.join(os.tmpdir(), "wechat-booking-test-logs")
  : path.resolve(env.logDirectory || path.join(__dirname, "../../logs"));
fs.mkdirSync(logsDir, { recursive: true });
const destinations = new Map();

function destination(file) {
  const stream = pino.destination(path.join(logsDir, file));
  destinations.set(file, stream);
  return stream;
}

const streams = [
  { level: env.logLevel, stream: env.isProduction ? destination("application.log") : pino.transport({ target: "pino-pretty" }) },
  { level: "error", stream: destination("error.log") }
];

const logger = pino(
  {
    level: env.logLevel,
    hooks,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "*.token", "*.appSecret", "*.jwt", "*.accessToken"],
      censor: "***"
    }
  },
  pino.multistream(streams)
);

const auditLogger = pino(
  {
    level: "info",
    hooks,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime
  },
  destination("audit.log")
);

module.exports = {
  logger,
  auditLogger,
  logsDir,
  destinations
};
