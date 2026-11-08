const service = require("../../../services/therapist");
const userService = require("../../../services/user");

function selectedTags(tags, items) {
  const available = new Set(items.map((item) => item.id));
  return [...new Set((tags || []).filter((tag) => available.has(tag)))];
}

function projectChoices(items, tags) {
  const selected = new Set(tags);
  return items.map((item) => Object.assign({}, item, { checked: selected.has(item.id) }));
}

Page({
  ...require("../../../utils/editorLifecycle"),
  data: {
    id: "", name: "", phone: "", originalPhone: "", accountLinked: false, bio: "", tags: [], serviceItems: [], imageUrl: "", imageSrc: "", imageError: "",
    originalTags: [], specialtiesVersion: "", isReviewTherapist: false,
    loading: false, saving: false, uploading: false, allowed: false, error: ""
  },

  onLoad(query) {
    this.startEditor();
    const user = getApp().globalData.user;
    if (!user || user.role !== "admin") { this.setData({ error: "需要管理员权限" }); return; }
    const id = query.id || "";
    this.setData({ allowed: true, id, loading: true });
    wx.setNavigationBarTitle({ title: id ? "编辑芳疗师" : "新增芳疗师" });

    const therapist = id ? service.adminDetail(id).then((data) => data.therapist) : Promise.resolve(null);
    // Read a fresh catalog after the profile snapshot, so its active projects
    // cannot be newer than the catalog used to display the checkboxes.
    const projects = therapist.then(() => userService.serviceItems({ force: true })).then((data) => data.items || []);
    Promise.all([projects, therapist]).then(([items, item]) => {
      if (this.ownsEditor()) this.applyProfile(item || {}, items);
    }).catch((error) => {
      if (this.ownsEditor()) this.setData({ error: error.message || "加载失败", loading: false });
    });
  },

  applyProfile(item, choices) {
    this._original = item;
    const tags = selectedTags(item.serviceItemIds, choices);
    this.setData({
      id: item.id || this.data.id, name: item.name || "", phone: item.phone || "", bio: item.bio || "",
      imageUrl: item.imageUrl || "", imageSrc: item.imageSrc || "", accountLinked: !!item.accountLinked,
      originalPhone: item.phone || "", bindingVersion: item.bindingVersion || "",
      isReviewTherapist: item.isReviewTherapist === true,
      originalTags: tags.slice(), specialtiesVersion: item.specialtiesVersion || "", tags,
      serviceItems: projectChoices(choices, tags), loading: false, imageError: ""
    });
  },
  input(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value }); },

  selectTags(event) {
    const tags = selectedTags(event.detail.value, this.data.serviceItems);
    this.setData({ tags, serviceItems: projectChoices(this.data.serviceItems, tags) });
  },

  chooseImage() {
    if (this.data.uploading || this.data.saving) return;
    wx.chooseMedia({ count: 1, mediaType: ["image"], sizeType: ["compressed"], success: (result) => {
      const file = result.tempFiles[0];
      if (file.size > 5 * 1024 * 1024) { wx.showToast({ title: "图片大小不能超过 5MB", icon: "none" }); return; }
      this.setData({ uploading: true, imageError: "" });
      service.upload(file.tempFilePath).then(({ imageUrl }) => {
        // Show the chosen local file immediately. The saved public page uses imageUrl after reload.
        this.setData({ imageUrl, imageSrc: file.tempFilePath });
      }).catch((error) => wx.showToast({ title: error.message || "图片上传失败", icon: "none" }))
        .finally(() => this.setData({ uploading: false }));
    } });
  },

  imageLoadError() {
    this.setData({ imageError: "预览失败，请重新上传图片" });
  },

  save() {
    if (!this.data.allowed || this.data.loading || this.data.error || this.data.saving || this.data.uploading) return;
    if (!this.data.imageUrl) { wx.showToast({ title: "请上传芳疗师图片", icon: "none" }); return; }
    if (!this.data.name.trim()) { wx.showToast({ title: "请填写芳疗师名称", icon: "none" }); return; }
    if (!this.data.isReviewTherapist && !/^1[3-9]\d{9}$/.test(String(this.data.phone || "").trim())) { wx.showToast({ title: "请输入 11 位有效手机号", icon: "none" }); return; }
    const phone = String(this.data.phone || "").trim();
    const current = this.editorAction();
    if (!current()) return;
    if (this.data.id && phone !== this.data.originalPhone) {
      wx.showModal({
        title: "更换绑定手机号？",
        content: "保存后，芳疗师权限将转移到新手机号对应的登录账号；该账号已有的未来预约会自动取消。",
        confirmText: "确认更换",
        confirmColor: "#8f434c",
        success: (result) => { if (result.confirm && current() && phone === this.data.phone.trim()) this.submitSave(); }
      });
      return;
    }
    this.submitSave();
  },

  submitSave() {
    const current = this.editorAction();
    if (!current() || this.data.saving || this.data.uploading) return;
    const { name, phone, bio, tags, imageUrl } = this.data;
    const payload = { name, phone: phone.trim(), bio, imageUrl };
    if (this.data.id) {
      if (payload.phone !== this.data.originalPhone) payload.bindingVersion = this.data.bindingVersion;
      else delete payload.phone;
      for (const field of ["name", "bio", "imageUrl"]) {
        if (payload[field] === this._original?.[field]) delete payload[field];
      }
    }
    const originalTags = new Set(this.data.originalTags);
    if (!this.data.id || tags.length !== originalTags.size || tags.some((id) => !originalTags.has(id))) {
      payload.serviceItemIds = tags;
      if (this.data.id) payload.specialtiesVersion = this.data.specialtiesVersion;
    }
    if (!Object.keys(payload).length) {
      wx.showToast({ title: "没有需要保存的修改", icon: "none" });
      return;
    }
    this.setData({ saving: true });
    const creating = !this.data.id;
    service.save(this.data.id, payload).then(({ therapist }) => {
      if (!this.ownsEditor()) return;
      // Restored specialties can become active while this editor is open.
      const choices = this.data.serviceItems.slice();
      therapist.serviceItemIds.forEach((id, index) => {
        if (!choices.some(item => item.id === id)) choices.push({ id, name: therapist.tags[index] });
      });
      this.applyProfile(therapist, choices);
      const count = therapist.cancelledAppointments;
      this.editorSaved(count ? `已保存并取消${count}个预约` : "已保存", creating ? "编辑芳疗师" : "");
      if (!current()) return;
      setTimeout(() => { if (current()) wx.navigateBack(); }, count ? 700 : 300);
    })
      .catch((error) => { if (current()) wx.showToast({ title: error.message || "保存失败", icon: "none" }); })
      .finally(() => { if (!this._editorGone) this.setData({ saving: false }); });
  },

  remove() {
    const current = this.editorAction();
    if (!current()) return;
    if (!this.data.id || this.data.saving || this.data.uploading) return;
    wx.showModal({ title: "删除芳疗师？", content: "将移出展示列表，并关闭其未来空闲时间段。如有未结束的预约则无法删除。", confirmText: "删除", confirmColor: "#8f434c", success: (res) => {
      if (!res.confirm || !current()) return;
      this.setData({ saving: true });
      service.remove(this.data.id).then(() => { if (current()) { wx.showToast({ title: "已删除" }); wx.navigateBack(); } })
        .catch((error) => { if (current()) wx.showToast({ title: error.message || "删除失败", icon: "none" }); })
        .finally(() => { if (!this._editorGone) this.setData({ saving: false }); });
    } });
  }
});
