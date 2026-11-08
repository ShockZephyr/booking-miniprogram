const jwt = require("jsonwebtoken");
const env = require("../config/env");
const userRepository = require("../repositories/userRepository");
const accessService = require("../services/accessService");
const { AppError, notLoggedIn } = require("../utils/errors");
const reviewSession = require("../services/reviewSession");

async function attachUser(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    if (!header.startsWith("Bearer ")) {
      return next();
    }
    const token = header.slice("Bearer ".length);
    const envelope = jwt.decode(token, { complete: true });
    const keyId = envelope && envelope.header.kid;
    const isReview = keyId === reviewSession.TOKEN_KEY_ID;
    if (keyId && !isReview) throw new AppError("INVALID_SESSION", "登录状态已失效，请重新登录", 401);
    // The untrusted header only selects a key; signature and identity are checked below.
    const decoded = jwt.verify(token, isReview ? reviewSession.signingKey() : env.jwtSecret, { algorithms: ["HS256"] });
    if (isReview !== Boolean(decoded.review)) throw new AppError("INVALID_SESSION", "登录状态已失效，请重新登录", 401);
    const user = await userRepository.findById(decoded.sub);
    if (!user) {
      return next();
    }
    reviewSession.assertSession(user, decoded.review);
    if (!user.sessionEpoch || decoded.se !== user.sessionEpoch
      || Number(decoded.sv || 0) !== Number(user.sessionVersion || 0)) {
      throw new AppError("INVALID_SESSION", "登录状态已失效，请重新登录", 401);
    }
    req.user = await accessService.enrichUser(user);
    if (decoded.review) req.user.reviewSession = decoded.review;
    return next();
  } catch (error) {
    if (["JsonWebTokenError", "TokenExpiredError", "NotBeforeError"].includes(error.name)) {
      return next(new AppError("INVALID_SESSION", "登录状态已失效，请重新登录", 401));
    }
    return next(error);
  }
}

function requireLogin(req, res, next) {
  if (!req.user) return next(notLoggedIn());
  return next();
}

function requireCustomer(req, res, next) {
  if (!req.user) return next(notLoggedIn());
  if (req.user.role === "admin" || req.user.therapistId) {
    return next(new AppError("BOOKING_NOT_ALLOWED", "工作人员账号不能以顾客身份操作预约", 403));
  }
  return next();
}

async function requireMember(req, res, next) {
  try {
    if (!req.user) throw notLoggedIn();
    if (req.user.role === "admin" || req.user.therapistId) {
      throw new AppError("BOOKING_NOT_ALLOWED", "工作人员账号不能以顾客身份预约", 403);
    }
    if (!req.user.capabilities || !req.user.capabilities.bookAppointment) {
      throw new AppError("NOT_MEMBER", "尚未开通会员，请联系门店办理", 403);
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireTherapist(req, res, next) {
  if (!req.user) return next(notLoggedIn());
  if (!req.user.therapistId) {
    return next(new AppError("NOT_THERAPIST", "无芳疗师权限", 403));
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return next(notLoggedIn());
  if (req.user.role !== "admin") {
    return next(new AppError("NOT_ADMIN", "无管理员权限", 403));
  }
  return next();
}

module.exports = {
  attachUser,
  requireLogin,
  requireCustomer,
  requireMember,
  requireAdmin,
  requireTherapist
};
