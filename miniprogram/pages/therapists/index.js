const service = require("../../services/therapist");
Page({
  data: { therapists: [], manage: false, selectedId: "", loading: true, error: "" },
  onLoad(query) { this.manageRequested = query.manage === "1"; },
  onShow() {
    const app = getApp();
    const requestId = this.identityRequestId = (this.identityRequestId || 0) + 1;
    if (app.globalData.token && app.refreshMe) {
      this.setData({ manage: false, selectedId: "", loading: true, error: "" });
      app.refreshMe().then((user) => {
        if (requestId !== this.identityRequestId) return;
        this.showForUser(user);
      });
      return;
    }
    this.showForUser(app.globalData.user);
  },
  showForUser(user) {
    const manage = !!(this.manageRequested && user && user.role === "admin");
    this.setData({ manage, selectedId: "", loading: true, error: "" });
    service.list().then(({ therapists }) => this.setData({ therapists, loading: false }))
      .catch((error) => this.setData({ loading: false, error: error.message || "加载失败" }));
  },
  select(event) {
    const id = event.detail.therapist.id;
    if (this.data.manage) this.setData({ selectedId: id });
    else wx.navigateTo({ url: `/pages/therapist-detail/index?id=${id}` });
  },
  openRecycleBin() { if (this.data.manage) wx.navigateTo({ url: "/pages/admin/recycle-bin/index?type=therapist" }); },
  add() { if (this.data.manage) wx.navigateTo({ url: "/pages/admin/therapist-edit/index" }); },
  edit() { if (this.data.manage && this.data.selectedId) wx.navigateTo({ url: `/pages/admin/therapist-edit/index?id=${this.data.selectedId}` }); }
});
