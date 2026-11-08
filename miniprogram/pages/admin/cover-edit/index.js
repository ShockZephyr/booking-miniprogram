const covers = require("../../../services/cover");
const empty = { imageSrc: "", filePath: "", previousImageUrl: "", error: "", saveHint: "", saving: false, uncertain: false };

function canReadDraft(filePath) {
  return new Promise(resolve => wx.getFileSystemManager().access({
    path: filePath, success: () => resolve(true), fail: () => resolve(false)
  }));
}

Page({
  data: { ...empty, id: "", version: 0, loading: true },
  onLoad(query) {
    this._entryId = query.id || "";
    this.setData({ id: this._entryId });
    wx.setNavigationBarTitle({ title: query.id ? "编辑封面" : "新增封面" });
  },
  onShow() {
    this._visible = true;
    if (this._owner && this._owner !== covers.adminOwner()) this.setData({ id: this._entryId });
    if (!this._reload && this._owner && this._owner === covers.adminOwner() && (this._ready || this.data.error)) {
      this.showSaved();
      return;
    }
    return this.reload();
  },
  onHide() {
    this._visible = false;
    if (this.data.saving && !this._saveTask) this._reload = true;
    this._confirming = false;
    this.setData({ version: this.data.version + 1 });
  },
  onUnload() { this.onHide(); this._gone = true; this._picker = null; this._saveTask = null; },
  current(version) {
    return this._visible && this.data.version === version && this._owner && this._owner === covers.adminOwner();
  },
  async reload(event) {
    if (event && (!this._visible || Number(event.currentTarget.dataset.version) !== this.data.version || !this.data.error)) return;
    const version = this.data.version + 1;
    this._ready = false;
    this._reload = false;
    this._picker = null;
    this._uploaded = "";
    this._saveTask = null;
    this._saved = false;
    this._creationKey = "";
    this.setData({ ...empty, version, loading: true });
    try {
      const app = getApp();
      if (app.globalData.token && app.refreshMe) await app.refreshMe();
      if (!this._visible || this.data.version !== version) return;
      this._owner = covers.adminOwner();
      if (!this._owner) throw new Error("无管理员权限");
      const items = await covers.list();
      if (!this.current(version)) return;
      const item = items.find(row => row.id === this.data.id);
      if (this.data.id && !item) throw new Error("这张封面已被删除");
      if (!this.data.id && items.length >= 5) throw new Error("最多只能添加5张封面");
      this._ready = true;
      this._originalSrc = item ? item.imageSrc : "";
      this.setData({ loading: false, previousImageUrl: item ? item.imageUrl : "", imageSrc: this._originalSrc });
    } catch (error) {
      if (this._visible && this.data.version === version) this.setData({ loading: false, error: error.message || "封面加载失败" });
    }
  },
  accepts(event) {
    return this._ready && this.current(Number(event.currentTarget.dataset.version)) && !this.data.saving && !this._confirming && !this._picker;
  },
  choose(event) {
    if (!this.accepts(event) || this.data.uncertain) return;
    const owner = this._owner, picker = this._picker = {};
    // Native media selection can temporarily hide the page. Its only result is a local draft.
    wx.chooseMedia({ count: 1, mediaType: ["image"], sizeType: ["compressed"], success: result => {
      if (this._gone || this._picker !== picker || owner !== covers.adminOwner()) return;
      const file = result.tempFiles && result.tempFiles[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { wx.showToast({ title: "图片不能超过5 MB", icon: "none" }); return; }
      this._uploaded = "";
      this.setData({ filePath: file.tempFilePath, imageSrc: file.tempFilePath, saveHint: "" });
    }, fail: error => {
      if (this._picker === picker && owner === covers.adminOwner() && !String(error.errMsg).includes("cancel")) wx.showToast({ title: "选择图片失败", icon: "none" });
    }, complete: () => { if (this._picker === picker) this._picker = null; } });
  },
  async save(event) {
    if (!this.accepts(event) || !this.data.filePath) return;
    const { id, filePath, previousImageUrl } = this.data;
    const task = this._saveTask = { owner: this._owner };
    const active = () => this._saveTask === task && task.owner === covers.adminOwner() && !this._gone;
    this.setData({ saving: true, saveHint: "" });
    try {
      if (!this._uploaded) {
        const { imageUrl } = await covers.upload(filePath);
        if (!active()) return;
        this._uploaded = imageUrl;
      }
      if (!id && !this._creationKey) {
        // Identifies this draft across retries; session authorization is checked separately.
        this._creationKey = [Date.now().toString(36), Math.random().toString(36).slice(2), Math.random().toString(36).slice(2)].join("-");
      }
      const result = await covers.save(id, this._uploaded, previousImageUrl, this._creationKey);
      if (!active()) return;
      this.setData({ id: result.item.id, previousImageUrl: result.item.imageUrl, filePath: "", uncertain: false });
      this._saved = true;
      this.showSaved();
    } catch (error) {
      if (!active()) return;
      if (error.code === "UPLOAD_NETWORK_ERROR" && !(await canReadDraft(filePath))) {
        if (active()) this.setData({ filePath: "", imageSrc: this._originalSrc, saveHint: "本地图片已不可用，请重新选择" });
      } else if (!active()) {
        return;
      } else if (error.code === "COVER_UPLOAD_MISSING") {
        this._uploaded = "";
        this.setData({ uncertain: false, saveHint: "上传文件已失效，请再次保存以重新上传" });
      } else if (error.statusCode === 409) {
        this._ready = false;
        this.setData({ error: error.message || "封面已变化，请重新加载" });
      } else {
        const uncertain = !!this._uploaded && (error.code === "NETWORK_ERROR" || error.statusCode >= 500 || this.data.uncertain && error.statusCode === 429);
        this.setData({ uncertain, saveHint: uncertain ? "保存结果待确认，请再次点击保存封面" : error.message || "保存失败，请重试" });
      }
    } finally {
      if (active()) {
        this._saveTask = null;
        this.setData({ saving: false });
      }
    }
  },
  showSaved() {
    if (!this._saved || !this._visible || this._owner !== covers.adminOwner()) return;
    this._saved = false;
    wx.showToast({ title: "封面已保存", icon: "success" });
    wx.navigateBack();
  },
  async remove(event) {
    if (!this.accepts(event) || this.data.uncertain || !this.data.id) return;
    const { version, id, previousImageUrl } = this.data;
    this._confirming = true;
    try {
      const confirmed = await new Promise((resolve, reject) => wx.showModal({ title: "删除这张封面？",
        content: "删除后将从首页轮播中移除。", confirmText: "删除", confirmColor: "#8f434c",
        success: result => resolve(result.confirm), fail: reject }));
      if (!confirmed || !this.current(version)) return;
      this.setData({ saving: true });
      await covers.remove(id, previousImageUrl);
      if (!this.current(version)) return;
      this._ready = false;
      this.setData({ error: "这张封面已删除" });
      wx.showToast({ title: "封面已删除", icon: "success" });
      wx.navigateBack();
    } catch (error) { this.failed(version, error); }
    finally {
      if (this.current(version)) { this._confirming = false; this.setData({ saving: false }); }
    }
  },
  failed(version, error) {
    if (!this.current(version)) return;
    const message = error.message || "操作失败，请重试";
    if (error.statusCode === 409) { this._ready = false; this.setData({ error: message }); }
    else wx.showToast({ title: message, icon: "none" });
  }
});
