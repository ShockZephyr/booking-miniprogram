const { createHash } = require("node:crypto");
const db = require("../config/db");
const actors = require("./currentActorService");
const repository = require("../repositories/batchCheckInRepository");
const appointments = require("../repositories/appointmentRepository");
const logs = require("./logService");
const audits = require("./auditService");
const metrics = require("./metricsService");
const { parseAppointmentFilters } = require("../utils/appointmentFilters");
const { AppError } = require("../utils/errors");

function normalizedFilters(input, admin) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("INVALID_FILTER", "筛选条件无效", 400);
  }
  const parsed = parseAppointmentFilters({ ...input, status: "pending", sort: undefined }, { therapists: admin });
  const { serviceItemIds, therapistIds, includeInactiveServiceItems, includeInactiveTherapists,
    fromDate, toDate, startTime, endTime } = parsed;
  return { serviceItemIds: serviceItemIds.map(id => id.toLowerCase()).sort(),
    therapistIds: therapistIds.map(id => id.toLowerCase()).sort(), includeInactiveServiceItems,
    includeInactiveTherapists, fromDate, toDate, startTime, endTime };
}

function createBatchCheckInService(deps = {}) {
  const clock = deps.now || repository.now;
  const business = deps.logService || logs;

  async function run(body, context, { admin = false, submit = false } = {}) {
    if (submit && (!body || typeof body.confirmationVersion !== "string" || !/^[a-f0-9]{64}$/.test(body.confirmationVersion))) {
      throw new AppError("INVALID_CONFIRMATION", "请重新确认一键签到", 400);
    }
    const filters = normalizedFilters(body && body.filters || {}, admin);
    try {
      return await db.transaction(async client => {
        const actor = await actors.load(context, client, admin ? { admin: true } : { therapistId: context.user && context.user.therapistId });
        if (!admin && !actor.therapistId) throw new AppError("NOT_THERAPIST", "无芳疗师权限", 403);
        const therapistId = admin ? null : actor.therapistId;
        const checkedInAt = await clock(client);
        const rows = await repository.candidates(filters, therapistId, checkedInAt, client);
        // An optimistic confirmation version, not an authorization token.
        // Authorization and eligibility are always rechecked in this transaction.
        const confirmationVersion = createHash("sha256").update(JSON.stringify([
          actor.id, actor.sessionEpoch, actor.sessionVersion, therapistId, filters,
          rows.map(row => [row.id, row.version])
        ])).digest("hex");
        if (!submit) return { count: rows.length, confirmationVersion };
        if (body.confirmationVersion !== confirmationVersion) {
          throw new AppError("BATCH_CHECK_IN_CHANGED", "可签到预约已变化，请重新确认", 409);
        }
        for (const row of rows) {
          const before = await appointments.findById(row.id, client);
          const after = await appointments.updateStatus(row.id, "checked_in", { checkedInAt }, client);
          if (admin) await audits.record({ adminUserId: actor.id, action: "admin_check_in_user",
            resourceType: "appointment", resourceId: row.id, targetUserId: before.userId,
            before, after, requestId: context.requestId, ip: context.ip }, client);
          await business.business({ userId: actor.id, effectiveRole: admin ? "admin" : "therapist",
            action: admin ? "admin_check_in_user" : "therapist_check_in_user", resourceType: "appointment",
            resourceId: row.id, result: "success", requestId: context.requestId,
            metadata: { batch: true } }, client);
        }
        db.afterCommit(client, () => { if (rows.length) metrics.incrementAppointment("checked_in", rows.length); });
        return { checkedIn: rows.length };
      });
    } catch (error) {
      if (error.code === "23P01") throw new AppError("BATCH_CHECK_IN_CONFLICT", "预约存在时间冲突，本次未签到，请逐笔核对", 409);
      throw error;
    }
  }
  return { preview: (body, context, options) => run(body, context, options),
    submit: (body, context, options) => run(body, context, { ...options, submit: true }) };
}

module.exports = { ...createBatchCheckInService(), createBatchCheckInService };
