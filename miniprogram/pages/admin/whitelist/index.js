const adminService = require("../../../services/admin");
const SEARCH_DELAY_MS = 400;

function sessionKey() {
  const app = typeof getApp === "function" ? getApp() : null;
  const data = app && app.globalData;
  return data ? JSON.stringify([app._loginSessionVersion || 0, data.token, data.user && data.user.id, data.user && data.user.role]) : "test";
}

Page({
  data: {
    keyword: "",
    items: [],
    phone: "",
    remarkName: "",
    editingId: "",
    editingReviewMember: false,
    restoringId: "",
    selectedIds: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    nextCursor: "",
    searchPending: false,
    resultsStale: false,
    resultKeyword: "",
    failedAppend: false,
    saving: false,
    failedActionIcons: {},
    error: ""
  },

  onShow() {
    this._visible = true;
    this._restoreId = (this._restoreId || 0) + 1;
    this.setData({ restoringId: "" });
    this.cancelSearchTimer();
    const owner = sessionKey();
    if (this._owner !== undefined && this._owner !== owner) {
      this._saveId = (this._saveId || 0) + 1;
      this._draftVersion = (this._draftVersion || 0) + 1;
      this.setData({ phone: "", remarkName: "", editingId: "", editingReviewMember: false, keyword: "", items: [], selectedIds: [], saving: false });
    }
    this._owner = owner;
    this.load();
  },

  input(event) {
    const key = event.currentTarget.dataset.key;
    if (key === "keyword") {
      this.changeKeyword(event.detail.value);
      return;
    }
    if (!["phone", "remarkName"].includes(key)) return;
    if (key === "phone" && this.data.editingReviewMember) return;
    this._draftVersion = (this._draftVersion || 0) + 1;
    this.setData({ [key]: event.detail.value });
  },

  actionIconError(event) {
    if (this._visible === false || (this._owner !== undefined && this._owner !== sessionKey())) return;
    const icon = event.currentTarget.dataset.icon;
    if (!["edit", "search", "delete"].includes(icon) || this.data.failedActionIcons[icon]) return;
    this.setData({ failedActionIcons: Object.assign({}, this.data.failedActionIcons, { [icon]: true }) });
  },

  cancelSearchTimer() {
    if (this._searchTimer != null) clearTimeout(this._searchTimer);
    this._searchTimer = null;
  },

  changeKeyword(value, immediate = false) {
    const keyword = String(value || "");
    if (keyword === this.data.keyword && !immediate) return;
    this.cancelSearchTimer();
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const owner = sessionKey();
    this.setData({
      keyword, selectedIds: [],
      items: this.data.items.map((item) => Object.assign({}, item, { checked: false })),
      searchPending: true, resultsStale: true,
      loading: false, loadingMore: false, hasMore: false, nextCursor: "",
      error: "", failedAppend: false
    });
    if (immediate || !keyword.trim()) {
      this.search();
      return;
    }
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      if (this._visible !== false && requestId === this._requestId && owner === sessionKey()) this.search();
    }, SEARCH_DELAY_MS);
  },

  search() {
    this.cancelSearchTimer();
    return this.load({ dedupe: true });
  },

  clearSearch() {
    this.changeKeyword("", true);
    // Keep the search field and the start of the results visible; don't alter the member draft.
    if (this._visible !== false && wx.pageScrollTo) wx.pageScrollTo({ selector: ".search", duration: 0 });
  },

  retrySearch() {
    if (this.data.failedAppend) return this.load({ append: true });
    return this.search();
  },

  canUseResults() {
    return this._visible !== false && !this.data.searchPending && !this.data.resultsStale
      && !this.data.restoringId
      && !this.data.loading && !this.data.loadingMore
      && (this._owner === undefined || this._owner === sessionKey());
  },

  onHide() {
    this._visible = false;
    this.cancelSearchTimer();
    this._requestId = (this._requestId || 0) + 1;
  },
  onUnload() { this.onHide(); this._saveId = (this._saveId || 0) + 1; },
  onReachBottom() { this.load({ append: true }); },

  load(options = {}) {
    if (this._visible === false) return;
    const append = !!options.append;
    if (append && (!this.data.hasMore || !this.canUseResults())) return;
    this.cancelSearchTimer();
    const app = typeof getApp === "function" ? getApp() : null;
    const owner = sessionKey();
    const keyword = this.data.keyword;
    if (!append && options.dedupe && this.data.loading && this._queryKeyword === keyword && this._queryOwner === owner) return;
    const requestId = this._requestId = (this._requestId || 0) + 1;
    const current = () => this._visible !== false && requestId === this._requestId && owner === sessionKey() && keyword === this.data.keyword;
    if (app && (!app.globalData.user || app.globalData.user.role !== "admin")) {
      this.setData({ items: [], selectedIds: [], phone: "", remarkName: "", editingId: "", editingReviewMember: false, loading: false, loadingMore: false,
        searchPending: false, resultsStale: true, hasMore: false, nextCursor: "", error: "无管理员权限" }); return;
    }
    this._queryKeyword = keyword;
    this._queryOwner = owner;
    if (!append) this.setData({
      selectedIds: [], hasMore: false, nextCursor: "", resultsStale: true,
      items: this.data.items.map((item) => Object.assign({}, item, { checked: false }))
    });
    this.setData({ loading: !append, loadingMore: append, searchPending: false, error: "", failedAppend: false });
    return adminService.whitelist({ keyword: keyword.trim(), status: "active", includeInactiveReview: true, cursor: append ? this.data.nextCursor : "" }).then((data) => {
      if (!current()) return;
      const selected = this.data.selectedIds;
      const items = append ? this.data.items.concat(data.items || []) : (data.items || []);
      this.setData({
        loading: false, loadingMore: false, resultsStale: false, resultKeyword: keyword.trim(),
        hasMore: !!(data.pagination && data.pagination.hasMore),
        nextCursor: data.pagination && data.pagination.nextCursor || "",
        items: Array.from(new Map(items.map((item) => [item.id, Object.assign({}, item, {
          checked: selected.indexOf(item.id) >= 0
        })])).values())
      });
    }).catch((error) => {
      if (current()) this.setData({ loading: false, loadingMore: false, failedAppend: append, error: error.message || "白名单加载失败" });
    });
  },

  save() {
    const owner = sessionKey();
    // Form saves are independent of list loading, but must belong to the visible login session.
    if (this._visible !== true || this._owner !== owner || this.data.saving) return;
    const editingId = this.data.editingId;
    const draftVersion = this._draftVersion || 0;
    const saveId = this._saveId = (this._saveId || 0) + 1;
    const current = () => saveId === this._saveId && owner === sessionKey();
    const payload = { phone: this.data.phone, remarkName: this.data.remarkName };
    if (editingId && this.data.editingReviewMember) delete payload.phone;
    this.setData({ saving: true });
    const action = editingId
      ? adminService.updateWhitelist(editingId, payload)
      : adminService.addWhitelist(payload);
    return action.then(() => {
      if (!current()) return;
      wx.showToast({ title: editingId ? "已更新" : "已添加" });
      if (draftVersion === (this._draftVersion || 0) && editingId === this.data.editingId) {
        this.setData({ phone: "", remarkName: "", editingId: "", editingReviewMember: false });
      }
      this.load();
    }).catch((error) => {
      if (current()) wx.showToast({ title: error.message || (editingId ? "更新失败" : "添加失败"), icon: "none" });
    }).finally(() => {
      if (current()) this.setData({ saving: false });
    });
  },

  edit(event) {
    if (!this.canUseResults()) return;
    const id = event.currentTarget.dataset.id;
    const item = this.data.items.find((entry) => entry.id === id);
    if (!item || item.status === "inactive") return;
    this._draftVersion = (this._draftVersion || 0) + 1;
    this.setData({ editingId: id, editingReviewMember: !!item.isReviewMember, phone: item.phone, remarkName: item.remarkName || "" });
  },

  cancelEdit() {
    this._draftVersion = (this._draftVersion || 0) + 1;
    this.setData({ editingId: "", phone: "", remarkName: "", editingReviewMember: false });
  },

  restoreReviewMember(event) {
    if (!this.canUseResults()) return;
    const id = event.currentTarget.dataset.id;
    const item = this.data.items.find(entry => entry.id === id);
    if (!item || !item.isReviewMember || item.status !== "inactive") return;
    const owner = sessionKey(), requestId = this._restoreId = (this._restoreId || 0) + 1;
    const current = () => this._visible === true && owner === sessionKey() && requestId === this._restoreId;
    this.setData({ restoringId: id });
    return Promise.resolve().then(() => adminService.updateWhitelist(id, { status: "active" })).then(() => {
      if (!current()) return;
      wx.showToast({ title: "已恢复会员资格" });
      return this.load();
    }).catch(error => {
      if (current()) wx.showToast({ title: error.message || "恢复失败", icon: "none" });
    }).finally(() => { if (current()) this.setData({ restoringId: "" }); });
  },

  selectItems(event) {
    if (!this.canUseResults()) return;
    const selectedIds = event.detail.value.filter((id) => this.data.items.some((item) => item.id === id && item.status !== "inactive"));
    this.setData({
      selectedIds,
      items: this.data.items.map((item) => Object.assign({}, item, {
        checked: selectedIds.indexOf(item.id) >= 0
      }))
    });
  },

  batchRemove() {
    if (!this.canUseResults()) return;
    if (!this.data.selectedIds.length) {
      wx.showToast({ title: "请先勾选成员", icon: "none" });
      return;
    }
    const ids = this.data.selectedIds.slice();
    const owner = sessionKey(), requestId = this._requestId;
    const current = () => this._visible !== false && owner === sessionKey();
    wx.showModal({
      title: "移出白名单？",
      content: `${ids.length} 个手机号将立即失去会员资格。`,
      confirmText: "移出",
      confirmColor: "#8f434c",
      success: (res) => {
        if (!res.confirm || !current() || requestId !== this._requestId || !this.canUseResults()
          || ids.length !== this.data.selectedIds.length || ids.some((id) => !this.data.selectedIds.includes(id))) return;
        adminService.batchDeleteWhitelist(ids).then(() => {
          if (!current()) return;
          wx.showToast({ title: "已移出" });
          const removed = ids;
          this.setData({
            selectedIds: [],
            items: this.data.items.filter((item) => removed.indexOf(item.id) < 0)
          });
          this.load();
        }).catch((error) => { if (current()) wx.showToast({ title: error.message || "批量移出失败", icon: "none" }); });
      }
    });
  }
});
