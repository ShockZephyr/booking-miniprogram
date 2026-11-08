const businessConfig = require("../../config/business");
const userService = require("../../services/user");

Page({
  data: {
    user: null,
    business: businessConfig
  },

  onShow() {
    const app = getApp();
    this.setData({ user: app.globalData.user });
    userService.business().then((data) => this.setData({ business: data })).catch(() => {});
  },

  callBusiness() {
    wx.makePhoneCall({ phoneNumber: this.data.business.phone });
  },

  login() {
    wx.switchTab({ url: "/pages/mine/index" });
  }
});

