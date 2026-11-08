const schedules = require("../services/scheduleService");

const context = req => ({ user: req.user, requestId: req.requestId, ip: req.ip });
const respond = action => async (req, res) => res.json({ success: true, data: await action(req) });

module.exports = {
  list: respond(req => schedules.list(req.query.date, req.user, req.query)),
  detail: respond(req => schedules.detail({ therapistId: req.params.therapistId, date: req.query.date,
    appointmentId: req.query.appointmentId }, req.user)),
  getSettings: respond(req => schedules.getSettings(context(req))),
  setSettings: respond(req => schedules.setSettings(req.body, context(req))),
  getWeekly: respond(req => schedules.getWeekly(req.params.therapistId,
    typeof req.query.weekday === "string" ? Number(req.query.weekday) : NaN, context(req))),
  putWeekly: respond(req => schedules.putWeekly(req.body, context(req))),
  putWeeklyDays: respond(req => schedules.putWeeklyDays(req.params.therapistId, req.body, context(req))),
  patchDay: respond(req => schedules.patchDay(req.params.therapistId, req.body, context(req)))
};
