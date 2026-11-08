const db = require('../config/db');
const actors = require('./currentActorService');
const noShows = require('./noShowService');
const repo = require('../repositories/appointmentInboxRepository');
const { AppError } = require('../utils/errors');
const { parseAppointmentFilters } = require('../utils/appointmentFilters');
const { UUID } = require('../utils/appointmentInbox');
const { maskPhone } = require('../utils/phone');

async function withStaff(context, options, run) {
  return db.transaction(async client => {
    const actor = await actors.load(context, client, options);
    if (actor.role !== 'admin' && !actor.therapistId) throw new AppError('NOT_STAFF', '无工作人员权限', 403);
    return run(actor, client);
  });
}
async function summary(context) {
  await noShows.markNoShows();
  return withStaff(context, {}, (actor, client) => repo.summary(actor, {}, client));
}
async function list(query, context, options = {}) {
  await noShows.markNoShows();
  return withStaff(context, options, async (actor, client) => {
    const filters = parseAppointmentFilters(query, { therapists: actor.role === 'admin' });
    const result = await repo.list(actor, filters, client);
    if (actor.role !== 'admin') result.appointments = result.appointments.map(({ userId, ...item }) => ({
      ...item, userPhone: item.userPhone ? maskPhone(item.userPhone) : null
    }));
    return result;
  });
}
async function acknowledge(body, context) {
  if (!body || typeof body.viewId !== 'string' || !UUID.test(body.viewId) || !Array.isArray(body.entries) || !body.entries.length || body.entries.length > 20
    || body.entries.some(item => !item || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.version !== 'string'
      || !/^[1-9][0-9]{0,17}$/.test(item.version))) {
    throw new AppError('INVALID_READ_CONFIRMATION', '已读确认信息无效', 400);
  }
  // PostgreSQL UUID equality is case-insensitive; validate the same identities
  // here so duplicate upsert targets cannot escape as a database error.
  const entries = body.entries.map(item => ({ id: item.id.toLowerCase(), version: item.version }));
  if (new Set(entries.map(item => item.id)).size !== entries.length) {
    throw new AppError('INVALID_READ_CONFIRMATION', '已读确认信息无效', 400);
  }
  return withStaff(context, {}, (actor, client) => repo.acknowledge(actor, body.viewId.toLowerCase(), entries, client));
}
module.exports = { summary, list, acknowledge };
