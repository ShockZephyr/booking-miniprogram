const crypto = require("node:crypto");
const env = require("../config/env");
const { AppError } = require("../utils/errors");

const TOKEN_KEY_ID = "booking-review-v1";

// Separate trust domain: a backend predating review login cannot verify these tokens.
function signingKey(configuration = env) {
  return crypto.createHmac("sha256", configuration.jwtSecret)
    .update("booking:review-session:signing:v1").digest("hex");
}

function isEnabled(configuration = env, now = Date.now()) {
  const review = configuration.reviewLogin || {};
  return review.enabled === true && typeof review.code === "string" && review.code.length >= 32
    && Number.isFinite(Date.parse(review.expiresAt)) && Date.parse(review.expiresAt) > now;
}

function fingerprint(configuration = env) {
  const review = configuration.reviewLogin || {};
  return crypto.createHmac("sha256", configuration.jwtSecret)
    .update(JSON.stringify(["review-login", review.code, review.expiresAt])).digest("hex");
}

function matchesCode(code, configuration = env) {
  if (typeof code !== "string" || code.length > 128) return false;
  const digest = value => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(code), digest(configuration.reviewLogin.code));
}

function assertSession(user, session, configuration = env, now = Date.now()) {
  if (!user.reviewIdentity && !session) return;
  if (!isEnabled(configuration, now) || !user.reviewIdentity || !session
    || !["user", "admin", "therapist"].includes(user.reviewIdentity)
    || user.role !== (user.reviewIdentity === "admin" ? "admin" : "user")
    || user.openid !== `review:${user.reviewIdentity}` || user.phone !== `review:${user.reviewIdentity}`
    || session !== fingerprint(configuration)) {
    throw new AppError("INVALID_SESSION", "测试登录已关闭或失效，请使用手机号登录", 401);
  }
}

module.exports = { TOKEN_KEY_ID, signingKey, isEnabled, fingerprint, matchesCode, assertSession };
