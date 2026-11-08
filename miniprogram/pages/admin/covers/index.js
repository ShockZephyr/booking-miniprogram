const covers = require("../../../services/cover");

Page({
  data: { items: [], loading: true, saving: false, error: "", dragId: "", previewOrder: {}, version: 0 },
  onShow() { this._visible = true; return this.load(); },
  onHide() { this._visible = false; this.cancelDrag(); },
  onUnload() { this.onHide(); },
  onResize() { this.cancelDrag(); },
  onPageScroll() { this.cancelDrag(); },

  async load() {
    const version = this.data.version + 1;
    this.cancelDrag();
    this._owner = "";
    this.setData({ version, items: [], loading: true, saving: false, error: "" });
    try {
      const app = getApp();
      if (app.globalData.token && app.refreshMe) await app.refreshMe();
      if (!this._visible || this.data.version !== version) return;
      this._owner = covers.adminOwner();
      if (!this._owner) throw new Error("无管理员权限");
      const items = await covers.list();
      if (this.current(version)) this.setData({ items, loading: false });
    } catch (error) {
      if (this._visible && this.data.version === version) this.setData({ loading: false, error: error.message || "封面加载失败" });
    }
  },
  current(version) {
    return this._visible && this.data.version === version && !!this._owner && this._owner === covers.adminOwner();
  },
  canTap(event) {
    return this.current(Number(event.currentTarget.dataset.version)) && !this.data.loading && !this.data.saving && !this.data.error;
  },
  edit(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.canTap(event) || this._drag || Date.now() < this._ignoreTapUntil || !this.data.items.some(item => item.id === id)) return;
    wx.navigateTo({ url: "/pages/admin/cover-edit/index?id=" + encodeURIComponent(id) });
  },
  add(event) {
    if (this.canTap(event) && !this._drag && this.data.items.length < 5) wx.navigateTo({ url: "/pages/admin/cover-edit/index" });
  },
  startDrag(event) {
    if (!this.canTap(event) || this._drag || this.data.items.length < 2) return;
    const original = this.data.items.map(item => item.id);
    const id = event.currentTarget.dataset.id;
    if (!original.includes(id)) return;
    const drag = this._drag = { id, original, order: original, version: this.data.version };
    this.createSelectorQuery().selectAll(".cover-tile").boundingClientRect(rects => {
      if (this._drag !== drag || !this.current(drag.version)) return;
      if (!rects || rects.length !== original.length) { this.cancelDrag(); return; }
      drag.rects = rects;
      this.preview(drag, original.indexOf(id));
      if (drag.touch) this.moveToTouch(drag, drag.touch);
    }).exec();
  },
  preview(drag, target) {
    const order = drag.original.filter(id => id !== drag.id);
    order.splice(target, 0, drag.id);
    drag.order = order;
    const previewOrder = {};
    order.forEach((id, index) => { previewOrder[id] = index; });
    this.setData({ dragId: drag.id, previewOrder });
  },
  moveToTouch(drag, touch) {
    drag.touch = touch;
    if (!drag.rects || !touch) return false;
    const target = drag.rects.findIndex(r => touch.clientX >= r.left && touch.clientX <= r.right &&
      touch.clientY >= r.top && touch.clientY <= r.bottom);
    if (target < 0) return false;
    if (drag.order[target] !== drag.id) this.preview(drag, target);
    return true;
  },
  dragMove(event) {
    if (this._drag && this.canTap(event)) this.moveToTouch(this._drag, event.touches[0]);
  },
  cancelDrag() {
    if (!this._drag) return;
    this._drag = null;
    this._ignoreTapUntil = Date.now() + 350;
    this.setData({ dragId: "", previewOrder: {} });
  },
  async drop(event) {
    const drag = this._drag;
    if (!drag || Number(event.currentTarget.dataset.version) !== drag.version) return;
    const valid = this.canTap(event) && this.moveToTouch(drag, event.changedTouches?.[0] || drag.touch);
    this.cancelDrag();
    if (!valid || drag.order.every((id, i) => id === drag.original[i])) return;
    const items = drag.order.map(id => this.data.items.find(item => item.id === id));
    this.setData({ items, saving: true });
    try {
      await covers.reorder(drag.order, drag.original);
      if (this.current(drag.version)) this.setData({ saving: false });
    } catch (error) {
      if (!this.current(drag.version)) return;
      wx.showToast({ title: error.message || "顺序未保存，请重试", icon: "none" });
      await this.load();
    }
  }
});
