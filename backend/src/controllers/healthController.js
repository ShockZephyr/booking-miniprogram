const db = require("../config/db");
const images = require("../services/therapistImageService");

async function health(req, res) {
  res.json({ status: "ok" });
}

async function ready(req, res) {
  try {
    await Promise.all([db.ready(), images.ensureReady()]);
    res.json({ status: "ok", database: "ok", imageStorage: "ok" });
  } catch (error) {
    res.status(503).json({ status: "error", dependency: "unavailable" });
  }
}

module.exports = {
  health,
  ready
};

