const { createHash } = require("node:crypto");
const db = require("../config/db");
const currentActor = require("./currentActorService");
const repository = require("../repositories/therapistRepository");
const serviceItems = require("../repositories/serviceItemRepository");
const users = require("../repositories/userRepository");
const appointments = require("../repositories/appointmentRepository");
const schedules = require("../repositories/scheduleRepository");
const audits = require("./auditService");
const logs = require("./logService");
const images = require("./therapistImageService");
const { AppError } = require("../utils/errors");
const { requirePhone, maskPhone } = require("../utils/phone");

function publicView(item) {
  if (!item) return null;
  const { phone, userId, linkedAt, accountLinked, bindingVersion, ...publicItem } = item;
  return publicItem;
}

function auditView(item) {
  if (!item) return null;
  return { ...publicView(item), phoneMasked: item.phone ? maskPhone(item.phone) : "", accountLinked: !!item.userId };
}

function validateId(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || ""))) {
    throw new AppError("THERAPIST_REQUIRED", "请选择芳疗师", 400);
  }
}
function restoreIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id || "")))) {
    throw new AppError("INVALID_THERAPIST_RESTORE", "请选择要恢复的芳疗师", 400);
  }
  return [...new Set(ids)];
}
async function active(id, client, lock = false) {
  validateId(id);
  const item = await repository.findById(id, client, lock);
  if (!item || item.status !== "active") throw new AppError("THERAPIST_NOT_FOUND", "芳疗师不存在或已删除", 404);
  return item;
}

async function list(client) {
  return (await repository.list(client)).map(publicView);
}

async function detail(id, client) {
  return publicView(await active(id, client));
}

async function adminDetail(id, client) {
  return editorView(await active(id, client));
}

function editorView(item) {
  return { ...item, isReviewTherapist: item.phone === "review:therapist", specialtiesVersion: specialtiesVersion(item.serviceItemIds) };
}

function specialtiesVersion(ids) {
  return createHash("sha256").update(JSON.stringify([...new Set(ids)].sort())).digest("hex");
}

async function validate(input, client, { allowUnchangedSpecialties = false, reviewTherapist = false } = {}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const bio = typeof input.bio === "string" ? input.bio.trim() : "";
  const phone = reviewTherapist && input.phone === "review:therapist" ? input.phone : requirePhone(input.phone);
  if (!name || name.length > 40 || bio.length > 3000) throw new AppError("INVALID_THERAPIST", "名称需为 1–40 字，简介不超过 3000 字", 400);
  const hasSpecialties = Object.hasOwn(input, "serviceItemIds");
  if ((!hasSpecialties && !allowUnchangedSpecialties)
      || (hasSpecialties && (!Array.isArray(input.serviceItemIds) || input.serviceItemIds.some((id) => typeof id !== "string")))) {
    throw new AppError("INVALID_TAGS", "请选择有效的擅长项目", 400);
  }
  if (!/^\/uploads\/therapists\/[0-9a-f-]+\.(jpg|png|webp)$/.test(input.imageUrl || "")) {
    throw new AppError("INVALID_IMAGE", "请先上传芳疗师图片", 400);
  }
  const ids = hasSpecialties ? [...new Set(input.serviceItemIds)] : undefined;
  if (hasSpecialties) {
    const activeIds = new Set((await serviceItems.listActive(client)).map((item) => item.id));
    if (ids.some((id) => !activeIds.has(id))) {
      throw new AppError("INVALID_TAGS", "所选项目不存在，请重新选择", 400);
    }
  }
  return { name, bio, phone, serviceItemIds: ids, imageUrl: input.imageUrl };
}


async function cancelFutureCustomerAppointments(userId, client) {
  if (!userId) return [];
  const future = await appointments.listFutureEffectiveByUser(userId, client);
  const cancelled = [];
  for (const appointment of future) {
    const updated = await appointments.updateStatus(appointment.id, "cancelled", { cancelledAt: new Date() }, client);
    cancelled.push(updated);
  }
  return cancelled;
}

async function linkUserForPhone(phone, user, client, context = {}) {
  const current = await repository.findActiveByUserId(user.id, client, true);
  const therapist = await repository.findActiveByPhone(phone, client, true);
  let identityChanged = false;
  if (therapist && therapist.userId && therapist.userId !== user.id) {
    throw new AppError("THERAPIST_ACCOUNT_CONFLICT", "该芳疗师手机号已绑定其他账号，请联系管理员", 409);
  }
  if (current && (!therapist || current.id !== therapist.id)) {
    await repository.unbindUser(current.id, client);
    identityChanged = true;
    await logs.business({
      userId: user.id,
      effectiveRole: user.role === "admin" ? "admin" : "user",
      action: "unlink_therapist_account",
      resourceType: "therapist",
      resourceId: current.id,
      result: "success",
      requestId: context.requestId,
      metadata: { reason: "authorized_phone_changed" }
    }, client);
  }
  if (!therapist) {
    if (identityChanged) await users.incrementSessionVersion(user.id, client);
    return { therapist: null, cancelledAppointments: [] };
  }
  const linked = therapist.userId === user.id ? therapist : await repository.bindUser(therapist.id, user.id, client);
  if (therapist.userId !== user.id) identityChanged = true;
  const cancelledAppointments = await cancelFutureCustomerAppointments(user.id, client);
  if (therapist.userId !== user.id || cancelledAppointments.length) {
    await logs.business({
      userId: user.id,
      effectiveRole: user.role === "admin" ? "admin" : "therapist",
      action: therapist.userId !== user.id ? "link_therapist_account" : "cancel_therapist_customer_appointments",
      resourceType: "therapist",
      resourceId: therapist.id,
      result: "success",
      requestId: context.requestId,
      metadata: { cancelledAppointmentIds: cancelledAppointments.map((item) => item.id) }
    }, client);
  }
  if (identityChanged) await users.incrementSessionVersion(user.id, client);
  return { therapist: linked, cancelledAppointments };
}

async function isUserBound(userId, client, lock = false) {
  return !!await repository.findActiveByUserId(userId, client, lock);
}

async function isPhoneAssigned(phone, client, lock = false) {
  return !!await repository.findActiveByPhone(phone, client, lock);
}

async function save(id, input, context) {
  return db.transaction(async (client) => {
    await currentActor.load(context, client, { admin: true });
    const fields = ["name", "phone", "bio", "imageUrl", "serviceItemIds"];
    if (id) fields.push("bindingVersion", "specialtiesVersion");
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => !fields.includes(key)) ||
        ["name", "bio", "phone", "imageUrl"].some(key =>
          Object.hasOwn(input, key) && typeof input[key] !== "string") ||
        ["bindingVersion", "specialtiesVersion"].some(key => input[key] !== undefined && typeof input[key] !== "string") ||
        (Object.hasOwn(input, "bindingVersion") && !Object.hasOwn(input, "phone")) ||
        (Object.hasOwn(input, "specialtiesVersion") && !Object.hasOwn(input, "serviceItemIds"))) {
      throw new AppError("INVALID_THERAPIST", "芳疗师资料字段无效", 400);
    }
    const before = id ? await active(id, client, true) : null;
    if (before?.phone === "review:therapist" && Object.hasOwn(input, "phone") && input.phone !== before.phone) {
      throw new AppError("REVIEW_THERAPIST_PHONE_LOCKED", "测试芳疗师账号不可换绑手机号", 400);
    }
    if (before && !Object.keys(input).length) return { ...editorView(before), cancelledAppointments: 0 };
    const profile = before ? { name: before.name, bio: before.bio, imageUrl: before.imageUrl, phone: before.phone, ...input } : input;
    const data = await validate(profile, client, { allowUnchangedSpecialties: !!id, reviewTherapist: before?.phone === "review:therapist" });
    if (before && (data.phone !== before.phone || Object.hasOwn(input, "bindingVersion")) &&
        input.bindingVersion !== before.bindingVersion) {
      throw new AppError("THERAPIST_BINDING_CHANGED", "账号绑定已变化，请重新打开编辑页后确认", 409);
    }
    const tagsChanged = data.serviceItemIds !== undefined && before &&
      specialtiesVersion(data.serviceItemIds) !== specialtiesVersion(before.serviceItemIds);
    if (tagsChanged
        && input.specialtiesVersion !== specialtiesVersion(before.serviceItemIds)) {
      throw new AppError("THERAPIST_SPECIALTIES_CHANGED", "擅长项目已变化，请重新打开编辑页后保存", 409);
    }
    if (before && !tagsChanged && ["name", "bio", "phone", "imageUrl"].every(key => data[key] === before[key])) {
      return { ...editorView(before), cancelledAppointments: 0 };
    }
    await images.assertExists(data.imageUrl);
    const duplicate = await repository.findActiveByPhone(data.phone, client, true);
    if (duplicate && duplicate.id !== id) {
      throw new AppError("THERAPIST_PHONE_EXISTS", "该手机号已绑定其他芳疗师", 409);
    }
    // A profile-only PATCH must preserve even an as-yet unbound profile.
    const bindingChanged = !before || data.phone !== before.phone;
    const matchingUser = bindingChanged ? await users.findByPhone(data.phone, client) : null;
    const linkedTherapist = matchingUser
      ? await repository.findActiveByUserId(matchingUser.id, client, true)
      : null;
    if (linkedTherapist && linkedTherapist.id !== id) {
      throw new AppError("THERAPIST_ACCOUNT_EXISTS", "该手机号对应账号已绑定其他芳疗师，请先检查原芳疗师资料", 409);
    }
    // Profile-only edits retain the current associations, including projects
    // restored after the editor opened. Explicit tag edits use the snapshot above.
    const recoverableIds = id ? await repository.recoverableServiceItemIds(id, client) : [];
    const after = await repository.save(id, {
      ...data,
      serviceItemIds: [...new Set([...(data.serviceItemIds === undefined ? before.serviceItemIds : data.serviceItemIds), ...recoverableIds])],
      userId: bindingChanged ? matchingUser?.id : before.userId
    }, client);
    if (!id) {
      // Only creation initializes the week. Profile edits and recycle-bin restores
      // must never reopen rest days or replace the administrator's actual rules.
      for (let weekday = 1; weekday <= 7; weekday++) {
        await schedules.saveWeekly(after.id, weekday, {
          step: 30, minDuration: 90, serviceItemIds: [],
          ranges: [
            { startTime: "09:00", endTime: "12:00" },
            { startTime: "12:30", endTime: "15:00" },
            { startTime: "15:30", endTime: "18:00" },
            { startTime: "18:30", endTime: "20:30" }
          ]
        }, client);
      }
    }
    const changedUserIds = [...new Set([before && before.userId, after && after.userId].filter(Boolean))];
    if (!before || before.userId !== after.userId) {
      for (const userId of changedUserIds) await users.incrementSessionVersion(userId, client);
    }
    const cancelledAppointments = matchingUser && before?.userId !== after.userId
      ? await cancelFutureCustomerAppointments(matchingUser.id, client)
      : [];
    await audits.record({ adminUserId: context.user.id, action: id ? "update_therapist" : "create_therapist",
      resourceType: "therapist", resourceId: after.id, before: auditView(before),
      after: { ...auditView(after), cancelledAppointmentIds: cancelledAppointments.map((item) => item.id) },
      requestId: context.requestId, ip: context.ip }, client);
    return { ...editorView(after), cancelledAppointments: cancelledAppointments.length };
  });
}
async function remove(id, context) {
  return db.transaction(async (client) => {
    await currentActor.load(context, client, { admin: true });
    const before = await active(id, client, true);
    const { rows } = await db.query(`SELECT a.id FROM appointments a
      WHERE a.therapist_id=$1 AND a.status IN ('booked','checked_in')
      AND (a.date + a.end_time) AT TIME ZONE 'Asia/Shanghai' > clock_timestamp() LIMIT 1`, [id], client);
    if (rows.length) throw new AppError("THERAPIST_HAS_APPOINTMENTS", "芳疗师有未结束预约，暂不能删除", 409);
    await schedules.disableTherapist(id, client);
    await db.query("UPDATE therapists SET status='deleted', updated_at=now() WHERE id=$1", [id], client);
    if (before.userId) await users.incrementSessionVersion(before.userId, client);
    await audits.record({ adminUserId: context.user.id, action: "delete_therapist", resourceType: "therapist",
      resourceId: id, before: auditView(before), after: { ...auditView(before), status: "deleted" }, requestId: context.requestId, ip: context.ip }, client);
    return { deleted: true };
  });
}
async function recycleBin() {
  return (await repository.listDeleted()).map(publicView);
}
async function restore(ids, context) {
  const selectedIds = restoreIds(ids);
  try {
    return await db.transaction(async (client) => {
      await currentActor.load(context, client, { admin: true });
      const locked = await repository.listDeletedByIdsForUpdate(selectedIds, client);
      if (locked.length !== selectedIds.length) {
        throw new AppError("THERAPIST_RECYCLE_BIN_CHANGED", "芳疗师状态已变化，请刷新后重试", 409);
      }
      const byId = new Map(locked.map((item) => [item.id, item]));
      let sortOrder = await repository.maxActiveSortOrder(client);
      const restored = [];
      for (const id of selectedIds) {
        const before = byId.get(id);
        const duplicatePhone = before.phone
          ? await repository.findActiveByPhone(before.phone, client, true)
          : null;
        if (duplicatePhone) {
          throw new AppError("THERAPIST_PHONE_EXISTS", `芳疗师“${before.name}”的手机号已被其他芳疗师使用`, 409);
        }
        const matchingUser = before.phone ? await users.findByPhone(before.phone, client, true) : null;
        const linkedTherapist = matchingUser
          ? await repository.findActiveByUserId(matchingUser.id, client, true)
          : null;
        if (linkedTherapist) {
          throw new AppError("THERAPIST_ACCOUNT_EXISTS", `芳疗师“${before.name}”对应账号已绑定其他芳疗师`, 409);
        }
        const after = await repository.restore(id, {
          sortOrder: ++sortOrder,
          userId: matchingUser && matchingUser.id
        }, client);
        if (!after) throw new AppError("THERAPIST_RECYCLE_BIN_CHANGED", "芳疗师状态已变化，请刷新后重试", 409);
        const changedUserIds = [...new Set([before.userId, after.userId].filter(Boolean))];
        for (const userId of changedUserIds) await users.incrementSessionVersion(userId, client);
        const cancelledAppointments = matchingUser
          ? await cancelFutureCustomerAppointments(matchingUser.id, client)
          : [];
        await audits.record({
          adminUserId: context.user.id,
          action: "restore_therapist",
          resourceType: "therapist",
          resourceId: id,
          before: auditView(before),
          after: { ...auditView(after), cancelledAppointmentIds: cancelledAppointments.map((item) => item.id) },
          requestId: context.requestId,
          ip: context.ip
        }, client);
        restored.push(publicView(after));
      }
      return { restored: restored.length, therapists: restored };
    });
  } catch (error) {
    if (error && error.code === "23505") {
      throw new AppError("THERAPIST_RESTORE_CONFLICT", "芳疗师手机号或账号已被占用，请刷新后重试", 409);
    }
    throw error;
  }
}
async function purge(ids, context) {
  const selectedIds = restoreIds(ids);
  return db.transaction(async (client) => {
    await currentActor.load(context, client, { admin: true });
    const locked = await repository.listDeletedByIdsForUpdate(selectedIds, client);
    if (locked.length !== selectedIds.length) {
      throw new AppError("THERAPIST_RECYCLE_BIN_CHANGED", "芳疗师状态已变化，请刷新后重试", 409);
    }
    const byId = new Map(locked.map((item) => [item.id, item]));
    for (const id of selectedIds) {
      const before = byId.get(id);
      const after = await repository.purge(id, client);
      if (!after) throw new AppError("THERAPIST_RECYCLE_BIN_CHANGED", "芳疗师状态已变化，请刷新后重试", 409);
      await audits.record({
        adminUserId: context.user.id,
        action: "purge_therapist",
        resourceType: "therapist",
        resourceId: id,
        before: auditView(before),
        after: auditView(after),
        requestId: context.requestId,
        ip: context.ip
      }, client);
    }
    return { purged: selectedIds.length };
  });
}
module.exports = {
  list,
  recycleBin,
  detail,
  adminDetail,
  active,
  save,
  remove,
  restore,
  purge,
  validate,
  validateId,
  publicView,
  isUserBound,
  isPhoneAssigned,
  linkUserForPhone,
  cancelFutureCustomerAppointments
};
