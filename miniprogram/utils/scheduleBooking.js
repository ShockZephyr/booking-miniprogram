const { projects } = require("./appointmentDisplay");
const appointments = require("../services/appointment");
const schedules = require("../services/schedules");
const loginReturn = require("./loginReturn");

const initialData = {
  items: [], selectedItemIds: [], itemIndex: -1, note: "", notice: "", editing: false,
  confirming: false, submitting: false, saved: false, unknown: false, formHint: ""
};

function operation(host) {
  const current = getApp()._scheduleWrite;
  // Unresolved writes block the whole session, even after leaving this form.
  if (current && current.owner === host._owner && ["pending", "unknown"].includes(current.state)) return current;
  // A confirmed success only locks its original form. A new page (including
  // the same therapist/date) is a new booking, not a replay of this receipt.
  const receipt = host._bookingWrite;
  return receipt && receipt.owner === host._owner && receipt.state === "saved"
    && receipt.key === host._key && receipt.inputs === host._formInputs ? receipt : null;
}

function prepare(host, target, session) {
  const scope = JSON.stringify([session, target.therapistId, target.appointmentId || ""]);
  const notice = host._formScope === scope && host._formInputs.date === target.date ? host.data.notice : "";
  if (host._formScope !== scope) {
    host._formScope = scope;
    host._formInputs = {};
    host._editing = null;
  }
  const inputs = host._formInputs;
  if (inputs.date !== target.date) {
    inputs.date = target.date;
    delete inputs.start; delete inputs.end;
  }
  const resume = getApp()._bookingResume;
  if (resume && resume.owner === session && resume.url === schedules.dayPath(target.therapistId, target.date)
    && resume.expiresAt > Date.now() && !target.appointmentId) {
    Object.assign(inputs, resume.values);
    delete getApp()._bookingResume;
  }
  const write = operation(host);
  return { ...initialData, notice, note: inputs.note || "", editing: !!target.appointmentId,
    start: inputs.start || "", end: inputs.end || "",
    saved: !!write && write.state === "saved", unknown: !!write && write.state === "unknown",
    submitting: !!write && write.state === "pending" };
}

function hydrate(host, day, catalog, editing, before) {
  const inputs = host._formInputs;
  const items = (catalog && catalog.items || []).filter(item => day.serviceItemIds.includes(item.id));
  const preferred = inputs.serviceItemIds !== undefined ? inputs.serviceItemIds
    : inputs.serviceItemId !== undefined ? [inputs.serviceItemId] : editing ? projects(editing).map(item => item.id) : [];
  const selectedItemIds = items.filter(item => preferred.includes(item.id)).map(item => item.id);
  const itemIndex = items.findIndex(item => selectedItemIds.includes(item.id));
  let notice = host.data.notice;
  if (preferred.some(id => id && !selectedItemIds.includes(id))) notice = "部分原选项目当天不可约，请重新核对";
  if (before && editing && before.id === editing.id && before.version !== editing.version) notice = "原预约已更新（" + editing.startTime + "–" + editing.endTime + "），请核对后再提交";
  if (inputs.note === undefined) inputs.note = editing && editing.note || "";
  inputs.serviceItemIds = selectedItemIds;
  delete inputs.serviceItemId;
  return { items: items.map(item => ({ ...item, checked: selectedItemIds.includes(item.id), wide: Array.from(item.name).length > 6 })), selectedItemIds, itemIndex, note: inputs.note, notice,
    start: inputs.start !== undefined ? inputs.start : editing && editing.startTime || "",
    end: inputs.end !== undefined ? inputs.end : editing && editing.endTime || "" };
}

const methods = {
  bookingLocked() {
    const write = operation(this);
    return this.data.confirming || !!write;
  },
  updateBookingState() {
    if (this.data.role !== "customer") {
      if (this._bookingBusy !== false) { this._bookingBusy = false; this.triggerEvent("busy", { busy: false }); }
      return;
    }
    const write = operation(this);
    const saved = !!write && write.state === "saved", unknown = !!write && write.state === "unknown";
    const submitting = !!write && write.state === "pending";
    let formHint = "";
    if (unknown) formHint = "提交结果尚未确认，请先在我的预约核对";
    else if (!saved && !submitting) {
      if (this.data.stopped) formHint = "预约已结束或状态已变化，无法修改";
      else if (!this.data.items.length) formHint = "当天暂无可约项目";
      else if (!this.data.start) formHint = "请选择开始时间";
      else if (!this.data.end) formHint = "请选择结束时间";
      else if (!this.data.selectedItemIds.length) formHint = "请选择可约项目";
    }
    const patch = { saved, unknown, submitting, formHint };
    if (Object.keys(patch).some(key => patch[key] !== this.data[key])) this.setData(patch);
    const busy = !!write || this.data.confirming;
    if (busy !== this._bookingBusy) { this._bookingBusy = busy; this.triggerEvent("busy", { busy }); }
  },
  acceptsBookingInput(event) {
    return Number(event?.currentTarget?.dataset?.viewVersion) === this.data.viewVersion && this.active(this._key) &&
      this.data.role === "customer" && !this.data.loading && !this.bookingLocked();
  },
  pickItem(event) {
    if (!this.acceptsBookingInput(event)) return;
    if (!Array.isArray(event.detail.value)) return;
    const selected = new Set(event.detail.value);
    const selectedItemIds = this.data.items.filter(item => selected.has(item.id)).map(item => item.id);
    this._formInputs.serviceItemIds = selectedItemIds;
    this.setData({ selectedItemIds, itemIndex: this.data.items.findIndex(item => selected.has(item.id)),
      items: this.data.items.map(item => ({ ...item, checked: selected.has(item.id) })) });
    this.updateBookingState();
  },
  inputNote(event) {
    if (!this.acceptsBookingInput(event)) return;
    this._formInputs.note = String(event.detail.value || "").slice(0, 250);
    this.setData({ note: this._formInputs.note });
  },
  submit() {
    const key = this._key;
    if (!this.active(key) || this.data.loading || this.data.role !== "customer" || this.data.confirming) return;
    this.updateBookingState();
    if (this.data.saved || this.data.unknown) { this.returnToAppointments(); return; }
    if (this.data.submitting || !this.data.day) return;
    this.renderSelection();
    const items = this.data.items.filter(item => this.data.selectedItemIds.includes(item.id));
    if (!this.data.nextReady || !items.length) return;
    const user = getApp().globalData.user, target = this.properties.target;
    if (!user) {
      loginReturn.request(schedules.dayPath(target.therapistId, target.date), {
        start: this.data.start, end: this.data.end, serviceItemIds: items.map(item => item.id), note: this.data.note
      });
      return;
    }
    if (!(user.capabilities && user.capabilities.bookAppointment) && user.effectiveRole !== "member") {
      wx.navigateTo({ url: "/pages/member/index?reason=booking" }); return;
    }
    const snapshot = { key, read: this._read, owner: this._owner, inputs: this._formInputs,
      therapistId: target.therapistId, date: target.date, editing: this._editing,
      payload: { startTime: this.data.start, endTime: this.data.end, serviceItemIds: items.map(item => item.id), note: this.data.note } };
    this.setData({ confirming: true }); this.updateBookingState();
    const complete = () => {
      if (!this.active(key, snapshot.read)) return;
      this.setData({ confirming: false }); this.updateBookingState();
    };
    try {
      wx.showModal({
        title: snapshot.editing ? "确认修改预约" : "确认预约", confirmText: snapshot.editing ? "保存修改" : "提交预约",
        content: [
          `日期：${snapshot.date}`,
          `时段：${snapshot.payload.startTime}–${snapshot.payload.endTime}`,
          `芳疗师：${this.data.day.therapistName}`,
          `项目：${items.map(item => item.name).join("、")}`
        ].join("；"),
        success: result => result.confirm ? this.commitBooking(snapshot) : undefined,
        fail: () => { if (this.active(key)) wx.showToast({ title: "无法打开确认，请重试", icon: "none" }); },
        complete
      });
    } catch (error) { complete(); }
  },
  async commitBooking(snapshot) {
    if (!this.active(snapshot.key) || this._formInputs !== snapshot.inputs) return;
    if (operation(this)) { this.updateBookingState(); return; }
    const user = getApp().globalData.user;
    if (!user || (!(user.capabilities && user.capabilities.bookAppointment) && user.effectiveRole !== "member")) {
      wx.navigateTo({ url: "/pages/member/index?reason=booking" }); return;
    }
    this.renderSelection();
    const selectedIds = this.data.selectedItemIds;
    if (this.data.loading || this._read !== snapshot.read || !this.data.nextReady || !selectedIds.length
      || this.data.start !== snapshot.payload.startTime || this.data.end !== snapshot.payload.endTime
      || [...selectedIds].sort().join() !== [...snapshot.payload.serviceItemIds].sort().join() || this.data.note !== snapshot.payload.note) {
      wx.showToast({ title: "预约信息已更新，请核对后重新提交", icon: "none" }); return;
    }
    const write = { owner: snapshot.owner, key: snapshot.key, inputs: snapshot.inputs, state: "pending" };
    this._bookingWrite = write;
    getApp()._scheduleWrite = write;
    this.setData({ confirming: false, notice: "" }); this.updateBookingState();
    try {
      if (snapshot.editing) await appointments.modify(snapshot.editing.id, { ...snapshot.payload, version: snapshot.editing.version });
      else await appointments.create({ ...snapshot.payload, therapistId: snapshot.therapistId, date: snapshot.date });
      write.state = "saved";
      if (getApp()._scheduleWrite === write) delete getApp()._scheduleWrite;
      if (!this.active(snapshot.key)) return;
      this.updateBookingState();
      wx.showToast({ title: snapshot.editing ? "已修改预约" : "预约成功", icon: "success" });
      this._returnTimer = setTimeout(() => this.returnToAppointments(), 450);
    } catch (error) {
      const unknown = error.code === "NETWORK_ERROR" || error.statusCode >= 500;
      if (unknown) write.state = "unknown";
      else if (getApp()._scheduleWrite === write) delete getApp()._scheduleWrite;
      if (!this.active(snapshot.key)) return;
      this.setData({ notice: unknown ? "提交结果尚未确认，请先在我的预约核对" : error.message || "预约失败，请重试" });
      this.updateBookingState();
      if (error.code === "NOT_MEMBER") wx.navigateTo({ url: "/pages/member/index?reason=booking" });
      else if (!unknown && (error.statusCode === 409 || error.statusCode === 400)) await this.load();
    } finally {
      if (this.active(snapshot.key)) this.updateBookingState();
    }
  },
  returnToAppointments() {
    const key = this._key, write = operation(this);
    if (!this.active(key) || this._returning || !write || !["saved", "unknown"].includes(write.state)) return;
    clearTimeout(this._returnTimer);
    this._returning = true;
    const pages = getCurrentPages(), index = pages.map(page => page.route).lastIndexOf("pages/my-appointments/index");
    const success = () => {
      if (getApp()._scheduleWrite === write) delete getApp()._scheduleWrite;
      if (this._bookingWrite === write) this._bookingWrite = null;
      this._returning = false;
    };
    const fail = () => {
      this._returning = false;
      if (!this.active(key)) return;
      wx.showToast({ title: write.state === "unknown" ? "请返回我的预约核对结果" : "已保存，请返回我的预约", icon: "none" });
    };
    if (this.properties.target.appointmentId && index >= 0) wx.navigateBack({ delta: pages.length - 1 - index, success, fail });
    else wx.redirectTo({ url: "/pages/my-appointments/index?status=" + (write.state === "unknown" ? "all" : "pending"), success, fail });
  }
};

module.exports = { initialData, prepare, hydrate, methods };
