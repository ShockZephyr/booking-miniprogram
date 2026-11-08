const service = require("../../services/project");
const imageFallback = require("../../utils/imageFallback");

Page({
  data: Object.assign(imageFallback.initialData(), {
    item: null,
    loading: true,
    error: "",
    canBook: true,
    retryIconFailed: false
  }),

  imageError: imageFallback.imageError,
  retryImage: imageFallback.retryImage,
  retryIconError() { this.setData({ retryIconFailed: true }); },

  onLoad(query) {
    this.id = query.id;
  },

  onShow() {
    const app = getApp();
    if (app.globalData.token && app.refreshMe) {
      app.refreshMe().then((user) => this.loadForUser(user));
      return;
    }
    this.loadForUser(app.globalData.user);
  },

  loadForUser(user) {
    const requestId = this._detailRequestId = (this._detailRequestId || 0) + 1;
    const isStaff = !!user && (user.role === "admin" || !!user.therapistId);
    // Loading removes the image node. Invalidate it before even a same-URL reload.
    this.setData(Object.assign({ loading: true, error: "", canBook: !isStaff }, imageFallback.sourcePatch(this, "", true)));
    service.detail(this.id)
      .then(({ item }) => {
        if (requestId !== this._detailRequestId) return;
        this.setData(Object.assign({ item }, imageFallback.sourcePatch(this, item.imageSrc)));
      })
      .catch((error) => {
        if (requestId === this._detailRequestId) this.setData({ error: error.message || "加载失败" });
      })
      .finally(() => {
        if (requestId === this._detailRequestId) this.setData({ loading: false });
      });
  },

  book() {
    if (!this.data.item || !this.data.canBook) return;
    wx.switchTab({ url: "/pages/booking/index" });
  }
});
