const appointments = require("../../services/appointment");
const loginReturn = require("../../utils/loginReturn");
const checkIn = require("../../utils/checkIn");
const confirmation = require("../../utils/confirmation");
const date = require("../../utils/date");
const statusNames = { booked: "已预约", checked_in: "已签到", no_show: "未签到", cancelled: "已取消" };

Page({
  data: { appointmentId: "", appointment: null, historyAppointments: [], historyUnavailable: false,
    loading: true, error: "", signing: false },
  onLoad(query) { this.setData({ appointmentId: query.appointmentId || "" }); },
  onShow() {
    this._hidden = false;
    this._owner = loginReturn.sessionKey();
    this._openingEditor = false;
    confirmation.reconcile(this);
    checkIn.startWatching(this, this.refreshAvailability);
    this.load();
  },
  onHide() { this._hidden = true; checkIn.stopWatching(this); },
  onUnload() { this._unloaded = true; confirmation.clear(this); checkIn.stopWatching(this); },
  decorate(appointment) {
    const user = getApp().globalData.user;
    return { ...appointment, statusText: statusNames[appointment.status] || appointment.status,
      canCheckIn: checkIn.canCheckIn(appointment), canCancel: ["booked", "no_show"].includes(appointment.status),
      canModify: !!(user && user.capabilities && user.capabilities.bookAppointment)
        && ["booked", "checked_in"].includes(appointment.status) && !date.isExpired(appointment.date, appointment.endTime) };
  },
  refreshAvailability() {
    if (this.data.loading || !this.data.appointment) return;
    const next = this.decorate(this.data.appointment);
    if (next.canCheckIn !== this.data.appointment.canCheckIn || next.canModify !== this.data.appointment.canModify) this.setData({ appointment: next });
  },
  async load() {
    if (this._unloaded) return;
    const id = this.data.appointmentId, read = this._read = (this._read || 0) + 1;
    const owner = loginReturn.sessionKey();
    const current = () => !this._unloaded && read === this._read && owner === loginReturn.sessionKey();
    this.setData({ loading: true, error: "", appointment: null, historyAppointments: [] });
    try {
      if (!id) throw new Error("预约不存在");
      if (!await loginReturn.ensure("/pages/appointment-detail/index?appointmentId=" + encodeURIComponent(id))) throw new Error("请先登录");
      if (!current()) return;
      const user = getApp().globalData.user;
      if (user.role === "admin" || user.therapistId) throw new Error("请从对应身份的预约列表查看");
      const result = await appointments.detail(id, { includeHistory: true });
      if (!current()) return;
      if (!result.appointment || result.appointment.id !== id) throw new Error("预约不存在");
      this.setData({ appointment: this.decorate(result.appointment), historyAppointments: result.history || [],
        historyUnavailable: !Array.isArray(result.history) });
    } catch (error) { if (current()) this.setData({ error: error.message || "加载失败" }); }
    finally { if (current()) this.setData({ loading: false }); }
  },
  action(event) {
    const appointment = this.data.appointment, type = event.detail.type;
    if (this._unloaded || this._hidden || this._owner !== loginReturn.sessionKey() || this.data.loading || this.data.signing || !appointment) return;
    const id = appointment.id;
    const user = getApp().globalData.user;
    if (!user || appointment.userId !== user.id || user.role === "admin" || user.therapistId) return;
    const common = { appointment, isTargetCurrent: () => this.data.appointmentId === id,
      refresh: () => this.load() };
    if (type === "checkIn" && checkIn.canCheckIn(appointment)) return confirmation.confirmCheckIn(this, {
      ...common, modal: { title: "确认签到", content: "请确认本人已到店。后续如需取消签到，请联系管理员。", confirmText: "确认签到" },
      read: appointments.detail, submit: appointments.checkIn
    });
    if (type === "cancel" && appointment.canCancel) return confirmation.start(this, {
      ...common, modal: { title: "取消预约", content: "确认取消这笔预约？", confirmText: "确认取消" },
      run: async ({ current }) => {
        await appointments.cancel(id);
        if (current()) { wx.showToast({ title: "预约已取消" }); await this.load(); }
      }
    });
    if (type === "modify" && this.decorate(appointment).canModify && !this._openingEditor) {
      this._openingEditor = true;
      wx.navigateTo({ url: `/pages/schedule-day/index?therapistId=${encodeURIComponent(appointment.therapistId)}&date=${appointment.date}&appointmentId=${encodeURIComponent(id)}`,
        fail: () => { this._openingEditor = false; if (!this._unloaded) wx.showToast({ title: "无法打开预约，请重试", icon: "none" }); } });
    }
  }
});
