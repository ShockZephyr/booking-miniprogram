const { publicRevision } = require("../utils/appointmentProjects");
const appointmentRepository = require("../repositories/appointmentRepository");
const appointmentService = require("./appointmentService");
const noShowService = require("./noShowService");
const db = require("../config/db");
const currentActorService = require("./currentActorService");
const { AppError } = require("../utils/errors");
const { maskPhone } = require("../utils/phone");
const { parseAppointmentFilters } = require("../utils/appointmentFilters");
const { appointmentId: validateAppointmentId } = require("../utils/appointmentInput");

function safeAppointment(item) {
  if (!item) return null;
  const { userId, ...safe } = item;
  return { ...safe, userPhone: item.userPhone ? maskPhone(item.userPhone) : null };
}

function requireAssignedTherapist(user) {
  if (!user || !user.therapistId) throw new AppError("NOT_THERAPIST", "无芳疗师权限", 403);
  return user.therapistId;
}

function createTherapistPortalService(deps = {}) {
  const appointments = deps.appointmentRepository || appointmentRepository;
  const appointmentActions = deps.appointmentService || appointmentService;
  const noShows = deps.noShowService || noShowService;
  const transaction = deps.transaction || db.transaction;
  const actors = deps.currentActorService || currentActorService;

  function withTherapist(user, read) {
    const therapistId = requireAssignedTherapist(user);
    return transaction(async (client) => {
      const current = await actors.load({ user }, client, { therapistId });
      return read(current.therapistId, client);
    });
  }

  async function listAppointments(query, user) {
    requireAssignedTherapist(user);
    // markNoShows has its own transaction and identity lock: complete it before
    // acquiring the read transaction, then revalidate the caller after the wait.
    await noShows.markNoShows();
    const filters = parseAppointmentFilters(query, { therapists: false });
    return withTherapist(user, async (therapistId, client) => {
      const [result, counts] = await Promise.all([
        appointments.listForTherapist(therapistId, filters, client),
        appointments.countByTherapistGrouped(therapistId, client)
      ]);
      return { ...result, appointments: result.appointments.map(safeAppointment), counts };
    });
  }

  async function appointment(id, user, { includeHistory = false } = {}) {
    requireAssignedTherapist(user);
    validateAppointmentId(id);
    return withTherapist(user, async (therapistId, client) => {
      const item = await appointments.findById(id, client, { therapistId });
      if (!item || item.therapistId !== therapistId) {
        throw new AppError("APPOINTMENT_NOT_FOUND", "预约不存在", 404);
      }
      const detail = { appointment: safeAppointment(item) };
      if (includeHistory) {
        const revisions = await appointments.listRevisions(id, client);
        detail.history = revisions.map(publicRevision);
      }
      return detail;
    });
  }

  async function checkIn(appointmentId, context) {
    validateAppointmentId(appointmentId);
    return safeAppointment(await appointmentActions.therapistCheckInAppointment(appointmentId, context));
  }

  return { listAppointments, appointment, checkIn, safeAppointment };
}

module.exports = { createTherapistPortalService, ...createTherapistPortalService(), safeAppointment };
