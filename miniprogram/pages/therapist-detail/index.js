const service = require("../../services/therapist");
const dates = require("../../utils/date");
const schedules = require("../../services/schedules");
const imageFallback = require("../../utils/imageFallback");
Page({
  data: Object.assign(imageFallback.initialData(), { therapist: null, loading: true, error: "", canBook: true, retryIconFailed: false }),
  imageError: imageFallback.imageError,
  retryImage: imageFallback.retryImage,
  retryIconError() { this.setData({ retryIconFailed: true }); },
  onLoad(query) { this.id = query.id; },
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
    // A new detail render owns a new image lifecycle, even when its URL is unchanged.
    this.setData(Object.assign({ loading: true, error: "", therapist: null, canBook: !isStaff }, imageFallback.sourcePatch(this, "", true)));
    service.detail(this.id).then(({ therapist }) => {
      if (requestId !== this._detailRequestId) return;
      this.setData(Object.assign({ therapist, loading: false }, imageFallback.sourcePatch(this, therapist.imageSrc)));
    }).catch((error) => {
      if (requestId === this._detailRequestId) this.setData({ loading: false, error: error.message || "加载失败" });
    });
  },
  book() {
    if (!this.data.therapist || !this.data.canBook) return;
    wx.navigateTo({ url: schedules.dayPath(this.data.therapist.id, dates.today()) });
  }
});
