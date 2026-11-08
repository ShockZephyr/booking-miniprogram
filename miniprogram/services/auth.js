const request = require("../utils/request");

function login(payload) {
  return request({
    url: "/api/auth/wechat-login",
    method: "POST",
    anonymous: true,
    data: payload
  });
}

function me() {
  return request({ url: "/api/auth/me" });
}

function logout() {
  return request({ url: "/api/auth/logout", method: "POST" });
}

module.exports = {
  reviewOptions: () => request({ url: "/api/auth/review-options", anonymous: true }),
  reviewLogin: payload => request({ url: "/api/auth/review-login", method: "POST", data: payload, anonymous: true }),
  login,
  me,
  logout
};

