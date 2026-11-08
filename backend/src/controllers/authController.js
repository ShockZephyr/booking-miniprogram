const authService = require("../services/authService");
const reviewService = require("../services/reviewLoginService");

function reviewOptions(req, res) {
  res.set("Cache-Control", "no-store");
  res.json({ success: true, data: reviewService.availability() });
}

async function reviewLogin(req, res) {
  const data = await reviewService.login(req.body, { requestId: req.requestId });
  res.set("Cache-Control", "no-store");
  res.json({ success: true, data });
}

async function login(req, res) {
  const data = await authService.loginWithWechat(req.body, {
    requestId: req.requestId,
    ip: req.ip
  });
  res.json({ success: true, data });
}

async function me(req, res) {
  const user = await authService.getMe(req.user);
  res.json({ success: true, data: { user } });
}

async function logout(req, res) {
  await authService.logout(req.user);
  res.json({ success: true, data: { loggedOut: true } });
}

module.exports = {
  reviewOptions,
  reviewLogin,
  login,
  me,
  logout
};

