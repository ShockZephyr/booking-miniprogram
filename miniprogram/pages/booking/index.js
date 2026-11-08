const dates = require("../../utils/date");
const schedules = require("../../services/schedules");
const calendar = require("../../utils/scheduleCalendar");
const { windowBounds } = require("../../utils/scheduleGrid");
const loginReturn = require("../../utils/loginReturn");
const { imageUrl } = require("../../services/therapist");
const bookingFilters = require("../../utils/bookingFilters");

const labels = { available: "可预约", full: "暂无可约时段", off: "当天休息" };

function loginKey() {
  const app = getApp();
  return (app._loginSessionVersion || 0) + ":" + (app.globalData.token || "");
}

Page(Object.assign({}, bookingFilters.methods, {
  data: {
    ...bookingFilters.initialData,
    selectedDate: "", first: "", last: "", months: [], statusMap: {}, calendarVisible: false,
    therapists: [], target: null, isTherapist: false, isAdmin: false, loading: true, error: "",
    visible: false, revision: 0
  },
  onLoad() {
    this._alive = true;
    const today = dates.today();
    this.setData({ selectedDate: today, first: today, last: today });
  },
  async onShow() {
    const id = this._loadId = (this._loadId || 0) + 1;
    const session = loginKey(), app = getApp();
    const reset = this._session !== session;
    this._session = session;
    const returned = app._bookingDateNavigation === this._dayNavigation ? this._dayNavigation : null;
    this.clearDateNavigation();
    let dateState = {};
    if (reset) {
      const today = dates.today();
      dateState = { selectedDate: today, first: today, last: today, months: [], statusMap: {} };
    } else if (returned && returned.version === (app._loginSessionVersion || 0)
      && returned.session === loginReturn.sessionKey() && /^\d{4}-\d{2}-\d{2}$/.test(returned.date)) {
      dateState = { selectedDate: returned.date, months: [], statusMap: {} };
    }
    const calendarVisible = !!wx.getStorageSync("openCalendarOnBooking");
    if (calendarVisible) wx.removeStorageSync("openCalendarOnBooking");
    this._rosterDate = "";
    this.setData({ ...dateState, visible: false, target: null, therapists: [], loading: true, error: "", calendarVisible });
    if (app.globalData.token && app.refreshMe) await app.refreshMe();
    if (id !== this._loadId) return;
    if (session !== loginKey()) return this.onShow();
    const user = app.globalData.user;
    const filterOwner = loginReturn.sessionKey() + ":" + (app._loginSessionVersion || 0);
    if (reset || this._filterOwner !== filterOwner) this.resetBookingFilters();
    const isAdmin = !!user && user.role === "admin";
    const isTherapist = !!user && !isAdmin && !!user.therapistId;
    this.setData({ isAdmin, isTherapist, visible: true });
    if (wx.setNavigationBarTitle) wx.setNavigationBarTitle({ title: isTherapist ? "我的排班" : "预约" });
    return this.loadDay();
  },
  onHide() {
    this.closeFilterDrawer();
    this._loadId = (this._loadId || 0) + 1;
    this.setData({ visible: false });
  },
  onUnload() {
    this.closeFilterDrawer();
    this._alive = false;
    this._loadId = (this._loadId || 0) + 1;
    this.clearDateNavigation();
  },
  clearDateNavigation() {
    const app = getApp();
    if (app._bookingDateNavigation === this._dayNavigation) app._bookingDateNavigation = null;
    this._dayNavigation = null;
  },
  applyWindow(today, count) {
    const { first, last } = windowBounds(today, count);
    const previous = this.data.selectedDate;
    const selectedDate = previous < first || previous > last ? first : previous;
    const months = dates.buildCalendarMonths(selectedDate, first, last);
    this.setData({ selectedDate, first, last, months });
    return selectedDate === previous;
  },
  async loadDay() {
    this.closeFilterDrawer();
    this.setData({ filterReady: false });
    this._dotsId = (this._dotsId || 0) + 1;
    const id = this._loadId = (this._loadId || 0) + 1;
    const date = this.data.selectedDate, session = loginReturn.sessionKey();
    const current = () => this._alive && this.data.visible && id === this._loadId && date === this.data.selectedDate
      && this._session === loginKey() && session === loginReturn.sessionKey();
    this._rosterDate = "";
    if (this.data.isTherapist) {
      this.setData({ target: { therapistId: getApp().globalData.user.therapistId, date }, revision: this.data.revision + 1, loading: false });
      return;
    }
    this.setData({ loading: true, error: "", therapists: [], statusMap: {} });
    try {
      const data = await schedules.list(date, bookingFilters.query(this.data.filters));
      if (!current()) return;
      if (!this.applyWindow(data.today, data.daysVisible)) return this.loadDay();
      this.receiveBookingFilters(data);
      this.setData({ loading: false, therapists: data.therapists.map((row) => Object.assign({}, row, {
        label: labels[row.status], imageSrc: imageUrl(row.imageUrl)
      })) });
      this._rosterOwner = session;
      this._rosterDate = date;
      return calendar.refreshDots(this);
    } catch (error) {
      if (!current()) return;
      if (date !== dates.today() && error.code === "DATE_OUT_OF_RANGE") {
        this.setData({ selectedDate: dates.today() });
        return this.loadDay();
      }
      this.setData({ loading: false, error: error.message || "排班加载失败，请重试" });
    }
  },
  windowLoaded(event) {
    if (!this.data.isTherapist || !this.data.visible) return;
    if (!this.applyWindow(event.detail.today, event.detail.daysVisible)) this.loadDay();
  },
  resetWindow() {
    if (this.data.selectedDate !== dates.today()) {
      this.setData({ selectedDate: dates.today() });
      this.loadDay();
    }
  },
  changeDate(event) {
    const date = event.detail.date;
    if (!this.data.visible || this._session !== loginKey()
      || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < this.data.first || date > this.data.last) return;
    this.setData({ calendarVisible: false });
    if (date === this.data.selectedDate) return;
    this.clearDateNavigation();
    this.setData({ selectedDate: date });
    this.loadDay();
  },
  moveCalendar(event) {
    this.setData({ months: calendar.nextMonths(this.data, event.detail.direction) });
    calendar.refreshDots(this);
  },
  openCalendar() {
    this.closeFilterDrawer();
    this.setData({ calendarVisible: true, months: dates.buildCalendarMonths(this.data.selectedDate, this.data.first, this.data.last) });
  },
  closeCalendar() { this.setData({ calendarVisible: false }); },
  openDay(event) {
    const id = event.detail && event.detail.therapist ? event.detail.therapist.id : event.currentTarget.dataset.id;
    if (!this.data.visible || this._session !== loginKey() || this._rosterOwner !== loginReturn.sessionKey()
      || this._dayNavigation || this._rosterDate !== this.data.selectedDate
      || this.data.loading || !this.data.therapists.some((item) => item.id === id)) return;
    const session = loginReturn.sessionKey();
    const app = getApp();
    // A returned date belongs to one visit, not to the whole login session.
    const navigation = {
      id: String(app._bookingNavigationId = (app._bookingNavigationId || 0) + 1),
      session, version: app._loginSessionVersion || 0,
      therapistId: id, sourceDate: this.data.selectedDate, date: ""
    };
    this._dayNavigation = navigation;
    app._bookingDateNavigation = navigation;
    wx.navigateTo({
      url: schedules.dayPath(id, this.data.selectedDate, "", navigation.id),
      fail: () => {
        if (this._dayNavigation === navigation) this.clearDateNavigation();
      },
      events: {
        dateChange: (payload = {}) => {
          const date = payload.date;
          if (!this._alive || this._dayNavigation !== navigation || app._bookingDateNavigation !== navigation
            || session !== loginReturn.sessionKey() || this._session !== loginKey()
            || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < this.data.first || date > this.data.last) return;
          // Apply together with a fresh roster on return; never change the hidden page alone.
          navigation.date = date;
        }
      }
    });
  }
}));
