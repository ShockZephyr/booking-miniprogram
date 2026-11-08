const db = require("../config/db");
const userRepository = require("../repositories/userRepository");
const auditLogRepository = require("../repositories/auditLogRepository");
const logRepository = require("../repositories/logRepository");
const alertRepository = require("../repositories/alertRepository");
const { ready } = require("../config/db");

async function countOne(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return Number(rows[0] && rows[0].count) || 0;
}

async function summary() {
  const today = "(date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')";
  const todayRequests = await countOne(`SELECT COUNT(*) FROM http_request_logs WHERE created_at >= ${today}`);
  const todayAppointments = await countOne(`SELECT COUNT(*) FROM appointments WHERE created_at >= ${today}`);
  const todayCancelled = await countOne(`SELECT COUNT(*) FROM appointments WHERE cancelled_at >= ${today}`);
  const todayCheckedIn = await countOne(`SELECT COUNT(*) FROM appointments WHERE checked_in_at >= ${today}`);
  const todayNoShow = await countOne(`SELECT COUNT(*) FROM appointments WHERE no_show_at >= ${today}`);
  const recent5mRequests = await countOne("SELECT COUNT(*) FROM http_request_logs WHERE created_at >= now() - interval '5 minutes'");
  const recent5mErrors = await countOne("SELECT COUNT(*) FROM http_request_logs WHERE created_at >= now() - interval '5 minutes' AND status_code >= 500");
  const avgResult = await db.query("SELECT COALESCE(avg(duration_ms), 0) AS avg, COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0) AS p95 FROM http_request_logs WHERE created_at >= now() - interval '1 hour'");
  const roleRows = await db.query("SELECT effective_role, COUNT(*)::int AS count FROM http_request_logs WHERE created_at >= now() - interval '1 day' GROUP BY effective_role");

  let dbStatus = "ok";
  try {
    await ready();
  } catch (error) {
    dbStatus = "down";
  }

  return {
    todayRequests,
    recentActiveUsers: await userRepository.listActiveSince(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    roleRequests: roleRows.rows,
    todayAppointments,
    todayCancelled,
    todayCheckedIn,
    todayNoShow,
    recent5mRequests,
    recent5mErrors,
    apiErrorRate: recent5mRequests ? Number((recent5mErrors / recent5mRequests).toFixed(4)) : 0,
    avgResponseMs: Number(avgResult.rows[0].avg || 0).toFixed(2),
    p95ResponseMs: Number(avgResult.rows[0].p95 || 0).toFixed(2),
    recentErrors: await logRepository.recentErrors(10),
    recentClientErrors: await logRepository.recentClientErrors(10),
    recentAdminOperations: await auditLogRepository.recent(10),
    alerts: await alertRepository.recent(10),
    node: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage()
    },
    database: { status: dbStatus }
  };
}

async function logs(filters) {
  return logRepository.queryLogPage(filters);
}

module.exports = {
  summary,
  logs
};

