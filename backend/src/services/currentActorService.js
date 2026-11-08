const userRepository = require("../repositories/userRepository");
const accessService = require("./accessService");
const acquireIdentityLock = require("../utils/identityLock");
const { AppError } = require("../utils/errors");
const reviewSession = require("./reviewSession");

function createCurrentActorService(deps = {}) {
  const users = deps.userRepository || userRepository;
  const access = deps.accessService || accessService;
  const lock = deps.acquireIdentityLock || acquireIdentityLock;

  async function load(context, client, options = {}) {
    if (!context.user) throw new AppError("NOT_LOGGED_IN", "请先登录", 401);
    // Hold identity and user locks through the protected read/write, so a queued
    // request cannot cross a committed rebind, role change or session revocation.
    await lock(client);
    const stored = await users.findById(context.user.id, client, true);
    const current = stored && await access.enrichUser(stored, client);
    if (!current || (context.user.sessionEpoch !== undefined && current.sessionEpoch !== context.user.sessionEpoch)
      || (context.user.sessionVersion !== undefined && Number(current.sessionVersion) !== Number(context.user.sessionVersion))) {
      throw new AppError("INVALID_SESSION", "登录状态已失效，请重新登录", 401);
    }
    reviewSession.assertSession(current, context.user.reviewSession);
    if (context.user.reviewSession) current.reviewSession = context.user.reviewSession;
    if (options.admin && current.role !== "admin") throw new AppError("NOT_ADMIN", "无管理员权限", 403);
    if (options.therapistId && current.therapistId !== options.therapistId) {
      throw new AppError("NOT_THERAPIST", "无芳疗师权限", 403);
    }
    return current;
  }
  return { load };
}

module.exports = { createCurrentActorService, ...createCurrentActorService() };
