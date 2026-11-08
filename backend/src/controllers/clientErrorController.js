const clientErrorService = require("../services/clientErrorService");

async function report(req, res) {
  await clientErrorService.report(req.body, {
    user: req.user,
    requestId: req.requestId
  });
  res.json({ success: true, data: { received: true } });
}

module.exports = {
  report
};

