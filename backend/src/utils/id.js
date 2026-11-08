const crypto = require("crypto");

function createRequestId() {
  return `req_${crypto.randomBytes(12).toString("hex")}`;
}

module.exports = {
  createRequestId
};

