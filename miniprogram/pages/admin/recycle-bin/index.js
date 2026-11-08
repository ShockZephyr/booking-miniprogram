const projectService = require("../../../services/project");
const therapistService = require("../../../services/therapist");

Page({
  data: {
    type: "project",
    noun: "项目",
    items: [],
    selectedIds: [],
    allSelected: false,
    retentionDays: 30,
    loading: true,
    saving: false,
    savingAction: "",
    error: ""
  },

  onLoad(query) {
    const type = query.type === "therapist" ? "therapist" : "project";
    const noun = type === "therapist" ? "芳疗师" : "项目";
    this.setData({ type, noun });
    wx.setNavigationBarTitle({ title: `${noun}回收站` });
  },

  onShow() {
    const app = getApp();
    const requestId = this._identityRequestId = (this._identityRequestId || 0) + 1;
    // A response started by a previous administrator session must never
    // repopulate the page after the active account changes.
    this._listRequestId = (this._listRequestId || 0) + 1;
    if (app.globalData.token && app.refreshMe) {
      this.setData({ loading: true, error: "" });
      app.refreshMe().then((user) => {
        if (requestId !== this._identityRequestId) return;
        this.showForUser(user);
      });
      return;
    }
    this.showForUser(app.globalData.user);
  },

  showForUser(user) {
    if (!user || user.role !== "admin") {
      this.setData({ loading: false, items: [], selectedIds: [], allSelected: false, error: "" });
      wx.showToast({ title: "仅管理员可访问", icon: "none" });
      if (wx.navigateBack) wx.navigateBack();
      return;
    }
    this.load();
  },

  load() {
    if (this.data.saving) return;
    const requestId = this._listRequestId = (this._listRequestId || 0) + 1;
    this.setData({ loading: true, error: "", selectedIds: [], allSelected: false });
    const request = this.data.type === "therapist"
      ? therapistService.recycleBin()
      : projectService.recycleBin();
    request.then((data) => {
      if (requestId !== this._listRequestId) return;
      const source = this.data.type === "therapist" ? data.therapists : data.items;
      this.setData({
        items: (source || []).map((item) => Object.assign({}, item, { selected: false })),
        retentionDays: Number.isInteger(Number(data.retentionDays)) && Number(data.retentionDays) > 0
          ? Number(data.retentionDays)
          : 30,
        loading: false
      });
    }).catch((error) => {
      if (requestId !== this._listRequestId) return;
      this.setData({ loading: false, error: error.message || "回收站加载失败" });
    });
  },

  selectItems(event) {
    if (this.data.saving) return;
    const selectedIds = event.detail.value || [];
    this.setData({
      selectedIds,
      allSelected: !!this.data.items.length && selectedIds.length === this.data.items.length,
      items: this.data.items.map((item) => Object.assign({}, item, { selected: selectedIds.includes(item.id) }))
    });
  },

  toggleAll() {
    if (this.data.saving || !this.data.items.length) return;
    const selectedIds = this.data.allSelected ? [] : this.data.items.map((item) => item.id);
    this.setData({
      selectedIds,
      allSelected: selectedIds.length > 0,
      items: this.data.items.map((item) => Object.assign({}, item, { selected: selectedIds.includes(item.id) }))
    });
  },

  restoreSelected() {
    if (this.data.saving) return;
    const ids = this.data.items.filter((item) => this.data.selectedIds.includes(item.id)).map((item) => item.id);
    if (!ids.length) {
      wx.showToast({ title: `请选择要恢复的${this.data.noun}`, icon: "none" });
      return;
    }
    this.setData({ saving: true, savingAction: "restore" });
    const request = this.data.type === "therapist"
      ? therapistService.restore(ids)
      : projectService.restore(ids);
    request.then(() => {
      wx.showToast({ title: `已恢复 ${ids.length} 项`, icon: "success" });
      this.setData({ saving: false, savingAction: "" });
      this.load();
    }).catch((error) => {
      this.setData({ saving: false, savingAction: "" });
      wx.showToast({ title: error.message || "恢复失败", icon: "none" });
    });
  },

  purgeSelected() {
    if (this.data.saving) return;
    const ids = this.data.items.filter((item) => this.data.selectedIds.includes(item.id)).map((item) => item.id);
    if (!ids.length) {
      wx.showToast({ title: `请选择要删除的${this.data.noun}`, icon: "none" });
      return;
    }
    wx.showModal({
      title: "永久删除？",
      content: `选中的${this.data.noun}将无法恢复，历史预约记录仍会保留。`,
      confirmText: "永久删除",
      confirmColor: "#a04d57",
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ saving: true, savingAction: "purge" });
        const request = this.data.type === "therapist"
          ? therapistService.purge(ids)
          : projectService.purge(ids);
        request.then(() => {
          wx.showToast({ title: `已永久删除 ${ids.length} 项`, icon: "success" });
          this.setData({ saving: false, savingAction: "" });
          this.load();
        }).catch((error) => {
          this.setData({ saving: false, savingAction: "" });
          wx.showToast({ title: error.message || "删除失败", icon: "none" });
        });
      }
    });
  }
});
