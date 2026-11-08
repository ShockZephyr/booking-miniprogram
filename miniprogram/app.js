const authService = require("./services/auth");
const clientErrorService = require("./services/clientError");

App({
  globalData: {
    user: null,
    token: "",
    reportingError: false
  },

  onLaunch() {
    // In-memory only: a cold launch starts fresh page state even with a saved token.
    this._loginSessionVersion = (this._loginSessionVersion || 0) + 1;
    const token = wx.getStorageSync("token");
    const user = wx.getStorageSync("user");
    this.globalData.token = token || "";
    this.globalData.user = user || null;
    if (token) {
      this.refreshMe();
    }
  },

  onError(error) {
    this.reportClientError({
      message: String(error || "unknown error"),
      stack: String(error || "")
    });
  },

  onUnhandledRejection(res) {
    const reason = res && res.reason;
    this.reportClientError({
      message: reason && reason.message ? reason.message : String(reason || "unhandled rejection"),
      stack: reason && reason.stack ? reason.stack : "",
      sourceRequestId: reason && reason.requestId
    });
  },

  refreshMe() {
    const token = this.globalData.token;
    const version = this._sessionVersion || 0;
    const refreshKey = `${token}:${version}`;
    if (this._refreshMePromise && this._refreshMeKey === refreshKey) return this._refreshMePromise;
    const isCurrentSession = () => this.globalData.token === token && (this._sessionVersion || 0) === version;
    const promise = authService
      .me()
      .then((data) => {
        if (!isCurrentSession()) return this.globalData.user;
        this.setSession(token, data.user, { preserveLoginSession: true });
        return data.user;
      })
      .catch((error) => {
        if (isCurrentSession() && ["INVALID_SESSION", "NOT_LOGGED_IN"].includes(error.code)) {
          this.clearSession();
        }
        return this.globalData.user;
      })
      .finally(() => {
        if (this._refreshMePromise === promise) {
          this._refreshMePromise = null;
          this._refreshMeKey = "";
        }
      });
    this._refreshMeKey = refreshKey;
    this._refreshMePromise = promise;
    return promise;
  },

  setSession(token, user, { preserveLoginSession = false } = {}) {
    if (!preserveLoginSession) {
      delete this._bookingResume;
      delete this._scheduleWrite;
      this._loginSessionVersion = (this._loginSessionVersion || 0) + 1;
    }
    if (this.globalData.user && (!user || this.globalData.user.id !== user.id)) {
      wx.removeStorageSync("editingAppointment");
      wx.removeStorageSync("selectedSlot");
    }
    this._sessionVersion = (this._sessionVersion || 0) + 1;
    this.globalData.token = token;
    this.globalData.user = user;
    wx.setStorageSync("token", token);
    wx.setStorageSync("user", user);
  },

  clearSession() {
    delete this._bookingResume;
    delete this._scheduleWrite;
    this._loginReturn = null;
    this._loginSessionVersion = (this._loginSessionVersion || 0) + 1;
    this._sessionVersion = (this._sessionVersion || 0) + 1;
    this.globalData.token = "";
    this.globalData.user = null;
    wx.removeStorageSync("token");
    wx.removeStorageSync("user");
    wx.removeStorageSync("editingAppointment");
    wx.removeStorageSync("selectedSlot");
  },

  requireLogin() {
    if (this.globalData.token) return Promise.resolve(this.globalData.user);
    return new Promise((resolve, reject) => {
      wx.showModal({
        title: "请先登录",
        content: "登录后即可继续预约。",
        confirmText: "去登录",
        success: (res) => {
          if (res.confirm) {
            wx.switchTab({ url: "/pages/mine/index" });
          }
          reject(new Error("not logged in"));
        }
      });
    });
  },

  reportClientError(payload) {
    if (this.globalData.reportingError) return;
    this.globalData.reportingError = true;
    const pages = getCurrentPages();
    const page = pages.length ? pages[pages.length - 1].route : "";
    let systemInfo = {};
    try {
      systemInfo = wx.getSystemInfoSync();
    } catch (error) {
      systemInfo = {};
    }
    clientErrorService
      .report({
        page,
        message: payload.message,
        stack: payload.stack,
        sourceRequestId: typeof payload.sourceRequestId === "string" ? payload.sourceRequestId : undefined,
        systemInfo
      })
      .finally(() => {
        this.globalData.reportingError = false;
      });
  }
});
