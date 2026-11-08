const loginReturn = require("../../../utils/loginReturn");
const admin = require("../../../services/admin");
const checkIn = require("../../../utils/checkIn");
const confirmation = require("../../../utils/confirmation");
const statusNames = { booked: "已预约", checked_in: "已签到", no_show: "未签到", cancelled: "已取消" };
function decorate(a) {
  return { ...a, statusText: statusNames[a.status] || a.status,
    bookedText: (a.createdAt || "").slice(0,16).replace("T"," ") || "—",
    checkedInText: (a.checkedInAt || "").slice(0,16).replace("T"," ") || "暂未签到",
    canCheckIn: checkIn.canCheckIn(a) };
}
Page({
  data: { appointmentId: "", currentAppointment: null, historyAppointments: [], loading: true, error: "", signing: false },
  onLoad(query) { this.setData({ appointmentId: query.appointmentId || "" }); },
  onShow() {
    confirmation.reconcile(this);
    checkIn.startWatching(this, this.refreshCheckInAvailability);
    this.load();
  },
  onHide() { checkIn.stopWatching(this); },
  onUnload() { this._unloaded = true; confirmation.clear(this); checkIn.stopWatching(this); },
  retryLoad() { if (!this.data.loading) return this.load(); },
  async load() {
    const id = this.data.appointmentId;
    const read = this._detailRequestId = (this._detailRequestId || 0) + 1;
    this.setData({ loading: true, error: "", currentAppointment: null, historyAppointments: [] });
    const owner = loginReturn.sessionKey();
    const current = () => !this._unloaded && this._detailRequestId === read && owner === loginReturn.sessionKey();
    try {
      if (!id) throw new Error("请选择一笔预约");
      if (!await loginReturn.ensure("/pages/admin/slot-appointment/index?appointmentId=" + id, "admin")) throw new Error("请使用管理员账号");
      if (!current()) return;
      const result = await admin.appointment(id);
      if (!current()) return;
      if (!result.appointment || result.appointment.id !== id) throw new Error("预约不存在");
      this.setData({ currentAppointment: decorate(result.appointment), historyAppointments: result.history || [] });
    } catch (error) { if (current()) this.setData({ error: error.message || "预约加载失败" }); }
    finally { if (current()) this.setData({ loading: false }); }
  },
  refreshCheckInAvailability() {
    const a = this.data.currentAppointment;
    if (a && !this.data.loading && a.canCheckIn !== checkIn.canCheckIn(a)) this.setData({ currentAppointment: decorate(a) });
  },
  action(event) {
    const a = this.data.currentAppointment, type = event.detail && event.detail.type || event.currentTarget.dataset.type;
    if (!a || this.data.loading || this.data.signing) return;
    const id = a.id;
    const common = { appointment: a, isTargetCurrent: () => this.data.appointmentId === id
      && (!this.data.currentAppointment || this.data.currentAppointment.id === id), refresh: () => this.load() };
    if (type === "checkIn" && checkIn.canCheckIn(a)) return confirmation.confirmCheckIn(this, {
      ...common, modal: { title: "为用户签到", content: "请确认用户已经到店", confirmText: "确认签到" },
      read: admin.appointment, submit: admin.adminCheckInAppointment
    });
    const undo = type === "uncheckIn" && a.status === "checked_in";
    if (!undo && !(type === "cancel" && ["booked","no_show"].includes(a.status))) return;
    return confirmation.start(this, { ...common, progress: "正在处理…",
      modal: { title: undo ? "取消签到" : "取消预约", content: undo ? "取消这笔预约的签到记录？" : "确认取消这笔预约？", confirmText: "确认" },
      run: async ({ current }) => {
        await (undo ? admin.adminUncheckInAppointment(id) : admin.adminCancelAppointment(id));
        if (current()) { wx.showToast({ title: undo ? "已取消签到" : "预约已取消" }); await this.load(); }
      }
    });
  }
});
