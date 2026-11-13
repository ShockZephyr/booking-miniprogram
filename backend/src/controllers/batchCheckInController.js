const service = require("../services/batchCheckInService");
function handler(admin, submit) {
  return async (req, res) => res.json({ success: true,
    data: await service[submit ? "submit" : "preview"](req.body,
      { user: req.user, requestId: req.requestId, ip: req.ip }, { admin }) });
}
module.exports = { adminPreview: handler(true, false), adminSubmit: handler(true, true),
  therapistPreview: handler(false, false), therapistSubmit: handler(false, true) };
