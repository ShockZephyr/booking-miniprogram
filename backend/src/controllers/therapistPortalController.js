const service = require("../services/therapistPortalService");

const context = (req) => ({ user: req.user, requestId: req.requestId, ip: req.ip });

module.exports = {
  appointments: async (req, res) => res.json({ success: true, data: req.query.unread === '1'
    ? await require('../services/appointmentInboxService').list(req.query, context(req), { therapistId: req.user.therapistId })
    : await service.listAppointments(req.query, req.user) }),
  appointment: async (req, res) => res.json({ success: true, data: await service.appointment(req.params.id, req.user, {
    includeHistory: req.query.includeHistory === "1"
  }) }),
  checkIn: async (req, res) => res.json({ success: true, data: { appointment: await service.checkIn(req.params.id, context(req)) } })
};
