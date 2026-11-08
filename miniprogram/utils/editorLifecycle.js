function owner() {
  const app = getApp();
  return [app._loginSessionVersion || 0, app.globalData.token || "", app.globalData.user?.id || ""].join(":");
}

module.exports = {
  startEditor() { this._editorOwner = owner(); },
  onShow() {
    this._editorVisible = true;
    this.showEditorReceipt();
  },
  onHide() {
    this._editorVisible = false;
    this._editorRevision = (this._editorRevision || 0) + 1;
  },
  onUnload() { this.onHide(); this._editorGone = true; },
  ownsEditor() { return !this._editorGone && this._editorOwner === owner(); },
  editorSaved(message, title) {
    this._editorReceipt = { message, title };
    this.showEditorReceipt();
  },
  showEditorReceipt() {
    if (!this._editorReceipt || !this.isCurrentEditor()) return;
    const { title, message } = this._editorReceipt;
    this._editorReceipt = null;
    if (title) wx.setNavigationBarTitle({ title });
    wx.showToast({ title: message, icon: "none" });
  },
  isCurrentEditor() {
    return this.ownsEditor() && this._editorVisible !== false && getCurrentPages().slice(-1)[0] === this;
  },
  editorAction() {
    const revision = this._editorRevision;
    return () => revision === this._editorRevision && this.isCurrentEditor();
  }
};
