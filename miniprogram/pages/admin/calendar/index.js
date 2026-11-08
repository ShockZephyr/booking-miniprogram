const admin = require("../../../services/admin");
const therapists = require("../../../services/therapist");
const session = require("../../../utils/loginReturn");
const settingsSave = require("../../../utils/scheduleSettingsSave");

function daysCanSave(input, savedDays) {
  const value = Number(input);
  return Number.isInteger(value) && value >= 1 && value <= 2147483647 && value !== savedDays;
}

Page({
  data: { loading: true, saving: false, error: "", therapists: [], daysVisible: "", savedDays: 0, daysFeedback: "", daysSaveError: false },
  async onShow() {
    this._visible = true;
    const show = this._show = (this._show || 0) + 1, owner = session.sessionKey();
    await settingsSave.wait(owner);
    if (this._visible && !this._gone && show === this._show && owner === session.sessionKey()) return this.load();
  },
  onHide() { this._visible = false; this.flushDays(); },
  onUnload() {
    this.flushDays();
    this._visible = false;
    this._read = (this._read || 0) + 1;
    this._gone = true;
  },
  cancelDaysTimer() {
    if (this._daysTimer) clearTimeout(this._daysTimer);
    this._daysTimer = null;
  },
  async load() {
    this.cancelDaysTimer();
    const read = this._read = (this._read || 0) + 1;
    const owner = session.sessionKey();
    const draft = this._owner === owner && this.data.daysSaveError ? this.data.daysVisible : null;
    this._owner = owner;
    const current = () => !this._gone && read === this._read && owner === session.sessionKey();
    this.setData({ loading: true, error: "", therapists: [], saving: false,
      daysFeedback: draft !== null ? "保存失败，点击重试" : "", daysSaveError: draft !== null });
    try {
      if (!await session.ensure("/pages/admin/calendar/index", "admin")) throw new Error("请使用管理员账号");
      const [settings, people] = await Promise.all([admin.scheduleSettings(), therapists.list()]);
      if (current()) {
        const unsaved = draft !== null && Number(draft) !== settings.daysVisible;
        this.setData({ daysVisible: unsaved ? draft : String(settings.daysVisible), savedDays: settings.daysVisible,
          therapists: people.therapists, daysSaveError: unsaved, daysFeedback: unsaved ? "保存失败，点击重试" : "" });
      }
    } catch (error) {
      if (current()) this.setData({ error: error.message || "加载失败" });
    } finally {
      if (current()) this.setData({ loading: false });
    }
  },
  inputDays(event) {
    if (this._gone || this._owner !== session.sessionKey() || this.data.loading || this.data.saving) return;
    this.cancelDaysTimer();
    const daysVisible = event.detail.value;
    this.setData({ daysVisible, daysFeedback: "", daysSaveError: false });
    if (daysCanSave(daysVisible, this.data.savedDays)) {
      this._daysTimer = setTimeout(() => { this._daysTimer = null; this.saveDays(); }, 500);
    }
  },
  flushDays() {
    this.cancelDaysTimer();
    if (!this.data.daysSaveError) return this.saveDays();
  },
  saveDays() {
    this.cancelDaysTimer();
    if (this._gone || this._owner !== session.sessionKey() || this.data.loading) return;
    if (this.data.saving) return this._saveTask;
    const value = Number(this.data.daysVisible);
    if (!Number.isInteger(value) || value < 1 || value > 2147483647) {
      this.setData({ daysFeedback: "请输入有效的正整数", daysSaveError: false }); return;
    }
    if (value === this.data.savedDays) {
      this.setData({ daysVisible: String(value), daysFeedback: "", daysSaveError: false }); return;
    }
    const read = this._read, owner = session.sessionKey();
    const current = () => !this._gone && read === this._read && owner === session.sessionKey();
    this.setData({ saving: true, daysFeedback: "", daysSaveError: false });
    this._saveTask = settingsSave.track(owner, (async () => {
      try {
        const result = await admin.setScheduleSettings(value);
        if (!current()) return;
        this.setData({ savedDays: result.daysVisible, daysVisible: String(result.daysVisible) });
        if (this._visible !== false) wx.showToast({ title: "已保存" });
      } catch (error) {
        if (current()) this.setData({ daysSaveError: true, daysFeedback: (error.message || "保存失败") + "，点击重试" });
      } finally { if (current()) this.setData({ saving: false }); }
    })());
    return this._saveTask;
  },
  edit(event) {
    const id = event.detail && event.detail.therapist && event.detail.therapist.id;
    if (this.data.therapists.some(person => person.id === id)) wx.navigateTo({ url: "/pages/admin/batch-slots/index?therapistId=" + encodeURIComponent(id) });
  },
  batch() { wx.navigateTo({ url: "/pages/admin/batch-slots/index" }); }
});
