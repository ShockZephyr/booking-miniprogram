const appointmentService = require("../services/appointmentService");
const appointmentRepository = require("../repositories/appointmentRepository");
const noShowService = require("../services/noShowService");
const db = require("../config/db");
const currentActor = require("../services/currentActorService");
const { parseAppointmentFilters } = require("../utils/appointmentFilters");
const { appointmentId, calendarRange } = require("../utils/appointmentInput");

function readForActor(req, options, read) {
  return db.transaction(async (client) => {
    const user = await currentActor.load({ user: req.user }, client, options);
    return read(user, client);
  });
}

async function create(req, res) {
  const appointment = await appointmentService.createAppointment(req.body, {
    user: req.user,
    requestId: req.requestId,
    ip: req.ip
  });
  res.json({ success: true, data: { appointment } });
}

async function my(req, res) {
  await noShowService.markNoShows();
  const filters = parseAppointmentFilters(req.query);
  const data = await readForActor(req, {}, async (user, client) => {
    const result = await appointmentRepository.listByUser(user.id, filters, client);
    return { ...result, counts: await appointmentRepository.countByUserGrouped(user.id, client) };
  });
  res.json({ success: true, data });
}

async function calendarStatus(req, res) {
  const range = calendarRange(req.query.from, req.query.to);
  await noShowService.markNoShows();
  const statuses = await readForActor(req, {}, (user, client) =>
    appointmentRepository.calendarStatusByUser(user.id, range.from, range.to, client));
  res.json({ success: true, data: { statuses } });
}

async function adminList(req, res) {
  if (req.query.unread === '1') {
    const data = await require('../services/appointmentInboxService').list(req.query, { user: req.user }, { admin: true });
    return res.json({ success: true, data });
  }
  await noShowService.markNoShows();
  const filters = parseAppointmentFilters(req.query);
  const result = await readForActor(req, { admin: true }, (user, client) => appointmentRepository.listForAdmin(filters, client));
  res.json({ success: true, data: result });
}

async function adminGet(req, res) {
  const id = appointmentId(req.params.id);
  await noShowService.markNoShows();
  res.json({ success: true, data: await appointmentService.getAdminAppointment(id, { user: req.user }) });
}

async function filterOptions(req, res) {
  const data = await readForActor(req, {}, (user, client) => appointmentRepository.listFilterOptions(user, client));
  res.json({ success: true, data });
}

async function cancel(req, res) {
  const appointment = await appointmentService.cancelAppointment(appointmentId(req.params.id), {
    user: req.user,
    requestId: req.requestId,
    ip: req.ip
  });
  res.json({ success: true, data: { appointment } });
}

async function checkIn(req, res) {
  const appointment = await appointmentService.checkInAppointment(appointmentId(req.params.id), {
    user: req.user,
    requestId: req.requestId,
    ip: req.ip
  });
  res.json({ success: true, data: { appointment } });
}

async function ownGet(req, res) {
  const includeHistory = req.query.includeHistory === "1";
  const result = await appointmentService.getOwnAppointment(appointmentId(req.params.id), { user: req.user }, { includeHistory });
  res.json({ success: true, data: includeHistory ? result : { appointment: result } });
}

async function modify(req, res) {
  const appointment = await appointmentService.modifyAppointment(appointmentId(req.params.id), req.body, {
    user: req.user,
    requestId: req.requestId,
    ip: req.ip
  });
  res.json({ success: true, data: { appointment } });
}

async function adminCancel(req, res) {
  const appointment = await appointmentService.cancelAppointment(
    appointmentId(req.params.id),
    { user: req.user, requestId: req.requestId, ip: req.ip },
    { admin: true }
  );
  res.json({ success: true, data: { appointment } });
}

async function adminCheckIn(req, res) {
  const appointment = await appointmentService.checkInAppointment(
    appointmentId(req.params.id),
    { user: req.user, requestId: req.requestId, ip: req.ip },
    { admin: true }
  );
  res.json({ success: true, data: { appointment } });
}

async function adminUncheckIn(req, res) {
  const appointment = await appointmentService.uncheckInAppointment(
    appointmentId(req.params.id),
    { user: req.user, requestId: req.requestId, ip: req.ip },
    { admin: true }
  );
  res.json({ success: true, data: { appointment } });
}

module.exports = {
  ownGet,
  create,
  my,
  calendarStatus,
  adminList,
  adminGet,
  filterOptions,
  cancel,
  checkIn,
  modify,
  adminCancel,
  adminCheckIn,
  adminUncheckIn
};
