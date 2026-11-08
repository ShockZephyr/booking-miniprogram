const { createRequestId } = require("../utils/id");

function requestId(req, res, next) {
  const supplied = req.get("x-request-id");
  req.requestId = typeof supplied === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/.test(supplied)
    ? supplied : createRequestId();
  res.setHeader("x-request-id", req.requestId);
  next();
}

module.exports = requestId;

