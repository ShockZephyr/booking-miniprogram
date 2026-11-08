const client = require("prom-client");
const env = require("../config/env");

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const httpRequests = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"]
});

const httpErrors = new client.Counter({
  name: "http_errors_total",
  help: "Total HTTP errors",
  labelNames: ["method", "route", "status"]
});

const httpDuration = new client.Histogram({
  name: "http_request_duration",
  help: "HTTP request duration in milliseconds",
  labelNames: ["method", "route"],
  buckets: [50, 100, 200, 300, 500, 800, 1200, 2000, 5000]
});

const appointmentsCreated = new client.Counter({ name: "appointments_created", help: "Appointments created" });
const appointmentsCancelled = new client.Counter({ name: "appointments_cancelled", help: "Appointments cancelled" });
const appointmentsCheckedIn = new client.Counter({ name: "appointments_checked_in", help: "Appointments checked in" });
const appointmentsNoShow = new client.Counter({ name: "appointments_no_show", help: "Appointments marked no show" });
const adminOperations = new client.Counter({
  name: "admin_operations",
  help: "Admin operations",
  labelNames: ["action"]
});

registry.registerMetric(httpRequests);
registry.registerMetric(httpErrors);
registry.registerMetric(httpDuration);
registry.registerMetric(appointmentsCreated);
registry.registerMetric(appointmentsCancelled);
registry.registerMetric(appointmentsCheckedIn);
registry.registerMetric(appointmentsNoShow);
registry.registerMetric(adminOperations);

function observeHttp(req, res, durationMs) {
  if (!env.metricsEnabled) return;
  const route = req.route ? req.baseUrl.toLowerCase() + req.route.path
    : res.statusCode === 404 ? "unmatched" : "middleware";
  const labels = { method: req.method, route, status: String(res.statusCode) };
  httpRequests.inc(labels);
  httpDuration.observe({ method: req.method, route }, durationMs);
  if (res.statusCode >= 500) httpErrors.inc(labels);
}

function incrementAppointment(event, count = 1) {
  if (event === "created") appointmentsCreated.inc(count);
  if (event === "cancelled") appointmentsCancelled.inc(count);
  if (event === "checked_in") appointmentsCheckedIn.inc(count);
  if (event === "no_show") appointmentsNoShow.inc(count);
}

function incrementAdminOperation(action) {
  adminOperations.inc({ action: action || "unknown" });
}

async function metricsText() {
  return registry.metrics();
}

module.exports = {
  registry,
  observeHttp,
  incrementAppointment,
  incrementAdminOperation,
  metricsText
};

