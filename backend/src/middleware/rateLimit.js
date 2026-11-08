const rateLimit = require("express-rate-limit");

function createLimiter(options = {}) {
  return rateLimit({
    windowMs: options.windowMs || 60 * 1000,
    limit: options.limit || 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      code: "RATE_LIMITED",
      message: "请求过于频繁，请稍后再试"
    }
  });
}

module.exports = {
  loginLimiter: createLimiter({ limit: 20 }),
  bookingLimiter: createLimiter({ limit: 30 }),
  adminLimiter: createLimiter({ limit: 120 }),
  clientErrorLimiter: createLimiter({ limit: 30 }),
  createLimiter
};

