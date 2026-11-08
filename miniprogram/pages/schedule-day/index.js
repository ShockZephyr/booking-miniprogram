const loginReturn = require("../../utils/loginReturn");
const schedules = require("../../services/schedules");
const dates = require("../../utils/date");
const { windowBounds } = require("../../utils/scheduleGrid");
const calendar = require("../../utils/scheduleCalendar");

Page({
  data: { target: null, visible: false, revision: 0, error: "", first: "", last: "", months: [], calendarVisible: false, statusMap: {}, hideDots: true, bookingBusy: false },
  onLoad(query) {
    const { therapistId, date, appointmentId = "" } = query;
    this._alive = true;
    const app = getApp(), navigation = app._bookingDateNavigation;
    if (query.from === "booking" && !appointmentId && navigation && query.returnId === navigation.id
      && navigation.therapistId === therapistId && navigation.sourceDate === date
      && navigation.session === loginReturn.sessionKey() && navigation.version === (app._loginSessionVersion || 0)) {
      this._dateNavigation = navigation;
    }
    if (!therapistId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      this.setData({ error: "请选择芳疗师和日期" });
      return;
    }
    this.setData({ target: { therapistId, date, appointmentId }, first: date, last: date });
  },
  async onShow() {
    const serial = this._showId = (this._showId || 0) + 1;
    const target = this.data.target;
    if (!target) return;
    const app = getApp();
    if (app.globalData.token && app.refreshMe) await app.refreshMe();
    if (serial !== this._showId) return;
    if (target.appointmentId && !app.globalData.user) {
      loginReturn.request(schedules.dayPath(target.therapistId, target.date, target.appointmentId));
      this.setData({ error: "请登录预约账号后重试" });
      return;
    }
    const user = app.globalData.user;
    this.setData({ visible: true, error: "", hideDots: !user || user.role === "admin" || !!user.therapistId,
      statusMap: {}, revision: this.data.revision + 1 });
  },
  async windowLoaded(event) {
    if (!this.data.visible) return;
    const target = this.data.target;
    const bounds = target.appointmentId ? { first: target.date, last: target.date }
      : windowBounds(event.detail.today, event.detail.daysVisible);
    const months = dates.buildCalendarMonths(target.date, bounds.first, bounds.last);
    this.setData({ ...bounds, months, statusMap: {} });
    return calendar.refreshDots(this);
  },
  openCalendar() {
    if (this.data.target && !this.data.target.appointmentId && !this.data.bookingBusy) this.setData({ calendarVisible: true });
  },
  closeCalendar() { this.setData({ calendarVisible: false }); },
  moveCalendar(event) {
    this.setData({ months: calendar.nextMonths(this.data, event.detail.direction) });
    calendar.refreshDots(this);
  },
  changeDate(event) {
    const date = event.detail.date, target = this.data.target;
    if (!this._alive || !this.data.visible || !target || target.appointmentId || this.data.bookingBusy
      || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < this.data.first || date > this.data.last) return;
    this._dotsId = (this._dotsId || 0) + 1;
    this.setData({ target: { ...target, date }, calendarVisible: false, statusMap: {} });
    this.notifyOpenerDate(date);
  },
  notifyOpenerDate(date) {
    const app = getApp(), navigation = this._dateNavigation;
    if (!this._alive || !this.data.visible || !navigation || app._bookingDateNavigation !== navigation
      || navigation.session !== loginReturn.sessionKey() || navigation.version !== (app._loginSessionVersion || 0)
      || date !== this.data.target.date) return;
    navigation.date = date;
    try {
      const channel = this.getOpenerEventChannel && this.getOpenerEventChannel();
      if (channel && channel.emit) channel.emit("dateChange", { date });
    } catch (error) {
      // A direct entry has no opener page; its own date selection still works.
    }
  },
  resetWindow() {
    const target = this.data.target, today = dates.today();
    if (target && !target.appointmentId && target.date !== today) {
      this.setData({ target: { ...target, date: today } });
      this.notifyOpenerDate(today);
    }
  },
  bookingState(event) {
    this.setData({ bookingBusy: !!event.detail.busy });
  },
  onHide() { this._showId = (this._showId || 0) + 1; this.setData({ visible: false }); },
  onUnload() { this._alive = false; this._showId = (this._showId || 0) + 1; }
});
