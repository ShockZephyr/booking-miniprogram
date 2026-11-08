const currentActor = require("./currentActorService");
const db = require("../config/db");
const whitelistRepository = require("../repositories/whitelistRepository");
const auditService = require("./auditService");
const logService = require("./logService");
const { AppError, normalizePgError } = require("../utils/errors");
const { requirePhone } = require("../utils/phone");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validatePhone(phone) {
  if (typeof phone !== "string") {
    throw new AppError("INVALID_PHONE", "请输入 11 位有效手机号", 400);
  }
  return requirePhone(phone);
}

function validateId(id) {
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new AppError("WHITELIST_NOT_FOUND", "白名单成员不存在", 404);
  }
  return id.toLowerCase();
}

function memberInput(input, partial = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("INVALID_REQUEST", "成员信息格式不正确", 400);
  }
  const data = {};
  if (!partial || input.phone !== undefined) data.phone = validatePhone(input.phone);
  if (input.remarkName !== undefined) {
    if (input.remarkName !== null && typeof input.remarkName !== "string") {
      throw new AppError("INVALID_REQUEST", "会员名称需为文字", 400);
    }
    data.remarkName = input.remarkName === null ? null : input.remarkName.trim() || null;
  }
  if (input.status !== undefined) {
    if (!["active", "inactive"].includes(input.status)) {
      throw new AppError("INVALID_REQUEST", "会员状态无效", 400);
    }
    data.status = input.status;
  }
  return data;
}

async function whitelistTransaction(context, handler) {
  try {
    return await db.transaction(async (client) => {
      await currentActor.load(context, client, { admin: true });
      return handler(client);
    });
  } catch (error) {
    throw normalizePgError(error);
  }
}

async function list(filters = {}, paginated = false) {
  const { keyword = "", status = "active" } = filters;
  if (typeof keyword !== "string" || !["active", "inactive", "all"].includes(status)) {
    throw new AppError("INVALID_REQUEST", "白名单筛选条件无效", 400);
  }
  const includeInactiveReview = filters.includeInactiveReview === true || filters.includeInactiveReview === "true";
  const query = { keyword, status, cursor: filters.cursor, includeInactiveReview };
  return paginated ? whitelistRepository.listPage(query) : whitelistRepository.list(query);
}

async function add(input, context) {
  const data = memberInput(input);
  return whitelistTransaction(context, async (client) => {
    const member = await whitelistRepository.upsert(
      { phone: data.phone, remarkName: data.remarkName, createdBy: context.user.id },
      client
    );
    await auditService.record(
      {
        adminUserId: context.user.id,
        action: "add_whitelist_member",
        resourceType: "member_whitelist",
        resourceId: member.id,
        after: member,
        requestId: context.requestId,
        ip: context.ip
      },
      client
    );
    await logService.business(
      {
        userId: context.user.id,
        effectiveRole: "admin",
        action: "add_whitelist_member",
        resourceType: "member_whitelist",
        resourceId: member.id,
        result: "success",
        requestId: context.requestId
      },
      client
    );
    return member;
  });
}

async function update(id, input, context) {
  id = validateId(id);
  const data = memberInput(input, true);
  return whitelistTransaction(context, async (client) => {
    const before = await whitelistRepository.findById(id, client);
    if (before && before.isReviewMember && data.phone !== undefined) {
      throw new AppError("REVIEW_MEMBER_PHONE_LOCKED", "测试会员账号标识不可修改", 400);
    }
    const after = await whitelistRepository.update(id, data, client);
    if (!after) throw new AppError("WHITELIST_NOT_FOUND", "白名单成员不存在", 404);
    await auditService.record(
      {
        adminUserId: context.user.id,
        action: "update_whitelist_member",
        resourceType: "member_whitelist",
        resourceId: id,
        before,
        after,
        requestId: context.requestId,
        ip: context.ip
      },
      client
    );
    return after;
  });
}

async function remove(id, context) {
  id = validateId(id);
  return whitelistTransaction(context, async (client) => {
    const after = await whitelistRepository.softDelete(id, client);
    if (!after) throw new AppError("WHITELIST_NOT_FOUND", "白名单成员不存在", 404);
    await auditService.record(
      {
        adminUserId: context.user.id,
        action: "delete_whitelist_member",
        resourceType: "member_whitelist",
        resourceId: id,
        after,
        requestId: context.requestId,
        ip: context.ip
      },
      client
    );
    return after;
  });
}

async function batchRemove(ids, context) {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw new AppError("INVALID_REQUEST", "请选择有效的白名单成员", 400);
  }
  ids = [...new Set(ids.map((id) => id.toLowerCase()))];
  return whitelistTransaction(context, async (client) => {
    const after = await whitelistRepository.batchSoftDelete(ids, client);
    await auditService.record(
      {
        adminUserId: context.user.id,
        action: "batch_delete_whitelist_members",
        resourceType: "member_whitelist",
        after,
        requestId: context.requestId,
        ip: context.ip
      },
      client
    );
    return after;
  });
}

module.exports = {
  validatePhone,
  list,
  add,
  update,
  remove,
  batchRemove
};
