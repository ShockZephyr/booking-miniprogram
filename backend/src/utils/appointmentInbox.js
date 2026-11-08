const { createHash } = require('node:crypto');
const { AppError } = require('./errors');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = ['pending', 'checked_in', 'cancelled'];

function summaryFromRows(rows) {
  const result = { created: 0, changed: 0, total: 0, target: null,
    tabs: { pending: 0, checked_in: 0, cancelled: 0, all: 0 } };
  const byKind = { created: {}, modified: {}, cancelled: {} };
  for (const row of rows) {
    const status = ['booked', 'no_show'].includes(row.status) ? 'pending' : row.status;
    if (!STATUSES.includes(status) || !byKind[row.kind]) continue;
    const count = Number(row.count);
    byKind[row.kind][status] = (byKind[row.kind][status] || 0) + count;
    result.tabs[status] += count;
    result[row.kind === 'created' ? 'created' : 'changed'] += count;
    result.total += count;
  }
  result.tabs.all = result.total;
  for (const kind of ['created', 'modified', 'cancelled']) {
    const status = (kind === 'cancelled' ? ['cancelled'] : ['pending', 'checked_in'])
      .find(key => byKind[kind][key] > 0);
    if (status) { result.target = status; break; }
  }
  return result;
}

function queryKey(filters) {
  const { page, pageSize, cursor, ...rest } = filters;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}
function scopeKey(actor) {
  return JSON.stringify([actor.role === 'admin' ? 'admin' : actor.therapistId,
    actor.sessionEpoch, actor.sessionVersion]);
}
function encodePosition(viewId, position) {
  return Buffer.from(JSON.stringify({ kind: 'appointment-inbox', viewId, position })).toString('base64url');
}
function decodePosition(cursor) {
  if (!cursor) return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > 500) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.kind !== 'appointment-inbox' || typeof value.viewId !== 'string' || !UUID.test(value.viewId)
      || !Number.isSafeInteger(value.position) || value.position < 0) throw new Error();
    return value;
  } catch (_) { throw new AppError('INVALID_CURSOR', '分页信息无效，请刷新列表', 400); }
}

module.exports = { UUID, summaryFromRows, queryKey, scopeKey, encodePosition, decodePosition };
