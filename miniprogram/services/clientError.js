const request = require("../utils/request");
const env = require("../config/env");

function report(payload) {
  return request({
    url: "/api/client-errors",
    method: "POST",
    data: Object.assign({ appVersion: env.APP_VERSION }, payload)
  }).catch(() => null);
}

module.exports = {
  report
};

