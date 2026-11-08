const loginReturn = require("../../../utils/loginReturn");
const portal = require("../../../services/therapistPortal");
const checkIn = require("../../../utils/checkIn");
const confirmation = require("../../../utils/confirmation");

function statusText(status) {
  return { booked: "已预约", no_show: "未签到", checked_in: "已签到", cancelled: "已取消" }[status] || status || "-";
}

Page({
  data: { appointmentId: "", appointment: null, historyAppointments: [], historyUnavailable: false, loading: true, error: "", signing: false },

  onLoad(query) {
    this._unloaded = false;
    this.setData({ appointmentId: query.appointmentId || "" });
    wx.setNavigationBarTitle({ title: "预约详情" });
  },

  onShow() {
    if (this._confirmedAction) confirmation.reconcile(this);
    checkIn.startWatching(this, this.refreshCheckInAvailability);
    if (!this.data.appointmentId) {
      this.setData({ loading: false, error: "预约不存在" });
      return;
    }
    this.load();
  },

  onHide() { checkIn.stopWatching(this); },
  onUnload() {
    this._unloaded = true;
    if (this._confirmedAction) confirmation.clear(this);
    this._detailRequestId = (this._detailRequestId || 0) + 1;
    checkIn.stopWatching(this);
  },

  refreshCheckInAvailability() {
    const appointment = this.data.appointment;
    if (!appointment || this.data.loading) return;
    const canCheckIn = checkIn.canCheckIn(appointment);
    if (appointment.canCheckIn !== canCheckIn) this.setData({ appointment: Object.assign({}, appointment, { canCheckIn }) });
  },

  async load() {
    if (this._unloaded) return;
    const version = this._detailRequestId = (this._detailRequestId || 0) + 1;
    const target = "/pages/therapist/appointment-detail/index?" + "appointmentId=" + encodeURIComponent(this.data.appointmentId);
    this.setData({ loading: true, error: "", appointment: null, historyAppointments: [], historyUnavailable: false });
    if (loginReturn.ensure && !await loginReturn.ensure(target, "therapist")) {
      if (version === this._detailRequestId) this.setData({ loading: false, error: "请登录有权查看该预约的账号" });
      return;
    }
    if (version !== this._detailRequestId) return;
    const owner = loginReturn.sessionKey ? loginReturn.sessionKey() : "test";
    const current = () => version === this._detailRequestId && (!loginReturn.sessionKey || owner === loginReturn.sessionKey());
    this.setData({ loading: true, error: "" });
    return portal.appointment(this.data.appointmentId, { includeHistory: true }).then(({ appointment, history }) => {
      if (!current()) return;
      if (!appointment || appointment.id !== this.data.appointmentId) throw new Error("预约不存在");
      const displayName = appointment.whitelistRemarkName || appointment.userNickname || "预约用户";
      this.setData({
        appointment: Object.assign({}, appointment, {
          displayName,
          avatarText: displayName.slice(0, 1),
          statusText: statusText(appointment.status),
          canCheckIn: checkIn.canCheckIn(appointment)
        }),
        historyAppointments: Array.isArray(history) ? history : [],
        historyUnavailable: !Array.isArray(history),
        loading: false
      });
    }).catch((error) => {
      if (!current()) return;
      if (["INVALID_SESSION", "NOT_LOGGED_IN"].includes(error.code) && loginReturn.request) loginReturn.request(target);
      this.setData({ loading: false, error: error.message || "加载失败" });
    });
  },

  action(event) { if (event.detail.type === "checkIn") return this.checkIn(); },

  checkIn() {
    const appointment = this.data.appointment;
    if (this._unloaded || this.data.loading || !appointment || !appointment.id || !appointment.canCheckIn) return;
    const id = appointment.id, appointmentId = this.data.appointmentId;
    return confirmation.confirmCheckIn(this, {
      appointment,
      isTargetCurrent: () => appointmentId === this.data.appointmentId
        && (!this.data.appointment || this.data.appointment.id === id),
      modal: { title: "为用户签到", content: "请确认用户已经到店", confirmText: "确认签到", confirmColor: "#5c556b" },
      read: (id) => portal.appointment(id),
      submit: (id) => portal.checkIn(id),
      refresh: () => this.load()
    });
  }
});
