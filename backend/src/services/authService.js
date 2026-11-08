const jwt = require("jsonwebtoken");
const env = require("../config/env");
const db = require("../config/db");
const userRepository = require("../repositories/userRepository");
const accessService = require("./accessService");
const therapistService = require("./therapistService");
const wechatService = require("./wechatService");
const logService = require("./logService");
const { AppError } = require("../utils/errors");
const { requirePhone } = require("../utils/phone");

const IDENTITY_LOCK_KEY = 582302;

function accountConflict(message = "登录身份或手机号已关联其他账号，请联系门店处理") {
  return new AppError("ACCOUNT_IDENTITY_CONFLICT", message, 409);
}

function isIdentityUniqueViolation(error) {
  if (!error || error.code !== "23505") return false;
  const text = `${error.constraint || ""} ${error.detail || ""}`.toLowerCase();
  return text.includes("users") || text.includes("openid") || text.includes("phone");
}

function createAuthService(deps = {}) {
  const database = deps.db || db;
  const users = deps.userRepository || userRepository;
  const access = deps.accessService || accessService;
  const therapists = deps.therapistService || therapistService;
  const wechat = deps.wechatService || wechatService;
  const logs = deps.logService || logService;
  const configuration = deps.env || env;

  function createToken(user) {
    return jwt.sign(
      { sub: user.id, role: user.role, sv: Number(user.sessionVersion || 0), se: user.sessionEpoch || null },
      configuration.jwtSecret,
      { expiresIn: configuration.jwtExpiresIn }
    );
  }

  async function resolveWechatAccount(profile, client) {
    const byOpenid = await users.findByOpenid(profile.openid, client, true);
    const byPhone = await users.findByPhone(profile.phone, client, true);

    if ((byOpenid && byOpenid.reviewIdentity) || (byPhone && byPhone.reviewIdentity)) {
      throw accountConflict("测试账号不能绑定真实登录身份，请联系门店");
    }

    if (byOpenid && byPhone && byOpenid.id !== byPhone.id) {
      throw accountConflict("当前登录身份与手机号分别属于不同账号，请联系门店处理");
    }

    if (byOpenid) {
      const phoneChanged = byOpenid.phone !== profile.phone;
      return users.updateWechatAccount(
        byOpenid.id,
        profile,
        { replaceOpenid: false, bumpSessionVersion: phoneChanged },
        client
      );
    }

    if (byPhone) {
      const protectedAccount = byPhone.role === "admin"
        || await therapists.isUserBound(byPhone.id, client, true)
        || await therapists.isPhoneAssigned(profile.phone, client, true);
      if (protectedAccount) {
        throw accountConflict("该手机号已关联管理员或芳疗师账号，不能自动更换绑定，请联系门店处理");
      }
      return users.updateWechatAccount(
        byPhone.id,
        profile,
        { replaceOpenid: true, bumpSessionVersion: true },
        client
      );
    }

    return users.createFromWechat(profile, client);
  }

  async function loginWithWechat(input, context = {}) {
    const mockEnabled = configuration.wechat.mockLogin && !configuration.isProduction;
    if (!mockEnabled && ["mockOpenid", "mockPhone", "mockRole"].some((key) => input[key] !== undefined)) {
      throw new AppError("MOCK_LOGIN_DISABLED", "当前环境不支持测试登录", 400);
    }
    const loginCode = input.loginCode || input.code;
    if (!loginCode && !configuration.wechat.mockLogin) {
      throw new AppError("LOGIN_CODE_REQUIRED", "登录凭证缺失，请重试", 400);
    }
    const deadline = Date.now() + (configuration.wechat.requestTimeoutMs || 10000);
    const session = await wechat.code2Session(mockEnabled && input.mockOpenid || loginCode, { deadline });
    const openid = String(mockEnabled && input.mockOpenid || session.openid || "").trim();
    if (!openid) throw new AppError("WECHAT_LOGIN_FAILED", "登录失败，请重试", 502);
    const phoneValue = await wechat.getPhoneNumber(input.phoneCode, mockEnabled ? input.mockPhone : undefined, { deadline });
    if (!phoneValue) throw new AppError("PHONE_REQUIRED", "手机号授权未完成，请重试", 400);
    const phone = requirePhone(phoneValue);

    try {
      const user = await database.transaction(async (client) => {
        await database.query(`SELECT pg_advisory_xact_lock(${IDENTITY_LOCK_KEY})`, [], client);
        let account = await resolveWechatAccount({
          openid,
          phone,
          nickname: input.nickname,
          avatarUrl: input.avatarUrl
        }, client);

        const canMockRole = !configuration.isProduction && (configuration.wechat.mockAdmin || mockEnabled);
        if (canMockRole && (input.mockRole === "admin" || input.mockRole === "user")) {
          account = await users.setRoleByPhone(phone, input.mockRole, client);
        }

        await therapists.linkUserForPhone(phone, account, client, context);
        account = await users.findById(account.id, client, true);
        const enriched = await access.enrichUser(account, client);
        await logs.business({
          userId: account.id,
          effectiveRole: enriched.effectiveRole,
          action: account.role === "admin" ? "admin_login" : enriched.therapistId ? "therapist_login" : "login",
          result: "success",
          requestId: context.requestId,
          metadata: { phoneMasked: phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2") }
        }, client);
        return enriched;
      });
      return { token: createToken(user), user };
    } catch (error) {
      if (isIdentityUniqueViolation(error)) throw accountConflict();
      throw error;
    }
  }

  async function getMe(user) {
    return access.enrichUser(user);
  }

  async function logout(user) {
    await database.transaction(async (client) => {
      await database.query(`SELECT pg_advisory_xact_lock(${IDENTITY_LOCK_KEY})`, [], client);
      const current = await users.findById(user.id, client, true);
      if (!current || current.sessionEpoch !== user.sessionEpoch || current.sessionVersion !== user.sessionVersion) {
        throw new AppError("INVALID_SESSION", "登录状态已失效，请重新登录", 401);
      }
      await users.incrementSessionVersion(user.id, client);
    });
  }

  return { loginWithWechat, getMe, logout, createToken, resolveWechatAccount };
}

const defaultService = createAuthService();

module.exports = {
  createAuthService,
  ...defaultService
};
