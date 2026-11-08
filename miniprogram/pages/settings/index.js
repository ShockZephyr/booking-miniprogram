const authService = require("../../services/auth");
const env = require("../../config/env");
const legal = require("../../config/legal");

Page({
  data: {
    user: null,
    loggingOut: false,
    version: env.APP_VERSION,
    legal
  },

  onShow() {
    this.setData({ user: getApp().globalData.user });
  },

  open(event) {
    wx.navigateTo({ url: `/pages/static/${event.currentTarget.dataset.page}/index` });
  },

  showIcpQuery() {
    if (this._icpPromptOpen) return;
    this._icpPromptOpen = true;
    wx.showModal({
      title: "ICP备案查询",
      content: `请在浏览器打开工信部网站查询：\n${legal.icpQueryUrl}`,
      confirmText: "复制网址",
      success: (res) => {
        if (!res.confirm) return;
        wx.setClipboardData({
          data: legal.icpQueryUrl,
          fail: () => wx.showToast({ title: "复制失败，请重试", icon: "none" })
        });
      },
      complete: () => { this._icpPromptOpen = false; }
    });
  },

  logout() {
    if (this.data.loggingOut || this._logoutPromptOpen) return;
    const app = getApp();
    const token = app.globalData.token;
    const userId = app.globalData.user && app.globalData.user.id;
    const isCurrentSession = () => app.globalData.token === token
      && (app.globalData.user && app.globalData.user.id) === userId;
    const finishLogout = () => {
      if (!isCurrentSession()) return;
      app.clearSession();
      wx.switchTab({ url: "/pages/home/index" });
    };
    this._logoutPromptOpen = true;
    wx.showModal({
      title: "退出登录",
      content: "退出后预约记录仍会保留",
      confirmText: "退出",
      confirmColor: "#8f434c",
      success: (res) => {
        this._logoutPromptOpen = false;
        if (!res.confirm || !isCurrentSession()) return;
        this.setData({ loggingOut: true });
        authService.logout().then(finishLogout).catch((error) => {
          if (!isCurrentSession()) return;
          if (error && ["INVALID_SESSION", "NOT_LOGGED_IN"].includes(error.code)) {
            finishLogout();
            return;
          }
          wx.showToast({ title: "退出未完成，请检查网络后重试", icon: "none" });
        }).finally(() => this.setData({ loggingOut: false }));
      },
      complete: () => { this._logoutPromptOpen = false; }
    });
  }
});
