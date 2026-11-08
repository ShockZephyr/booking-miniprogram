const userService = require("../../../services/user");

Page({
  data: { operator: "", contactPhone: "", loading: true, error: "" },
  onShow() {
    userService.business().then((business) => this.setData({
      operator: business.privacyOperator || business.name,
      contactPhone: business.privacyContactPhone || business.phone,
      loading: false, error: ""
    })).catch(() => this.setData({ loading: false, error: "联系信息加载失败，请稍后重试" }));
  },
  contact() {
    const phone = this.data.contactPhone;
    if (!phone || /^0+$/.test(String(phone).replace(/\D/g, ""))) {
      wx.showToast({ title: "联系手机尚未配置", icon: "none" }); return;
    }
    wx.makePhoneCall({ phoneNumber: phone });
  }
});

