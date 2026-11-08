const jwt = require("jsonwebtoken");
const env = require("../config/env");
const db = require("../config/db");
const accounts = require("../repositories/reviewAccountRepository");
const access = require("./accessService");
const logs = require("./logService");
const session = require("./reviewSession");
const lockIdentity = require("../utils/identityLock");
const { AppError } = require("../utils/errors");

function createReviewLoginService(deps = {}) {
  const configuration = deps.env || env;
  const database = deps.db || db;
  const repository = deps.accounts || accounts;
  const enrich = deps.access || access;
  const log = deps.logs || logs;
  const lock = deps.lockIdentity || lockIdentity;
  const now = deps.now || Date.now;
  function availability() { return { testLoginEnabled: session.isEnabled(configuration, now()) }; }
  function requireEnabled() {
    if (!availability().testLoginEnabled) throw new AppError("REVIEW_LOGIN_DISABLED", "测试登录未开启或已结束", 403);
  }
  async function login(input, context = {}) {
    requireEnabled();
    if (!input || Array.isArray(input) || !["user", "admin", "therapist"].includes(input.account)
      || Object.keys(input).some(key => !["account", "reviewCode"].includes(key))) {
      throw new AppError("INVALID_REQUEST", "请选择测试身份并填写审核码", 400);
    }
    if (!session.matchesCode(input.reviewCode, configuration)) {
      throw new AppError("REVIEW_CODE_INVALID", "审核码不正确", 401);
    }
    return database.transaction(async client => {
      await lock(client);
      requireEnabled();
      const account = await repository.findOrCreate(input.account, client);
      session.assertSession(account, session.fingerprint(configuration), configuration, now());
      const user = await enrich.enrichUser(account, client);
      if (!!user.therapistId !== (input.account === "therapist")) {
        throw new AppError("REVIEW_ACCOUNT_CONFLICT", "测试账号身份异常，请联系门店", 409);
      }
      await log.business({ userId: user.id, effectiveRole: user.effectiveRole,
        action: "review_login", result: "success", requestId: context.requestId,
        metadata: { reviewIdentity: account.reviewIdentity } }, client);
      requireEnabled();
      const expires = Math.floor(Math.min(now() + 8 * 3600000, Date.parse(configuration.reviewLogin.expiresAt)) / 1000);
      const token = jwt.sign({ sub: user.id, role: user.role, sv: user.sessionVersion, se: user.sessionEpoch,
        review: session.fingerprint(configuration), exp: expires }, session.signingKey(configuration),
      { algorithm: "HS256", keyid: session.TOKEN_KEY_ID });
      return { token, user };
    }).catch(error => {
      if ((["23505", "23514"].includes(error.code) && error.table === "users")
        || (error.code === "23505" && error.table === "therapists"
          && ["uniq_active_therapist_phone", "uniq_active_therapist_user"].includes(error.constraint))) {
        throw new AppError("REVIEW_ACCOUNT_CONFLICT", "测试账号标识冲突，请联系门店", 409);
      }
      throw error;
    });
  }
  return { availability, login };
}

module.exports = { createReviewLoginService, ...createReviewLoginService() };
