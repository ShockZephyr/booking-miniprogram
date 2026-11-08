const business = require("../../../config/business");
Page({
  data: { business },
  call() {
    if (!this.data.business.phone || /^0+$/.test(String(this.data.business.phone).replace(/\D/g, ""))) { wx.showToast({ title: "门店电话尚未配置", icon: "none" }); return; }
    wx.makePhoneCall({ phoneNumber: this.data.business.phone });
  }
});

