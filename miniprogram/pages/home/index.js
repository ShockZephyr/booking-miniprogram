const businessConfig = require("../../config/business");
const userService = require("../../services/user");
const therapistService = require("../../services/therapist");
const projectService = require('../../services/project');
const coverService = require("../../services/cover");
const appointmentInbox = require('../../services/appointmentInbox');

function inboxSessionKey() {
  const app = getApp(), state = app.globalData || {}, user = state.user || {};
  return [user.id, user.role, user.therapistId, state.token, app._loginSessionVersion].join(':');
}

const userQuickEntries = [
  { key: "booking", text: "预约", tone: "lavender", iconPath: "/assets/icons/booking.png" },
  { key: "checkin", text: "签到", tone: "sage", iconPath: "/assets/icons/checkin.png" },
  { key: "calendar", text: "日历", tone: "amber", iconPath: "/assets/icons/calendar.png" },
  { key: "member", text: "会员", tone: "rose", iconPath: "/assets/icons/member.png" }
];

const adminQuickEntries = [
  { key: "adminBooking", text: "管理排班", tone: "lavender", iconPath: "/assets/icons/admin-booking.png" },
  { key: "adminBatch", text: "批量管理", tone: "amber", iconPath: "/assets/icons/admin-batch-slots.png" },
  { key: "adminWhitelist", text: "白名单", tone: "sage", iconPath: "/assets/icons/admin-whitelist.png" }
];

const therapistQuickEntries = [
  { key: "therapistBooking", text: "我的排班", tone: "lavender", iconPath: "/assets/icons/booking.png" },
  { key: "therapistCheckin", text: "待签到", tone: "sage", iconPath: "/assets/icons/checkin.png" },
  { key: "therapistCalendar", text: "日历", tone: "amber", iconPath: "/assets/icons/calendar.png" },
  { key: "therapistAppointments", text: "客户预约", tone: "rose", iconPath: "/assets/icons/appointment-all.png" }
];

Page({
  data: {
    business: businessConfig,
    covers: [],
    banners: [
      { title: "淡薰衣草香气", subtitle: "给身体一点慢下来的时间" },
      { title: "自然舒缓护理", subtitle: "预约专属的轻盈时段" },
      { title: "干净安静的空间", subtitle: "把日常疲惫放在门外" }
    ],
    quickEntries: userQuickEntries,
    isAdmin: false,
    isTherapist: false,
    unread: { created: 0, changed: 0, total: 0 },
    unreadOpening: false,
    therapists: [], therapistError: "", therapistsLoading: false,
    allTherapistsLabel: "全部>",
    projects: [], projectsLoading: false, projectError: '', moreProjectsLabel: '查看更多>'
  },

  onLoad() {
    userService.business().then((data) => {
      this.setData({ business: data });
    }).catch(() => {});
  },

  onShow() {
    this._homeVisible = true;
    this._unreadNavigating = false;
    this.setData({ unreadOpening: false });
    const requestId = this._showRequestId = (this._showRequestId || 0) + 1;
    this.loadCovers(requestId);
    const app = getApp();
    this.applyIdentity(app.globalData.user);
    this.setData({
      therapistsLoading: !this.data.therapists.length,
      projectsLoading: !this.data.projects.length,
      therapistError: "",
      projectError: ""
    });
    const ready = app.globalData.token && app.refreshMe
      ? app.refreshMe() : Promise.resolve(app.globalData.user);
    return ready.then(() => {
      if (requestId !== this._showRequestId) return;
      this.applyIdentity(app.globalData.user);
      this.refreshUnread();
      // Identity controls quick entries; the public catalogs themselves are
      // anonymous, so shared pending requests are safe across session changes.
      this.loadTherapists();
      this.loadProjects();
    });
  },

  onHide() {
    this._showRequestId = (this._showRequestId || 0) + 1;
    this._homeVisible = false;
    this._inboxRequestId = (this._inboxRequestId || 0) + 1;
    if (this._inboxTimer) clearTimeout(this._inboxTimer);
    this._inboxTimer = null;
  },
  onUnload() { this.onHide(); },

  async loadCovers(requestId) {
    try {
      const covers = await coverService.list();
      if (requestId === this._showRequestId) this.setData({ covers });
    } catch (_) {
      // Keep the last successful set, or the original text banners on a cold start.
    }
  },

  applyIdentity(user) {
    const isAdmin = !!(user && user.role === "admin");
    const isTherapist = !!(user && !isAdmin && user.therapistId);
    const owner = inboxSessionKey();
    if (this._inboxOwner !== owner || (!isAdmin && !isTherapist)) {
      this._inboxOwner = owner;
      this._inboxRequestId = (this._inboxRequestId || 0) + 1;
      if (this._inboxTimer) clearTimeout(this._inboxTimer);
      this.setData({ unread: { created: 0, changed: 0, total: 0 }, unreadOpening: false });
    }
    this.setData({
      isAdmin,
      isTherapist,
      quickEntries: isAdmin ? adminQuickEntries : isTherapist ? therapistQuickEntries : userQuickEntries
    });
  },

  async refreshUnread(navigate = false) {
    if (this._inboxTimer) clearTimeout(this._inboxTimer);
    const app = getApp(), user = app.globalData.user;
    if (!this._homeVisible || !app.globalData.token || !user || (user.role !== 'admin' && !user.therapistId)) return;
    if (this.data.unreadOpening && !navigate) return;
    const owner = inboxSessionKey();
    const requestId = this._inboxRequestId = (this._inboxRequestId || 0) + 1;
    const current = () => this._homeVisible && requestId === this._inboxRequestId && owner === inboxSessionKey();
    try {
      const unread = await appointmentInbox.summary();
      if (!current()) return;
      this.setData({ unread });
      if (navigate) {
        if (!unread.total || !['pending', 'checked_in', 'cancelled'].includes(unread.target)) {
          wx.showToast({ title: '暂无未读消息', icon: 'none' });
        } else {
          this._unreadNavigating = true;
          wx.navigateTo({ url: `/pages/my-appointments/index?status=${unread.target}&inbox=1&${user.role === 'admin' ? 'admin' : 'therapist'}=1`,
            fail: () => {
              if (!current()) return;
              this._unreadNavigating = false;
              this.setData({ unreadOpening: false });
              wx.showToast({ title: '打开失败，请重试', icon: 'none' });
              this._inboxTimer = setTimeout(() => this.refreshUnread(), 30000);
            }
          });
        }
      }
    } catch (error) {
      if (current() && navigate) wx.showToast({ title: error.message || '消息加载失败，请重试', icon: 'none' });
    } finally {
      if (current() && !this._unreadNavigating) {
        this.setData({ unreadOpening: false });
        this._inboxTimer = setTimeout(() => this.refreshUnread(), 30000);
      }
    }
  },

  openUnread() {
    if (!this._homeVisible || this.data.unreadOpening || this._inboxOwner !== inboxSessionKey()) return;
    this.setData({ unreadOpening: true });
    return this.refreshUnread(true);
  },

  loadProjects() {
    const hasProjects = this.data.projects.length > 0;
    this.setData({projectsLoading:!hasProjects,projectError:''});
    projectService.list()
      .then(({items})=>this.setData({projects:items.slice(0,5),projectsLoading:false}))
      .catch(e=>this.setData({projectError:hasProjects ? '' : e.message || '加载失败',projectsLoading:false}));
  },
  openProjects() { wx.navigateTo({url:'/pages/projects/index'}); },
  openProject(e) { wx.navigateTo({url:`/pages/project-detail/index?id=${e.detail.project.id}`}); },
  loadTherapists() {
    const hasTherapists = this.data.therapists.length > 0;
    this.setData({ therapistsLoading: !hasTherapists, therapistError: "" });
    therapistService.list().then(({ therapists }) => this.setData({ therapists, therapistsLoading: false }))
      .catch((error) => this.setData({ therapistError: hasTherapists ? "" : error.message || "加载失败", therapistsLoading: false }));
  },
  openTherapists() { wx.navigateTo({ url: "/pages/therapists/index" }); },
  openTherapist(event) { wx.navigateTo({ url: `/pages/therapist-detail/index?id=${event.detail.therapist.id}` }); },

  onShareAppMessage() {
    return {
      title: this.data.business.name,
      path: "/pages/home/index"
    };
  },

  openLocation() {
    const b = this.data.business;
    if (!b.address) { wx.showToast({ title: "门店地址尚未配置", icon: "none" }); return; }
    wx.openLocation({
      latitude: Number(b.latitude),
      longitude: Number(b.longitude),
      name: b.name,
      address: b.address,
      scale: 16
    });
  },

  callBusiness() {
    if (!this.data.business.phone || /^0+$/.test(String(this.data.business.phone).replace(/\D/g, ""))) { wx.showToast({ title: "门店电话尚未配置", icon: "none" }); return; }
    wx.makePhoneCall({ phoneNumber: this.data.business.phone });
  },

  tapQuick(event) {
    const key = event.currentTarget.dataset.key;
    if (key === "therapistBooking") {
      wx.switchTab({ url: "/pages/booking/index" });
      return;
    }
    if (key === "therapistCheckin") {
      wx.navigateTo({ url: "/pages/my-appointments/index?status=pending&therapist=1" });
      return;
    }
    if (key === "therapistCalendar") {
      wx.setStorageSync("openCalendarOnBooking", true);
      wx.switchTab({ url: "/pages/booking/index" });
      return;
    }
    if (key === "therapistAppointments") {
      wx.navigateTo({ url: "/pages/my-appointments/index?status=all&therapist=1" });
      return;
    }
    if (key === "adminBooking") {
      wx.navigateTo({ url: "/pages/admin/calendar/index" });
      return;
    }
    if (key === "adminBatch") {
      wx.navigateTo({ url: "/pages/admin/batch-slots/index" });
      return;
    }
    if (key === "adminWhitelist") {
      wx.navigateTo({ url: "/pages/admin/whitelist/index" });
      return;
    }
    if (key === "booking") {
      wx.switchTab({ url: "/pages/booking/index" });
      return;
    }
    if (key === "calendar") {
      wx.setStorageSync("openCalendarOnBooking", true);
      wx.switchTab({ url: "/pages/booking/index" });
      return;
    }
    if (key === "checkin") {
      wx.navigateTo({ url: "/pages/my-appointments/index?status=pending&focus=checkin" });
      return;
    }
    if (key === "member") {
      wx.navigateTo({ url: "/pages/member/index" });
    }
  }
});
