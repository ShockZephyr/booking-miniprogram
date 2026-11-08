const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Only known routes and their canonical arguments can be resumed after login.
function normalize(target) {
  const value = String(target || "");
  const [path, query = ""] = value.split("?");
  if (["/pages/admin/calendar/index", "/pages/admin/batch-slots/index"].includes(path)) {
    if (!query) return path;
    if (path === "/pages/admin/batch-slots/index" && new RegExp("^therapistId=" + UUID + "$", "i").test(query)) return path + "?" + query;
    return "";
  }
  if (path === "/pages/schedule-day/index") {
    const match = new RegExp(`^therapistId=${UUID}&date=\\d{4}-\\d{2}-\\d{2}(?:&appointmentId=${UUID})?$`, "i").exec(query);
    return match ? path + "?" + match[0] : "";
  }
  if (path === "/pages/my-appointments/index") {
    const status = /(?:^|&)status=(pending|checked_in|cancelled|all)(?:&|$)/.exec(query);
    return `${path}?status=${status ? status[1] : "pending"}`;
  }
  if (!["/pages/admin/slot-appointment/index", "/pages/therapist/appointment-detail/index", "/pages/appointment-detail/index"].includes(path)) return "";
  const id = new RegExp("(?:^|&)appointmentId=(" + UUID + ")(?:&|$)", "i").exec(query);
  return id ? path + "?appointmentId=" + id[1] : "";
}

function request(target, bookingDraft) {
  const app = getApp();
  const url = normalize(target);
  if (!url || app._loginReturnPrompt) return;
  const owner = sessionKey(), version = app._loginSessionVersion;
  app._loginReturnPrompt = true;
  wx.showModal({
    title: "请先登录", content: "登录后查看预约", confirmText: "去登录",
    success: (result) => {
      if (owner !== sessionKey() || version !== app._loginSessionVersion) return;
      if (result.confirm) {
        app._loginReturn = { url, expiresAt: Date.now() + 10 * 60 * 1000 };
        // Only an explicit guest booking can carry input across the login boundary.
        if (!app.globalData.user && url.startsWith("/pages/schedule-day/") && !url.includes("appointmentId=") && bookingDraft) {
          app._loginReturn.bookingDraft = { start: bookingDraft.start, end: bookingDraft.end,
            serviceItemIds: Array.isArray(bookingDraft.serviceItemIds) ? bookingDraft.serviceItemIds.slice() : [bookingDraft.serviceItemId].filter(Boolean), note: String(bookingDraft.note || "").slice(0, 250) };
        }
        wx.switchTab({ url: "/pages/mine/index" });
      } else app._loginReturn = null;
    },
    complete: () => { app._loginReturnPrompt = false; }
  });
}

function resume() {
  const app = getApp();
  const pending = app._loginReturn;
  app._loginReturn = null;
  if (!pending || pending.expiresAt < Date.now() || !app.globalData.user) return;
  let url = normalize(pending.url);
  const user = app.globalData.user;
  if (!url) return;
  if (pending.bookingDraft && user.role !== "admin" && !user.therapistId) {
    app._bookingResume = { url, owner: sessionKey() + ":" + (app._loginSessionVersion || 0),
      expiresAt: pending.expiresAt, values: pending.bookingDraft };
  }
  if ((url.startsWith("/pages/admin/") && user.role !== "admin")
    || (url.startsWith("/pages/therapist/") && !user.therapistId)) {
    url = "/pages/my-appointments/index?status=pending";
  }
  wx.navigateTo({ url });
}

function sessionKey() {
  const app = typeof getApp === "function" ? getApp() : null;
  const user = app && app.globalData.user;
  return app ? JSON.stringify([app.globalData.token, user && user.id, user && user.role, user && user.therapistId]) : "test";
}

async function ensure(target, role) {
  if (typeof getApp !== "function") return true; // Node VM without an app lifecycle.
  const app = getApp();
  const user = app.globalData.token && app.refreshMe ? await app.refreshMe() : app.globalData.user;
  if (!user || !app.globalData.token) { request(target); return false; }
  if ((role === "admin" && user.role !== "admin") || (role === "therapist" && !user.therapistId)) {
    wx.redirectTo({ url: "/pages/my-appointments/index?status=pending" }); return false;
  }
  return true;
}

module.exports = { normalize, request, resume, ensure, sessionKey };
