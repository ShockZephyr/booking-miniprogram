const loginReturn = require("../../utils/loginReturn");
const authService = require("../../services/auth");
const runtime = require("../../utils/runtime");

Page({
  data: {
    user: null,
    loggingIn: false,
    showTestLogin: false,
    showReviewLogin: false,
    reviewCode: "",
    mockPhone: "13900000000",
    appointmentEntries: [
      { status: "pending", text: "已预约", iconPath: "/assets/icons/appointment-booked.png" },
      { status: "checked_in", text: "已签到", iconPath: "/assets/icons/appointment-checked-in.png" },
      { status: "cancelled", text: "已取消", iconPath: "/assets/icons/appointment-cancelled.png" },
      { status: "all", text: "全部", iconPath: "/assets/icons/appointment-all.png" }
    ],
    adminEntries: [
      { page: "calendar", text: "管理排班", iconPath: "/assets/icons/admin-booking.png" },
      { page: "batch-slots", text: "批量管理", iconPath: "/assets/icons/admin-batch-slots.png" },
      { page: "whitelist", text: "白名单", iconPath: "/assets/icons/admin-whitelist.png" },
      { page: "projects", text: "项目管理", iconPath: "/assets/icons/admin-projects.png" },
      { page: "therapists", text: "管理芳疗师", iconPath: "/assets/icons/admin-therapists.png" },
      { page: "covers", text: "封面设置", iconPath: "/assets/icons/admin-covers.png" }
    ]
  },

  onShow() {
    this._active = true;
    const view = this._viewVersion = (this._viewVersion || 0) + 1;
    const app = getApp();
    this.setData({ user: app.globalData.user, showTestLogin: runtime.canUseTestLogin(), showReviewLogin: false });
    this.loadReviewOptions(view);
    if (app.globalData.token) {
      app.refreshMe().then(() => {
        if (this._active && view === this._viewVersion) this.setData({ user: app.globalData.user });
      });
    }
  },

  onHide() {
    this._active = false;
    this._viewVersion = (this._viewVersion || 0) + 1;
    this._loginAttempt = (this._loginAttempt || 0) + 1;
    this.setData({ reviewCode: "", showReviewLogin: false, loggingIn: false });
  },

  onUnload() { this.onHide(); },

  loadReviewOptions(view = this._viewVersion) {
    if (this.data.showTestLogin) return Promise.resolve();
    return authService.reviewOptions().then(data => {
      if (this._active && view === this._viewVersion) this.setData({ showReviewLogin: data.testLoginEnabled === true });
    }).catch(() => {
      if (this._active && view === this._viewVersion) this.setData({ showReviewLogin: false, reviewCode: "" });
    });
  },

  inputReviewCode(event) {
    if (!this.data.loggingIn) this.setData({ reviewCode: event.detail.value });
  },

  reviewUserLogin() { return this.reviewLogin("user"); },
  reviewTherapistLogin() { return this.reviewLogin("therapist"); },
  reviewAdminLogin() { return this.reviewLogin("admin"); },

  reviewLogin(account) {
    if (!this.data.showReviewLogin || this.data.loggingIn || this._active === false) return;
    const reviewCode = String(this.data.reviewCode || "").trim();
    if (!reviewCode) { wx.showToast({ title: "请输入私有审核码", icon: "none" }); return; }
    return this.runLogin(() => authService.reviewLogin({ account, reviewCode }));
  },

  handlePhoneLogin(event) {
    const detail = event.detail || {};
    if (!detail.code) {
      wx.showToast({ title: "未授权手机号，暂时无法登录和预约", icon: "none" });
      return;
    }
    this.doLogin({ phoneCode: detail.code });
  },

  inputMockPhone(event) {
    this.setData({ mockPhone: event.detail.value });
  },

  mockUserLogin() {
    if (!runtime.canUseTestLogin()) return;
    const phone = String(this.data.mockPhone || "").trim();
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: "请输入 11 位手机号", icon: "none" });
      return;
    }
    this.doLogin({
      mockOpenid: `dev_mock_user_${phone}`,
      mockPhone: phone,
      mockRole: "user",
      nickname: "普通测试用户"
    }, true);
  },

  mockAdminLogin() {
    if (!runtime.canUseTestLogin()) return;
    this.doLogin({
      mockOpenid: "dev_mock_user_13800000000",
      mockPhone: "13800000000",
      mockRole: "admin",
      nickname: "管理员测试用户"
    }, true);
  },

  doLogin(payload, skipWxLogin) {
    if (skipWxLogin && !runtime.canUseTestLogin()) return;
    return this.runLogin(isCurrent => {
      if (skipWxLogin) return authService.login(Object.assign({ loginCode: "dev-mock-login" }, payload));
      return new Promise((resolve, reject) => wx.login({
        success: res => {
          if (!isCurrent()) { resolve(null); return; }
          resolve(authService.login(Object.assign({ loginCode: res.code }, payload)));
        },
        fail: () => reject({ message: "登录失败，请重试" })
      }));
    });
  },

  runLogin(start) {
    if (this.data.loggingIn || this._active === false) return;
    const app = getApp();
    const token = app.globalData.token;
    const sessionVersion = app._loginSessionVersion;
    const attempt = this._loginAttempt = (this._loginAttempt || 0) + 1;
    const isCurrent = () => this._active !== false && attempt === this._loginAttempt
      && token === app.globalData.token && sessionVersion === app._loginSessionVersion;
    this.setData({ loggingIn: true });
    let operation;
    try { operation = start(isCurrent); } catch (error) { operation = Promise.reject(error); }
    return Promise.resolve(operation).then(data => {
      if (!isCurrent() || !data) return;
      app.setSession(data.token, data.user);
      this.setData({ user: data.user, reviewCode: "", showReviewLogin: false });
      wx.showToast({ title: "登录成功", icon: "success" });
      if (loginReturn.resume) loginReturn.resume();
    }).catch(error => {
      if (!isCurrent()) return;
      if (["REVIEW_LOGIN_DISABLED", "INVALID_SESSION"].includes(error.code)) {
        this.setData({ showReviewLogin: false, reviewCode: "" });
      }
      wx.showToast({ title: error.message || "登录失败", icon: "none" });
    }).finally(() => {
      if (attempt === this._loginAttempt) this.setData({ loggingIn: false });
    });
  },

  openAppointments(event) {
    const status = event.currentTarget.dataset.status;
    const adminParam = this.data.user && this.data.user.effectiveRole === "admin" ? "&admin=1" : "";
    wx.navigateTo({ url: `/pages/my-appointments/index?status=${status}${adminParam}` });
  },

  openTherapistAppointments(event) {
    const status = event.currentTarget.dataset.status;
    wx.navigateTo({ url: `/pages/my-appointments/index?status=${status}&therapist=1` });
  },

  openSettings() {
    wx.navigateTo({ url: "/pages/settings/index" });
  },

  openAdmin(event) {
    const page = event.currentTarget.dataset.page;
    if (page === 'projects') {
      wx.navigateTo({url:'/pages/projects/index?manage=1'});
      return;
    }
    if (page === "therapists") {
      wx.navigateTo({ url: "/pages/therapists/index?manage=1" });
      return;
    }
    wx.navigateTo({ url: `/pages/admin/${page}/index` });
  }
});
