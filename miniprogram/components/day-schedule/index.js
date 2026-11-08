const appointmentDisplay = require("../../utils/appointmentDisplay");
const schedules = require("../../services/schedules");
const appointmentService = require("../../services/appointment");
const userService = require("../../services/user");
const loginReturn = require("../../utils/loginReturn");
const grid = require("../../utils/scheduleGrid");
const imageFallback = require("../../utils/imageFallback");
const booking = require("../../utils/scheduleBooking");

function owner() {
  return loginReturn.sessionKey() + ":" + (getApp()._loginSessionVersion || 0);
}

function roleOf(user) {
  if (user && user.role === "admin") return "admin";
  return user && user.therapistId ? "therapist" : "customer";
}

const statusLabels = { booked: "已预约", checked_in: "已签到", no_show: "未签到", cancelled: "已取消" };

// Anchor the server timestamp on receipt. A slower catalog request must not freeze this clock.
function clockFromServer(serverNowMs) {
  if (!Number.isSafeInteger(serverNowMs) || serverNowMs <= 0) return null;
  const elapsedNow = typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now() : Date.now;
  const received = elapsedNow();
  return () => serverNowMs + Math.max(0, elapsedNow() - received);
}

// Explain rejected clicks using the same availability model that controls selection.
// A blocked cell's starting boundary may still end the free interval before it.
function unavailableReason(day, model, group, point, start, choosingEnd, endOnly, ends, now) {
  if (model.stopped) return "预约已结束或状态已变化，无法修改";
  if (!day.serviceItemIds.length) return "当天暂无可约项目";
  if (choosingEnd) {
    if (model.fixed && point.time === start) return "预约已开始，不可修改开始时间，请选择结束时间";
    if (point.time <= start) return "结束时间需晚于开始时间";
    if (now >= grid.instant(day.date, point.time)) return "结束时间需晚于当前时间";
    if (start < group.startTime || start >= group.endTime) return "不可跨排班预约，请在同一排班内选择";
    const blocked = group.points.find(p => !p.edge && p.time >= start && p.time < point.time && (p.isBusy || p.isClosed));
    if (blocked) return blocked.isBusy ? "所选范围内有已被他人预约的时段" : "所选范围内有已关闭的时段";
    if (grid.minutes(point.time) - grid.minutes(start) < day.minDuration) {
      return `预约时长至少为${day.minDuration}分钟${ends.length ? "，最早可选" + ends[0] + "结束" : ""}`;
    }
    return "该时间不可作为结束时间，请重新选择";
  }
  if (point.passed || (point.edge && now >= grid.instant(day.date, point.time))) return "该时间已过，不能作为开始时间";
  const suffix = endOnly ? "，仅可作为结束时间" : "";
  if (point.isBusy) return "该时间段已被预约" + suffix;
  if (point.isClosed) return "该时间段已关闭" + suffix;
  if (point.edge) return endOnly ? "排班在此结束，仅可作为结束时间" : "排班在此结束，不可作为开始时间";
  return `此后时间不足${day.minDuration}分钟` + suffix;
}

function selectionGuide(day, model, start, end, ends) {
  if (model.stopped) return "预约已结束或状态已变化";
  if (!day.serviceItemIds.length) return "当天暂无可约项目";
  const earliest = ends.length ? ends[0] : "";
  if (model.fixed) return `开始时间${start}（不可修改），请选择结束时间：` + earliest;
  if (start && !end) return `请选择结束时间（最早` + earliest + `）：`;
  if (end) return `已选择${start}–${end}，可提交预约或重新选择开始时间`;
  return `预约时长至少为${day.minDuration}分钟。请选择开始时间：`;
}

Component({
  options: { styleIsolation: "apply-shared" },
  properties: {
    target: { type: Object, value: null }, visible: { type: Boolean, value: false }, revision: Number
  },
  data: Object.assign(imageFallback.initialData(), booking.initialData, {
    loading: true, error: "", day: null, business: null, role: "customer", start: "", end: "", duration: 0,
    groups: [], appointments: [], projects: [], projectIds: [], chosen: [], canCloseChosen: false,
    canOpenChosen: false, canCloseAll: false, canOpenAll: false, bulkClockUnavailable: false, fixed: "", stopped: false, selectionGuide: "", hasEndOnly: false,
    nextReady: false, saving: false, confirmingDay: false, viewVersion: 0, retryIconFailed: false, closeAllIconFailed: false, openAllIconFailed: false
  }),
  observers: { "target, visible, revision"() { if (this._attached) this.activate(); } },
  lifetimes: {
    attached() { this._attached = true; this.activate(); },
    detached() { this._attached = false; this.stop(); }
  },
  methods: Object.assign({}, booking.methods, {
    imageError(event) {
      if (this.data.loading || !this.data.day || !this.active(this._key)) return;
      imageFallback.imageError.call(this, event);
    },
    retryImage() {
      if (this.data.loading || !this.data.day || !this.active(this._key)) return;
      imageFallback.retryImage.call(this);
    },
    retryIconError() { this.setData({ retryIconFailed: true }); },
    closeAllIconError() { this.setData({ closeAllIconFailed: true }); },
    openAllIconError() { this.setData({ openAllIconFailed: true }); },
    stop() {
      clearInterval(this._timer);
      clearTimeout(this._returnTimer);
      this._timer = null;
      this._serverNow = null;
      this._read = (this._read || 0) + 1;
    },
    activate() {
      this.stop();
      if (!this.properties.visible || !this.properties.target) {
        this.setData(Object.assign({ day: null, groups: [], appointments: [], projects: [], loading: true, nextReady: false,
          canCloseChosen: false, canOpenChosen: false, canCloseAll: false, canOpenAll: false, confirmingDay: false }, imageFallback.sourcePatch(this, "", true)));
        return;
      }
      this.load();
      this._timer = setInterval(() => {
        if (this._owner !== owner()) { this.activate(); return; }
        this.updateBookingState();
        const minute = Math.floor(this.scheduleNow() / 60000);
        if (minute !== this._minute && this.data.day) this.renderSelection();
      }, 1000);
    },
    active(key, seq) {
      return this._attached && this.properties.visible && this._key === key && this._owner === owner()
        && (seq === undefined || this._read === seq);
    },
    scheduleNow() {
      return this._serverNow ? this._serverNow() : Date.now();
    },
    retryServerClock(event) {
      if (this.data.bulkClockUnavailable && this.adminEventCurrent(event)) return this.load();
    },
    adminViewCurrent(key, seq) {
      const target = this.properties.target, day = this.data.day;
      return this.active(key, seq) && this.data.role === "admin" && !this.data.loading && !!day && !!target
        && day.date === target.date && day.therapistId === target.therapistId
        && key === JSON.stringify([this._owner, target.therapistId, target.date, target.appointmentId || ""]);
    },
    adminEventCurrent(event) {
      const dataset = event && event.currentTarget && event.currentTarget.dataset;
      const seq = dataset && Number(dataset.viewVersion);
      // A queued native event belongs to the rendered day, not whichever day is now open.
      return Number.isSafeInteger(seq) && seq === this.data.viewVersion && !this.data.saving && !this.data.confirmingDay
        && this.adminViewCurrent(this._key, seq);
    },
    async load() {
      const target = this.properties.target;
      if (!target || !this.properties.visible || !this._attached) return;
      const { therapistId, date, appointmentId } = target;
      const user = getApp().globalData.user, role = roleOf(user), session = owner();
      const key = JSON.stringify([session, therapistId, date, appointmentId || ""]);
      const before = this._owner === session ? this._editing : null;
      this._key = key;
      this._owner = session;
      const form = booking.prepare(this, target, session);
      const seq = this._read = (this._read || 0) + 1;
      this._serverNow = null;
      // Clearing day removes the image node, even when the next date uses the same URL.
      // Invalidate that node before awaiting data so its late callbacks cannot fail the new image.
      this.setData(Object.assign({}, form, { day: null, groups: [], projects: [], appointments: [], chosen: [], canCloseChosen: false,
        canOpenChosen: false, canCloseAll: false, canOpenAll: false, loading: true,
        error: "", nextReady: false, saving: false, confirmingDay: false, viewVersion: seq, role }, imageFallback.sourcePatch(this, "", true)));
      if ((role === "therapist" && user.therapistId !== therapistId) || (appointmentId && role !== "customer")) {
        this.setData({ loading: false, error: "无权查看该排班" });
        return;
      }
      try {
        let serverNow = null;
        const [day, detail, catalog] = await Promise.all([
          schedules.day(therapistId, date, appointmentId).then(result => {
            if (role === "admin") serverNow = clockFromServer(result.serverNowMs);
            return result;
          }),
          appointmentId ? appointmentService.detail(appointmentId) : null,
          role !== "therapist" ? userService.serviceItems() : null
        ]);
        if (!this.active(key, seq)) return;
        this._serverNow = serverNow;
        const editing = detail && detail.appointment;
        if (appointmentId && (!editing || editing.id !== appointmentId || !user || editing.userId !== user.id
          || editing.therapistId !== therapistId || editing.date !== date)) throw new Error("预约已变化，请返回列表重新打开");
        this._editing = editing;
        const projectIds = day.serviceItemIds || [];
        const projects = role === "admin" && catalog ? catalog.items.map((item) => ({
          id: item.id, name: item.name, checked: projectIds.includes(item.id),
          wide: Array.from(String(item.name || "").trim()).length > 6
        })) : [];
        const appointments = (day.appointments || []).map((item) => {
          const note = String(item.note || ""), characters = Array.from(note);
          return Object.assign({}, item, {
            label: statusLabels[item.status] || item.status,
            projectSummary: appointmentDisplay.truncate(item.serviceItemName, 16),
            notePreview: characters.length > 18 ? characters.slice(0, 18).join("") + "..." : note
          });
        });
        this.setData(Object.assign(role === "customer" ? booking.hydrate(this, day, catalog, editing, before) : {},
          { day, projects, projectIds, appointments, loading: false, bulkClockUnavailable: role === "admin" && !serverNow },
          imageFallback.sourcePatch(this, day.therapistImageSrc || "")));
        this.renderSelection();
        if (role === "customer") userService.business().then(business => {
          if (this.active(key, seq)) this.setData({ business });
        }).catch(() => {});
        this.triggerEvent("window", { today: day.today, daysVisible: day.daysVisible });
      } catch (error) {
        if (!this.active(key, seq)) return;
        this.setData({ loading: false, error: error.message || "排班加载失败" });
        this.updateBookingState();
        if (!appointmentId && error.code === "DATE_OUT_OF_RANGE") this.triggerEvent("outofwindow");
      }
    },
    renderSelection() {
      if (!this.data.day) return;
      const now = this.scheduleNow(), customer = this.data.role === "customer";
      this._minute = Math.floor(now / 60000);
      const model = grid.availability(this.data.day, this._editing, now);
      if (customer && !this.data.day.serviceItemIds.length) model.starts.clear();
      this._model = model;
      let { start, end } = this.data;
      if (model.fixed) start = model.fixed;
      else if (!model.starts.has(start)) start = "";
      const ends = model.starts.get(start) || [];
      if (!ends.includes(end)) end = "";
      const choosingEnd = !!model.fixed || !!(start && !end);
      const possibleEnds = new Set();
      if (customer && !choosingEnd) model.starts.forEach(values => values.forEach(time => possibleEnds.add(time)));
      const chosen = this.data.chosen.filter((time) => model.groups.some((g) => g.points.some((p) => p.time === time && p.manageable)));
      const chosenSet = new Set(chosen);
      const admin = this.data.role === "admin", therapist = this.data.role === "therapist";
      const staff = admin || therapist;
      const staffAppointments = staff ? (this.data.day.appointments || []).filter(item =>
        ["booked", "checked_in", "no_show"].includes(item.status)) : [];
      let canCloseChosen = false, canOpenChosen = false;
      const groups = model.groups.map((group) => ({
        id: group.id, startTime: group.startTime, endTime: group.endTime,
        points: group.points.map((p) => {
          const canStart = model.starts.has(p.time) && !model.fixed;
          const canEnd = ends.includes(p.time);
          const disabled = admin ? !p.manageable : therapist || !!model.stopped || !(choosingEnd ? canEnd : canStart);
          const endOnly = customer && !choosingEnd && !canStart && possibleEnds.has(p.time);
          // When choosing a start, outline unused points even if the minimum duration prevents selection.
          // This is presentation only: disabled selection and its existing explanation stay intact.
          const limited = customer && !choosingEnd && disabled && !model.stopped && !!this.data.day.serviceItemIds.length
            && !canStart && !possibleEnds.has(p.time) && !p.passed && !p.isBusy && !p.isClosed
            && (!p.edge || now < grid.instant(this.data.day.date, p.time));
          const reason = customer && disabled
            ? unavailableReason(this.data.day, model, group, p, start, choosingEnd, endOnly, ends, now) : "";
          let state = "", hint = "", staffCaption = "";
          if (staff) {
            // Staff cells display occupancy independently of whether customers can start here.
            state = p.edge ? (admin ? "inactive" : "") : p.passed ? "inactive" : p.isClosed ? (admin ? "closed" : "inactive") : p.isBusy ? "booked" : "";
            // Completed no-shows are absent from busy ranges but remain in staff appointment history.
            const appointment = p.passed && staffAppointments.find(item => p.time >= item.startTime && p.time < item.endTime);
            staffCaption = p.edge && admin ? "边界" : appointment ? (appointment.status === "checked_in" ? "已签到" : "未签到")
              : p.isBusy ? "已预约" : admin && p.isClosed && !p.passed ? "已关闭" : "";
            hint = p.edge ? "排班结束" : p.passed ? (staffCaption ? staffCaption + "，已结束" : "已结束")
              : p.isClosed ? "已关闭" : p.isBusy ? "已预约" : "空闲";
            if (admin && chosenSet.has(p.time) && p.manageable) {
              state = "selected";
              if (p.isClosed) canOpenChosen = true;
              else canCloseChosen = true;
            }
          } else if (p.time === start || p.time === end) {
            state = "selected"; hint = p.time === start ? "开始" : "结束";
          } else if (end && p.time > start && p.time < end) {
            state = "within";
          } else if (customer && choosingEnd && canEnd) {
            hint = "可结束"; state = "possible";
          } else if (endOnly) {
            state = "end-only";
          } else if (limited) {
            state = "limited";
          } else if (p.isBusy) hint = "已占用";
          else if (p.isClosed) hint = "已关闭";
          const caption = staff ? staffCaption : customer && state !== "selected" ? "" : hint;
          if (customer && state !== "selected") hint = endOnly ? "仅可结束，" + reason : reason || (choosingEnd ? "可结束" : "可开始");
          return Object.assign({}, p, { state, hint, caption, disabled, reason });
        })
      }));
      const canCloseAll = admin && !!this._serverNow && model.groups.some(group => group.points.some(point => point.manageable && !point.isClosed));
      const canOpenAll = admin && !!this._serverNow && model.groups.some(group => group.points.some(point => point.manageable && point.isClosed));
      this.setData({ groups, chosen, canCloseChosen, canOpenChosen, canCloseAll, canOpenAll, start, end, fixed: model.fixed, stopped: !!model.stopped,
        selectionGuide: customer ? selectionGuide(this.data.day, model, start, end, ends) : "",
        hasEndOnly: groups.some(group => group.points.some(point => point.state === "end-only")),
        nextReady: !!end && !model.stopped && !!(this.data.day.serviceItemIds || []).length,
        duration: start && end ? grid.minutes(end) - grid.minutes(start) : 0 });
      if (customer) {
        Object.assign(this._formInputs, { start, end });
        this.updateBookingState();
      }
    },
    tapPoint(event) {
      if (!this.active(this._key) || this.data.loading || this.data.saving || !this.data.day) return;
      if (Number(event.currentTarget.dataset.viewVersion) !== this.data.viewVersion) return;
      if (this.data.role === "admin" && !this.adminEventCurrent(event)) return;
      if (this.data.role === "customer" && this.bookingLocked()) return;
      this.renderSelection();
      const time = event.currentTarget.dataset.time;
      if (this.data.role === "admin") {
        const canManage = this._model.groups.some((g) => g.points.some((p) => p.time === time && p.manageable));
        if (!canManage) return;
        const chosen = this.data.chosen.includes(time) ? this.data.chosen.filter((v) => v !== time) : this.data.chosen.concat(time);
        this.setData({ chosen }); this.renderSelection(); return;
      }
      if (this.data.role !== "customer") return;
      const group = this.data.groups.find(item => item.points.some(point => point.time === time));
      const point = group && group.points.find(item => item.time === time);
      if (!point) return;
      if (point.disabled) {
        wx.showToast({ title: point.reason, icon: "none", duration: 3000 });
        return;
      }
      const ends = this._model.starts.get(this.data.start) || [];
      if ((!this.data.start || this.data.end) && !this._model.fixed) {
        if (!this._model.starts.has(time)) return;
        this.setData({ start: time, end: "" });
      } else if (ends.includes(time)) this.setData({ end: time });
      else return;
      this.renderSelection();
    },
    resetSelection(event) {
      if (!this.acceptsBookingInput(event) || !this.data.day) return;
      this.setData({ start: this._model.fixed || "", end: "" });
      this.renderSelection();
    },
    selectProjects(event) {
      if (!this.adminEventCurrent(event)) return;
      const projectIds = event.detail.value;
      this.setData({ projectIds, projects: this.data.projects.map(item => ({ ...item, checked: projectIds.includes(item.id) })) });
    },
    allProjects(event) {
      if (!this.adminEventCurrent(event) || !this.data.projects.length) return;
      this.selectProjects({ currentTarget: event.currentTarget, detail: { value: this.data.projects.map(item => item.id) } });
    },
    async applyDay(event) {
      if (!this.adminEventCurrent(event)) return;
      const key = this._key, seq = this._read, day = this.data.day, type = event.currentTarget.dataset.action;
      this.renderSelection();
      const payload = { date: day.date };
      if (type === "projects") {
        payload.serviceItemIds = this.data.projectIds.slice();
      } else if (type === "closeAll" || type === "openAll") {
        const opening = type === "openAll";
        if (!(opening ? this.data.canOpenAll : this.data.canCloseAll)) return;
        // Bind confirmation to the grid that was displayed, including its interval lengths.
        payload.expectedGrid = { step: day.step, ranges: day.ranges.map(({ startTime, endTime }) => ({ startTime, endTime })) };
        const message = opening ? "将开启所有尚未结束的已关闭时段。" : "将关闭所有未预约且未结束的空闲时段，不影响已有预约。";
        this.setData({ confirmingDay: true });
        try {
          const confirmed = await new Promise((resolve, reject) => wx.showModal({
            title: opening ? "开启当天已关闭的时段？" : "关闭当天空闲时段？",
            content: `${day.therapistName} · ${day.date}\n${message}`,
            confirmText: opening ? "确认开启" : "确认关闭",
            confirmColor: opening ? "#356243" : "#793e44",
            success: result => resolve(!!result.confirm), fail: reject
          }));
          if (!confirmed || !this.adminViewCurrent(key, seq)) return;
        } catch (_) {
          if (this.adminViewCurrent(key, seq)) wx.showToast({ title: "无法打开确认，请重试", icon: "none" });
          return;
        } finally {
          if (this.adminViewCurrent(key, seq)) this.setData({ confirmingDay: false });
        }
        // The clock may have advanced while the native confirmation dialog was open.
        this.renderSelection();
        // Use fresh interval eligibility, not selection colors or customer minimum-duration rules.
        const cells = this._model.groups.flatMap(group => group.points
          .filter(point => point.manageable && point.isClosed === opening).map(point => point.time));
        if (!cells.length) {
          wx.showToast({ title: opening ? "暂无可开启时段" : "暂无可关闭时段", icon: "none" });
          return;
        }
        payload[opening ? "open" : "close"] = cells;
      } else {
        if (!["close", "open"].includes(type)) return;
        if ((type === "close" && !this.data.canCloseChosen) || (type === "open" && !this.data.canOpenChosen)) return;
        const closed = new Set(day.closed || []);
        const cells = this.data.chosen.filter((t) => type === "open" ? closed.has(t) : !closed.has(t));
        if (!cells.length) { wx.showToast({ title: type === "open" ? "请选择已关闭的格子" : "请选择开放的空闲格", icon: "none" }); return; }
        payload.expectedStep = day.step;
        payload[type] = cells;
      }
      const operation = this._daySave = (this._daySave || 0) + 1;
      // Returning to the same date still creates a new view. An old write may finish
      // on the server, but cannot reload new drafts or release a newer write's busy state.
      const current = () => this._daySave === operation && this.adminViewCurrent(key, seq);
      this.setData({ saving: true });
      try {
        await schedules.changeDay(day.therapistId, payload);
        if (!current()) return;
        wx.showToast({ title: "已保存", icon: "success" });
        await this.load();
      } catch (error) {
        if (!current()) return;
        wx.showToast({ title: error.message || "未能保存，请重试", icon: "none" });
        if (error.statusCode === 409) await this.load();
      } finally { if (current()) this.setData({ saving: false }); }
    },
    openAppointment(event) {
      const id = event.currentTarget.dataset.id;
      if (!["admin", "therapist"].includes(this.data.role) || !this.active(this._key)
        || !this.data.appointments.some((a) => a.id === id)) return;
      const page = this.data.role === "admin" ? "admin/slot-appointment" : "therapist/appointment-detail";
      wx.navigateTo({
        url: "/pages/" + page + "/index?appointmentId=" + encodeURIComponent(id),
        fail: () => { if (this.active(this._key)) wx.showToast({ title: "无法打开预约详情，请重试", icon: "none" }); }
      });
    }
  })
});
