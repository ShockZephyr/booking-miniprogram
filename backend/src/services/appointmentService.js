const { projectIds, projectItems, publicRevision } = require("../utils/appointmentProjects");
const db = require("../config/db");
const appointmentRepository = require("../repositories/appointmentRepository");
const scheduleService = require("./scheduleService");
const serviceItemRepository = require("../repositories/serviceItemRepository");
const memberService = require("./memberService");
const logService = require("./logService");
const auditService = require("./auditService");
const metrics = require("./metricsService");
const { createCurrentActorService } = require("./currentActorService");
const { AppError, normalizePgError } = require("../utils/errors");
const { toShanghaiInstant } = require("../utils/date");
const { appointmentInput } = require("../utils/appointmentInput");
const { minutes } = require("../utils/schedule");

function validateInterval(day, selection, original, at) {
  const { startTime, endTime } = selection;
  const start = minutes(startTime), end = minutes(endTime);
  if (start % day.step || end % day.step || end - start < day.minDuration) {
    throw new AppError("INVALID_TIME_RANGE", `预约须对齐 ${day.step} 分钟，时长至少 ${day.minDuration} 分钟`, 409);
  }
  const endAt = toShanghaiInstant(day.date, endTime).getTime();
  if (endAt <= at) throw new AppError("APPOINTMENT_ENDED", "预约结束时间须晚于当前时间", 409);
  const originalStarted = original && toShanghaiInstant(day.date, original.startTime).getTime() <= at;
  if (originalStarted && startTime !== original.startTime) {
    throw new AppError("START_TIME_LOCKED", "预约已开始，不能更改开始时间", 409);
  }
  if (!originalStarted && toShanghaiInstant(day.date, startTime).getTime() + day.step * 60000 <= at) {
    throw new AppError("START_TIME_EXPIRED", "所选开始时间已过，请重新选择", 409);
  }
  if (!day.ranges.some((range) => range.startTime <= startTime && endTime <= range.endTime)
    || day.closed.some((cell) => startTime <= cell && cell < endTime)) {
    throw new AppError("TIME_UNAVAILABLE", "所选时间须在连续开放的排班内", 409);
  }
  if (day.busy.some((range) => range.startTime < endTime && startTime < range.endTime)) {
    throw new AppError("APPOINTMENT_CONFLICT", "所选时间已有预约，请重新选择", 409);
  }
}

function createAppointmentService(deps = {}) {
  const repositories = {
    appointments: deps.appointmentRepository || appointmentRepository,
    serviceItems: deps.serviceItemRepository || serviceItemRepository
  };
  const tx = deps.transaction || db.transaction;
  const membership = deps.memberService || memberService;
  const logs = deps.logService || logService;
  const audits = deps.auditService || auditService;
  const metricClient = deps.metrics || metrics;
  const schedules = deps.scheduleService || scheduleService;
  const now = deps.now || (() => new Date());
  const loadCurrentActor = createCurrentActorService(deps).load;

  function isAppointmentEnded(appointment) {
    return toShanghaiInstant(appointment.date, appointment.endTime) <= now();
  }

  function assertCustomerCanBook(user) {
    if (!user) throw new AppError("NOT_LOGGED_IN", "请先登录", 401);
    if (user && (user.role === "admin" || user.therapistId)) {
      throw new AppError("BOOKING_NOT_ALLOWED", "工作人员账号不能以顾客身份预约", 403);
    }
  }

  async function loadCurrentCustomer(context, client, options = {}) {
    const current = await loadCurrentActor(context, client);
    assertCustomerCanBook(current);
    if (options.requireMembership && !(await membership.isActiveMember(current.phone, client))) {
      throw new AppError("NOT_MEMBER", "尚未开通会员，请联系门店办理", 403);
    }
    return current;
  }

  async function lockAppointment(id, context, client, options = {}) {
    const scope = options.admin ? {} : options.therapistId ? { therapistId: options.therapistId } : { userId: context.user.id };
    const appointment = await repositories.appointments.findByIdForUpdate(id, client, scope);
    if (!appointment || (!options.admin && (options.therapistId
      ? appointment.therapistId !== options.therapistId
      : appointment.userId !== context.user.id))) {
      throw new AppError("APPOINTMENT_NOT_FOUND", "预约不存在", 404);
    }
    return appointment;
  }

  function assertEditable(original, expectedVersion, at) {
    if (expectedVersion !== undefined && expectedVersion !== original.version) {
      throw new AppError("APPOINTMENT_VERSION_CONFLICT", "预约已更新，请重新查看后再修改", 409);
    }
    if (!["booked", "checked_in"].includes(original.status)) {
      throw new AppError("APPOINTMENT_NOT_BOOKED", "该预约当前不能修改", 409);
    }
    if (toShanghaiInstant(original.date, original.endTime).getTime() <= at) {
      throw new AppError("APPOINTMENT_ENDED", "预约已结束，不能修改", 409);
    }
  }

  async function validateSelection(day, input, client, original, expectedVersion) {
    const selectedIds = projectIds(input);
    if (!selectedIds.length) throw new AppError("SERVICE_ITEM_NOT_ALLOWED", "请至少选择一个项目", 400);
    const selected = [];
    for (const id of [...selectedIds].sort()) {
      const item = await repositories.serviceItems.findById(id, client);
      if (!item || item.status !== "active") throw new AppError("SERVICE_ITEM_NOT_FOUND", "预约项目不存在", 404);
      if (!day.serviceItemIds.includes(item.id)) throw new AppError("SERVICE_ITEM_NOT_ALLOWED", "当天不可预约所选项目，请重新选择", 409);
      selected.push(item);
    }
    const prior = original ? projectItems(original) : [];
    const items = prior.filter(item => selectedIds.includes(item.id)).concat(
      selected.filter(item => !prior.some(old => old.id === item.id)).sort((a,b) => (a.sortOrder || 0)-(b.sortOrder || 0) || a.id.localeCompare(b.id))
    ).map(({ id, name }) => ({ id, name }));
    // Recheck after every potentially waiting read, using the same instant for both boundaries.
    const at = now().getTime();
    if (original) assertEditable(original, expectedVersion, at);
    validateInterval(day, input, original, at);
    return items;
  }

  async function createAppointment(input, context) {
    appointmentInput(input);
    try {
      const appointment = await tx(async (client) => {
        const currentUser = await loadCurrentCustomer(context, client, { requireMembership: true });
        const day = await schedules.bookableDay({
          date: input.date, therapistId: input.therapistId, userId: currentUser.id
        }, client);
        const serviceItems = await validateSelection(day, input, client);
        await schedules.freezeDay(day, client);
        const created = await repositories.appointments.create(
          {
            userId: currentUser.id,
            serviceItems, serviceItemId: serviceItems[0].id, serviceItemName: serviceItems[0].name,
            therapistId: day.therapistId,
            therapistName: day.therapistName,
            date: day.date,
            startTime: input.startTime,
            endTime: input.endTime,
            note: input.note
          },
          client
        );
        await logs.business(
          {
            userId: currentUser.id,
            effectiveRole: currentUser.effectiveRole,
            action: "create_appointment",
            resourceType: "appointment",
            resourceId: created.id,
            result: "success",
            requestId: context.requestId,
            metadata: { therapistId: day.therapistId, date: day.date }
          },
          client
        );
        return created;
      });
      metricClient.incrementAppointment("created");
      return appointment;
    } catch (error) {
      throw normalizePgError(error);
    }
  }

  async function cancelAppointment(id, context, options = {}) {
    return tx(async (client) => {
      const currentUser = (!options.admin && !options.therapistId)
        ? await loadCurrentCustomer(context, client)
        : await loadCurrentActor(context, client, options);
      const currentContext = { ...context, user: currentUser };
      const appointment = await lockAppointment(id, currentContext, client, options);
      if (appointment.status === "cancelled") {
        throw new AppError("APPOINTMENT_ALREADY_CANCELLED", "预约已取消", 409);
      }
      if (!["booked", "no_show"].includes(appointment.status)) {
        throw new AppError("APPOINTMENT_NOT_BOOKED", "该预约当前不能取消", 409);
      }
      const updated = await repositories.appointments.updateStatus(
        id,
        "cancelled",
        { cancelledAt: now(), ...(options.admin ? { readByUserId: currentUser.id } : {}) },
        client
      );
      if (options.admin) {
        await audits.record(
          {
            adminUserId: context.user.id,
            action: "admin_cancel_appointment",
            resourceType: "appointment",
            resourceId: id,
            targetUserId: appointment.userId,
            before: appointment,
            after: updated,
            requestId: context.requestId,
            ip: context.ip
          },
          client
        );
      }
      await logs.business(
        {
          userId: currentUser.id,
          effectiveRole: currentUser.effectiveRole,
          action: options.admin ? "admin_cancel_appointment" : "cancel_appointment",
          resourceType: "appointment",
          resourceId: id,
          result: "success",
          requestId: context.requestId
        },
        client
      );
      metricClient.incrementAppointment("cancelled");
      return updated;
    });
  }

  async function getOwnAppointment(id, context, { includeHistory = false } = {}) {
    return tx(async (client) => {
      const user = await loadCurrentCustomer(context, client);
      const appointment = await repositories.appointments.findById(id, client, { userId: user.id });
      if (!appointment || appointment.userId !== user.id) {
        throw new AppError("APPOINTMENT_NOT_FOUND", "预约不存在", 404);
      }
      return includeHistory ? { appointment, history: (await repositories.appointments.listRevisions(id, client)).map(publicRevision) } : appointment;
    });
  }

  async function getAdminAppointment(id, context) {
    return tx(async (client) => {
      await loadCurrentActor(context, client, { admin: true });
      const appointment = await repositories.appointments.findById(id, client);
      if (!appointment) throw new AppError("APPOINTMENT_NOT_FOUND", "预约不存在", 404);
      return { appointment, history: await repositories.appointments.listRevisions(id, client) };
    });
  }

  async function checkInAppointment(id, context, options = {}) {
    return tx(async (client) => {
      const currentUser = (!options.admin && !options.therapistId)
        ? await loadCurrentCustomer(context, client)
        : await loadCurrentActor(context, client, options);
      const currentContext = { ...context, user: currentUser };
      const appointment = await lockAppointment(id, currentContext, client, options);
      if (appointment.status === "checked_in") {
        throw new AppError("APPOINTMENT_ALREADY_CHECKED_IN", "预约已签到", 409);
      }
      if (!["booked", "no_show"].includes(appointment.status)) {
        throw new AppError("APPOINTMENT_NOT_BOOKED", "该预约当前不能签到", 409);
      }
      const checkedInAt = now();
      const opensAt = toShanghaiInstant(appointment.date, appointment.startTime).getTime() - 60 * 60 * 1000;
      if (!Number.isFinite(opensAt) || checkedInAt.getTime() < opensAt) {
        throw new AppError("CHECK_IN_TOO_EARLY", "预约开始前 1 小时开放签到", 409);
      }
      const updated = await repositories.appointments.updateStatus(
        id,
        "checked_in",
        { checkedInAt },
        client
      );
      if (options.admin) {
        await audits.record(
          {
            adminUserId: context.user.id,
            action: "admin_check_in_user",
            resourceType: "appointment",
            resourceId: id,
            targetUserId: appointment.userId,
            before: appointment,
            after: updated,
            requestId: context.requestId,
            ip: context.ip
          },
          client
        );
      }
      await logs.business(
        {
          userId: currentUser.id,
          effectiveRole: currentUser.effectiveRole,
          action: options.admin ? "admin_check_in_user" : options.therapistId ? "therapist_check_in_user" : "check_in",
          resourceType: "appointment",
          resourceId: id,
          result: "success",
          requestId: context.requestId
        },
        client
      );
      metricClient.incrementAppointment("checked_in");
      return updated;
    });
  }

  async function therapistCheckInAppointment(id, context) {
    if (!context.user || !context.user.therapistId) {
      throw new AppError("NOT_THERAPIST", "无芳疗师权限", 403);
    }
    return checkInAppointment(id, context, { therapistId: context.user.therapistId });
  }

  async function uncheckInAppointment(id, context, options = {}) {
    if (!options.admin || !context.user || context.user.role !== "admin") {
      throw new AppError("NOT_ADMIN", "取消签到请联系管理员处理", 403);
    }
    return tx(async (client) => {
      const currentUser = await loadCurrentActor(context, client, options);
      context = { ...context, user: currentUser };
      const appointment = await lockAppointment(id, context, client, options);
      if (appointment.status !== "checked_in") {
        throw new AppError("APPOINTMENT_NOT_CHECKED_IN", "当前预约尚未签到", 409);
      }
      const nextStatus = isAppointmentEnded(appointment) ? "no_show" : "booked";
      const updated = await repositories.appointments.uncheckIn(
        id,
        nextStatus,
        { noShowAt: nextStatus === "no_show" ? now() : null },
        client
      );
      if (options.admin) {
        await audits.record(
          {
            adminUserId: context.user.id,
            action: "admin_uncheck_in_user",
            resourceType: "appointment",
            resourceId: id,
            targetUserId: appointment.userId,
            before: appointment,
            after: updated,
            requestId: context.requestId,
            ip: context.ip
          },
          client
        );
      }
      await logs.business(
        {
          userId: context.user.id,
          effectiveRole: context.user.effectiveRole,
          action: "admin_uncheck_in_user",
          resourceType: "appointment",
          resourceId: id,
          result: "success",
          requestId: context.requestId,
          metadata: { nextStatus }
        },
        client
      );
      return updated;
    });
  }

  async function modifyAppointment(id, input, context) {
    appointmentInput(input, { partial: true });
    try {
      return await tx(async (client) => {
        const currentUser = await loadCurrentCustomer(context, client, { requireMembership: true });
        const currentContext = { ...context, user: currentUser };
        const snapshot = await repositories.appointments.findById(id, client, { userId: currentUser.id });
        if (!snapshot || snapshot.userId !== currentUser.id) {
          throw new AppError("APPOINTMENT_NOT_FOUND", "预约不存在", 404);
        }
        assertEditable(snapshot, input.version, now().getTime());
        // All scheduling operations take the identity lock, then the therapist
        // row. Acquire the appointment row last and verify the snapshot again.
        const day = await schedules.bookableDay({
          date: snapshot.date, therapistId: snapshot.therapistId, userId: currentUser.id, appointmentId: id
        }, client);
        const original = await lockAppointment(id, currentContext, client);
        if (projectIds(original).length > 1 && !Object.hasOwn(input, "serviceItemIds")) {
          throw new AppError("CLIENT_UPDATE_REQUIRED", "此预约包含多个项目，请更新小程序后再修改", 409);
        }
        const selection = { ...original, ...input,
          serviceItemIds: input.serviceItemIds ? projectIds(input) : (input.serviceItemId ? [input.serviceItemId.toLowerCase()] : projectIds(original)) };
        const serviceItems = await validateSelection(day, selection, client, original, snapshot.version);
        const unchangedProjects = [...projectIds(original)].sort().join() === [...selection.serviceItemIds].sort().join();
        if (selection.startTime === original.startTime && selection.endTime === original.endTime
          && unchangedProjects && (selection.note || "") === (original.note || "")) return original;
        const edited = await repositories.appointments.edit(id, { ...selection, serviceItems,
          serviceItemId: serviceItems[0].id, serviceItemName: serviceItems[0].name }, client);
        await repositories.appointments.recordRevision(original, edited, currentUser.id, client);
        await logs.business(
          {
            userId: currentUser.id,
            effectiveRole: currentUser.effectiveRole,
            action: "modify_appointment",
            resourceType: "appointment",
            resourceId: id,
            result: "success",
            requestId: context.requestId,
            metadata: { version: edited.version }
          },
          client
        );
        return edited;
      });
    } catch (error) {
      throw normalizePgError(error);
    }
  }

  return {
    getOwnAppointment,
    getAdminAppointment,
    createAppointment,
    cancelAppointment,
    checkInAppointment,
    therapistCheckInAppointment,
    uncheckInAppointment,
    modifyAppointment
  };
}

const defaultService = createAppointmentService();

module.exports = {
  createAppointmentService,
  ...defaultService
};
