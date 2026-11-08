const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const env = require("./config/env");
const requestId = require("./middleware/requestId");
const requestLogger = require("./middleware/requestLogger");
const { attachUser } = require("./middleware/auth");
const errorHandler = require("./middleware/errorHandler");
const metrics = require("./services/metricsService");

const authRoutes = require("./routes/authRoutes");
const metaRoutes = require("./routes/metaRoutes");
const scheduleRoutes = require("./routes/scheduleRoutes");
const appointmentRoutes = require("./routes/appointmentRoutes");
const adminRoutes = require("./routes/adminRoutes");
const clientErrorRoutes = require("./routes/clientErrorRoutes");
const healthRoutes = require("./routes/healthRoutes");

function createApp() {
  const app = express();

  app.disable("x-powered-by");
  // The production container is reachable only through one Nginx proxy hop.
  // Local development keeps the stricter loopback-only behavior.
  app.set("trust proxy", env.trustProxyHops || "loopback");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(requestId);
  app.use(requestLogger);
  const json = express.json({ limit: "1mb" });
  app.use((req, res, next) => req.path === "/api/admin/therapist-images" ? next() : json(req, res, next));
  app.use(attachUser);

  app.use(healthRoutes);
  const projects = require('./controllers/projectController');
  const asyncHandler = require('./middleware/asyncHandler');
  app.get('/api/projects', asyncHandler(projects.list));
  app.get('/api/projects/:id', asyncHandler(projects.detail));
  app.use("/uploads/therapists", express.static(require("./services/therapistImageService").directory, {
    maxAge: "30d", immutable: true, index: false, dotfiles: "deny",
    // Public catalog images are embedded by the mini-program from a different
    // origin. Override Helmet only for files that are actually served here.
    setHeaders(res) { res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"); }
  }));
  app.use("/api/therapists", require("./routes/therapistRoutes"));
  app.use("/api/therapist", require("./routes/therapistPortalRoutes"));
  app.use("/api/auth", authRoutes);
  app.use("/api/meta", metaRoutes);
  app.use("/api/schedules", scheduleRoutes);
  app.use("/api/appointments", appointmentRoutes);
  app.use("/api/appointment-inbox", require('./routes/appointmentInboxRoutes'));
  app.use("/api/admin", adminRoutes);
  app.use("/api/client-errors", clientErrorRoutes);

  app.get("/metrics", async (req, res) => {
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    if (!env.metricsEnabled || !local || req.path !== "/metrics" ||
        ["forwarded", "x-forwarded-for", "x-real-ip"].some(header => header in req.headers)) {
      return res.sendStatus(404);
    }
    res.set("content-type", metrics.registry.contentType);
    res.send(await metrics.metricsText());
  });

  if (env.adminDashboardEnabled) {
    app.use("/dashboard", express.static(path.join(__dirname, "../public/dashboard")));
  }

  app.use((req, res) => {
    res.status(404).json({
      success: false,
      code: "NOT_FOUND",
      message: "接口不存在",
      requestId: req.requestId
    });
  });

  app.use(errorHandler);

  return app;
}

module.exports = createApp;
