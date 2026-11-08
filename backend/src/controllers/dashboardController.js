const dashboardService = require("../services/dashboardService");

async function summary(req, res) {
  res.json({ success: true, data: await dashboardService.summary() });
}

async function logs(req, res) {
  res.json({ success: true, data: await dashboardService.logs(req.query) });
}

module.exports = {
  summary,
  logs
};

