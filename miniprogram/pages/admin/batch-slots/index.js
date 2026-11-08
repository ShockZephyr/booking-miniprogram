const admin = require("../../../services/admin");
const catalog = require("../../../services/user");
const people = require("../../../services/therapist");
const session = require("../../../utils/loginReturn");
const batchMemory = require("../../../utils/batchScheduleMemory");
const imageFallback = require("../../../utils/imageFallback");

const steps = [10, 15, 30];
const fieldNotes = {
  "时间精度": "相邻预约时间点的间隔。例如09:00–12:00按30分钟划分，时间点依次为09:00、09:30……12:00。12:00只能作为结束时间，开始时间还需满足最短预约时长。",
  "最短预约时长": "必须是时间精度的正整数倍；每笔客户预约的时长将须至少满足该值。"
};
const weekdays = "一二三四五六日".split("").map((label, i) => ({ value: i + 1, label: "周" + label }));
const defaultRanges = () => [
  { startTime: "09:00", endTime: "12:00" },
  { startTime: "14:00", endTime: "17:00" },
  { startTime: "19:00", endTime: "21:00" }
];
let rangeKey = 0;
let formVersion = 0;
function format(mins) {
  return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
}
function times(step) { return Array.from({ length: 1440 / step }, (_, i) => format(i * step)); }
function minutes(time) { return Number(time.slice(0, 2)) * 60 + Number(time.slice(3)); }
function validMinimum(value, step) { return Number.isInteger(value) && value > 0 && value <= 2147483647 && value % step === 0; }
function checked(options, ids) { return options.map(item => ({ ...item, checked: ids.includes(item.id) })); }
function displayRanges(ranges, choices) {
  return ranges.map((r, i) => ({ ...r, key: r.key || "range-" + (++rangeKey),
    startIndex: Math.max(0, choices.indexOf(r.startTime)), endIndex: Math.max(0, choices.indexOf(r.endTime)),
    canAddAfter: r.endTime < (ranges[i + 1] ? ranges[i + 1].startTime : choices[choices.length - 1]) }));
}
function draftOf(data) {
  return { step: data.step, minDuration: String(data.minDuration),
    ranges: data.ranges.map(range => ({ ...range })), projectIds: data.projectIds.slice() };
}
function draftSignature(draft) {
  let valid = true;
  try { validateDraft(draft); } catch (_) { valid = false; }
  const ranges = [];
  for (const row of draft.ranges.slice().sort((a, b) => a.startTime.localeCompare(b.startTime))) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous.endTime === row.startTime) previous.endTime = row.endTime;
    else ranges.push({ startTime: row.startTime, endTime: row.endTime });
  }
  return JSON.stringify({ valid, step: draft.step, minDuration: Number(draft.minDuration), ranges, projectIds: draft.projectIds.slice().sort() });
}
function validateDraft(draft) {
  const minDuration = Number(draft.minDuration), choices = times(draft.step);
  if (!validMinimum(minDuration, draft.step)) throw new Error("最短时长须为精度的正整数倍");
  const ranges = draft.ranges.map(({ startTime, endTime }) => ({ startTime, endTime })).sort((a, b) => a.startTime.localeCompare(b.startTime));
  if (ranges.some((r, i) => !choices.includes(r.startTime) || !choices.includes(r.endTime) || r.startTime >= r.endTime || (i && r.startTime < ranges[i - 1].endTime))) {
    throw new Error("请检查起止时间、精度和排班重叠");
  }
  const continuous = [];
  for (const range of ranges) {
    const previous = continuous[continuous.length - 1];
    if (previous && previous.endTime === range.startTime) previous.endTime = range.endTime;
    else continuous.push({ ...range });
  }
  if (continuous.some(range => minutes(range.endTime) - minutes(range.startTime) < minDuration)) {
    throw new Error(`每段连续排班至少需要 ${minDuration} 分钟`);
  }
  return { step: draft.step, minDuration, ranges };
}
function errorText(msg) { wx.showToast({ title: msg, icon: "none" }); }
function rangeIndex(ranges, event, fallback = -1) {
  const dataset = event.currentTarget && event.currentTarget.dataset || {};
  if (dataset.key !== undefined) {
    const index = ranges.findIndex(range => range.key === dataset.key);
    // A removed row is invalid, not the empty-form add action's -1 fallback.
    return index < 0 ? NaN : index;
  }
  return dataset.index === undefined ? fallback : Number(dataset.index);
}
Page({
  data: {
    ...imageFallback.initialData(), person: null, personName: "", retryIconFailed: false,
    singleId: "", therapistIds: [], therapists: [], projects: [], projectIds: [], weekdays, selectedDays: [],
    stepOptions: steps, step: 30, minDuration: "90", times: times(30), ranges: displayRanges(defaultRanges(), times(30)),
    loading: true, error: "", saving: false, formVersion: 0, dirtyDays: [], weekNotice: ""
  },
  onLoad(query = {}) {
    this.setData({ singleId: query.therapistId || "", selectedDays: query.therapistId ? [1] : [] });
    wx.setNavigationBarTitle({ title: query.therapistId ? "每周排班" : "批量管理" });
  },
  onShow() {
    if (this._gone) return;
    if (!this._visible) this.setData({ formVersion: ++formVersion });
    this._visible = true;
    if (this._owner !== session.sessionKey() || !this._loaded) return this.initialize();
    this.syncLeaveAlert(true);
  },
  onHide() {
    this.clearLeaveAlert();
    this._visible = false;
    this.setData({ formVersion: ++formVersion });
  },
  onUnload() {
    this.clearLeaveAlert();
    this._request = (this._request || 0) + 1; this._gone = true; this._visible = false;
    this._weekDrafts = {}; this._weekOriginals = {};
  },
  clearLeaveAlert(force = false) {
    this.setLeaveAlert(false, force);
  },
  setLeaveAlert(wanted, force = false) {
    this._leaveAlertWanted = wanted;
    if (!this._visible || this._gone) return;
    const api = wanted ? "enableAlertBeforeUnload" : "disableAlertBeforeUnload";
    if (typeof wx[api] !== "function" || (!force && wanted === this._leaveAlert)) return;
    const owner = this._owner;
    const operation = this._leaveAlertOperation = {};
    this._leaveAlert = wanted;
    const current = () => !this._gone && this._visible && this._owner === owner
      && owner === session.sessionKey();
    const options = {
      ...(wanted ? { message: "您有未保存的修改，离开将放弃修改。" } : {}),
      success: () => {
        // A late native enable/disable may finish after the opposite request.
        // Reapply this page's latest intent without changing any form data.
        if (current() && wanted !== this._leaveAlertWanted) this.setLeaveAlert(this._leaveAlertWanted, true);
      },
      fail: () => {
        // Do not cache a failed native call as applied; retry on the next sync.
        if (current() && this._leaveAlertOperation === operation) this._leaveAlert = undefined;
      }
    };
    try { wx[api](options); } catch (_) { options.fail(); }
  },
  syncLeaveAlert(force = false) {
    if (!this._visible || this._gone || this._owner !== session.sessionKey()) return;
    this.setLeaveAlert(!!this.data.singleId && this.data.dirtyDays.length > 0, force);
  },
  syncDirtyDays(forceLeaveAlert = false) {
    if (!this.data.singleId) return;
    const dirtyDays = Object.keys(this._weekDrafts || {}).map(Number).filter(day =>
      draftSignature(this._weekDrafts[day]) !== this._weekOriginals[day]).sort((a, b) => a - b);
    this.setData({ dirtyDays, weekdays: weekdays.map(day => ({ ...day, dirty: dirtyDays.includes(day.value) })) });
    this.syncLeaveAlert(forceLeaveAlert);
  },
  rememberWeekday() {
    const day = this.data.selectedDays[0];
    if (!this.data.singleId || this.data.loading || this.data.error || !this._weekDrafts || !this._weekDrafts[day]) return;
    const draft = draftOf(this.data);
    if (JSON.stringify(draft) !== JSON.stringify(this._weekDrafts[day])) this.setData({ weekNotice: "" });
    this._weekDrafts[day] = draft;
    this.syncDirtyDays();
  },
  showWeekday(draft) {
    const choices = times(draft.step);
    this.setData({ ...draftOf(draft), times: choices, ranges: displayRanges(draft.ranges, choices),
      projects: checked(this.data.projects, draft.projectIds) });
  },
  acceptsFormEvent(event, navigation = false) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset;
    const version = dataset && Number(dataset.formVersion);
    return Number.isSafeInteger(version) && version > 0 && version === this.data.formVersion
      && this._visible && !this._gone && this._owner === session.sessionKey() && !this.data.saving
      && (navigation || (!this.data.loading && !this.data.error));
  },
  showFieldNote(event) {
    if (!this.acceptsFormEvent(event)) return;
    const title = event.currentTarget.dataset.note;
    const content = fieldNotes[title];
    if (typeof content === "string") wx.showModal({ title, content, showCancel: false, confirmText: "知道了", confirmColor: "#67528A" });
  },
  imageError(event) {
    if (this._gone || this._owner !== session.sessionKey()) return;
    imageFallback.imageError.call(this, event);
  },
  retryImage() {
    if (this._gone || this._owner !== session.sessionKey()) return;
    imageFallback.retryImage.call(this);
  },
  retryIconError() {
    if (this._gone || this._owner !== session.sessionKey()) return;
    this.setData({ retryIconFailed: true });
  },
  async initialize() {
    this.clearLeaveAlert(true);
    this._weekDrafts = {}; this._weekOriginals = {};
    const owner = this._owner = session.sessionKey();
    const read = this._request = (this._request || 0) + 1;
    const current = () => !this._gone && this._request === read && session.sessionKey() === owner;
    this._loaded = false;
    this.setData({ loading: true, error: "", saving: false, formVersion: ++formVersion, ranges: [], projects: [], projectIds: [], therapists: [], therapistIds: [],
      person: null, personName: "", retryIconFailed: false, ...imageFallback.sourcePatch(this, "", true),
      selectedDays: this.data.singleId ? [1] : [],
      step: 30, minDuration: "90", times: times(30), weekdays, dirtyDays: [], weekNotice: "" });
    try {
      const url = "/pages/admin/batch-slots/index" + (this.data.singleId ? "?therapistId=" + this.data.singleId : "");
      if (!await session.ensure(url, "admin")) throw new Error("请使用管理员账号");
      if (!current()) return;
      const [a, b] = await Promise.all([people.list(), catalog.serviceItems()]);
      if (!current()) return;
      const id = this.data.singleId;
      const person = id ? a.therapists.find(p => p.id === id) : null;
      if (id && !person) throw new Error("芳疗师已停用或不存在");
      const restored = id ? null : batchMemory.read(batchMemory.storageKey(), a.therapists, b.items);
      const therapistIds = id ? [id] : restored ? restored.therapistIds : [];
      const projectIds = restored ? restored.projectIds : [];
      const selectedDays = id ? [1] : restored ? restored.selectedDays : [];
      const step = restored && restored.step || 30, choices = times(step);
      this.setData({ ...(restored || {}), step, times: choices, ranges: displayRanges(restored ? restored.ranges : id ? [] : defaultRanges(), choices),
        therapists: checked(a.therapists, therapistIds), therapistIds,
        projects: checked(b.items.map(item => ({ ...item, wide: Array.from(String(item.name || "").trim()).length > 6 })), projectIds), projectIds, selectedDays,
        weekdays: weekdays.map(d => ({ ...d, checked: selectedDays.includes(d.value) })),
        person, personName: person ? person.name : "", ...imageFallback.sourcePatch(this, person && person.imageSrc) });
      this._loaded = true;
      if (id) return this.loadWeekday(this.data.selectedDays[0]);
    } catch (error) { if (current()) this.setData({ error: error.message || "加载失败" }); }
    finally { if (current()) this.setData({ loading: false }); }
  },
  async loadWeekday(day) {
    this.rememberWeekday();
    const read = this._request = (this._request || 0) + 1, owner = this._owner;
    const current = () => !this._gone && this._request === read && owner === session.sessionKey();
    this.setData({ selectedDays: [day], loading: true, error: "", formVersion: ++formVersion });
    try {
      if (this._weekDrafts[day]) { this.showWeekday(this._weekDrafts[day]); return; }
      const rule = await admin.weekly(this.data.singleId, day);
      if (!current()) return;
      const choices = times(rule.step);
      const draft = { step: rule.step, ranges: displayRanges(rule.ranges, choices), minDuration: String(rule.minDuration), projectIds: rule.serviceItemIds };
      this._weekDrafts[day] = draftOf(draft);
      this._weekOriginals[day] = draftSignature(draft);
      this.showWeekday(draft);
    } catch (error) { if (current()) this.setData({ error: error.message || "排班加载失败" }); }
    finally { if (current()) this.setData({ loading: false }); }
  },
  retry(event) {
    if (!this.acceptsFormEvent(event, true)) return;
    if (this.data.singleId && this._loaded && this._owner === session.sessionKey()) return this.loadWeekday(this.data.selectedDays[0]);
    return this.initialize();
  },
  pickWeekday(event) {
    if (!this.acceptsFormEvent(event, true) || !this.data.singleId) return;
    const day = Number(event.currentTarget.dataset.day);
    if (Number.isInteger(day) && day >= 1 && day <= 7) return this.loadWeekday(day);
  },
  pickDays(event) {
    if (!this.acceptsFormEvent(event)) return;
    const selectedDays = event.detail.value.map(Number);
    this.setData({ selectedDays, weekdays: weekdays.map(d => ({ ...d, checked: selectedDays.includes(d.value) })) });
  },
  allDays(event) {
    if (!this.acceptsFormEvent(event) || this.data.singleId) return;
    this.pickDays({ currentTarget: event.currentTarget, detail: { value: weekdays.map(d => String(d.value)) } });
  },
  selectPeople(event) {
    if (!this.acceptsFormEvent(event)) return;
    const ids = event.detail.value;
    this.setData({ therapistIds: ids, therapists: checked(this.data.therapists, ids) });
  },
  allPeople(event) {
    if (!this.acceptsFormEvent(event)) return;
    this.selectPeople({ currentTarget: event.currentTarget, detail: { value: this.data.therapists.map(t => t.id) } });
  },
  selectProjects(event) {
    if (!this.acceptsFormEvent(event)) return;
    const ids = event.detail.value;
    this.setData({ projectIds: ids, projects: checked(this.data.projects, ids) });
    this.rememberWeekday();
  },
  allProjects(event) {
    if (!this.acceptsFormEvent(event)) return;
    this.selectProjects({ currentTarget: event.currentTarget, detail: { value: this.data.projects.map(item => item.id) } });
  },
  setStep(event) {
    if (!this.acceptsFormEvent(event)) return;
    const step = Number(event.detail.value);
    if (!steps.includes(step)) return;
    const choices = times(step);
    // Picker values are indices into times; old-precision events cannot reuse them.
    this.setData({ step, times: choices, ranges: displayRanges(this.data.ranges, choices), formVersion: ++formVersion });
    this.rememberWeekday();
  },
  setMinimum(event) {
    if (!this.acceptsFormEvent(event)) return;
    this.setData({ minDuration: event.detail.value });
    this.rememberWeekday();
  },
  addRange(event = {}) {
    if (!this.acceptsFormEvent(event)) return;
    const dataset = event.currentTarget && event.currentTarget.dataset || {};
    const prepend = dataset.placement === "before" && dataset.key === undefined && dataset.index === undefined;
    const index = prepend ? -1 : rangeIndex(this.data.ranges, event, this.data.ranges.length - 1);
    if (!Number.isInteger(index) || index < (prepend || !this.data.ranges.length ? -1 : 0) || index >= this.data.ranges.length) return;
    // Validate the current draft, including merged minimum duration, before deriving new times.
    // Deleted-row and old-form events must have returned before this validation.
    try { validateDraft(this.data); }
    catch (error) { errorText(error.message); return; }
    const choices = this.data.times;
    const minimum = Number(this.data.minDuration), last = minutes(choices[choices.length - 1]);
    const ordered = this.data.ranges.slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
    let start, end, adjusted = false;
    if (!ordered.length) {
      start = 9 * 60; end = start + Math.max(180, minimum);
      if (end > last) { errorText(`09:00后不足 ${minimum} 分钟，请调整最短时长`); return; }
    } else if (prepend) {
      const first = ordered[0], next = ordered[1], firstStart = minutes(first.startTime);
      const gap = next ? minutes(next.startTime) - minutes(first.endTime) : 120;
      end = firstStart - gap; start = end - (minutes(first.endTime) - firstStart);
      if (start < 0) { end = firstStart; start = Math.max(0, end - minimum); adjusted = true; }
    } else {
      // Locate the clicked row by identity after sorting, never by its former screen position.
      const source = this.data.ranges[index], position = ordered.indexOf(source), next = ordered[position + 1];
      start = minutes(source.endTime);
      if (next) {
        end = Math.min(start + minimum, minutes(next.startTime));
        adjusted = end - start < minimum;
      } else {
        const previous = ordered[position - 1];
        const gap = previous ? minutes(source.startTime) - minutes(previous.endTime) : 120;
        start += gap; end = start + minutes(source.endTime) - minutes(source.startTime);
        if (end > last) { start = minutes(source.endTime); end = Math.min(last, start + minimum); adjusted = true; }
      }
    }
    if (end <= start) { errorText("此处已无可添加时间"); return; }
    const ranges = this.data.ranges.concat({ startTime: format(start), endTime: format(end) })
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    this.setData({ ranges: displayRanges(ranges, choices) });
    this.rememberWeekday();
    if (adjusted) errorText(`已新增 ${format(start)}–${format(end)}`);
  },
  removeRange(event) {
    if (!this.acceptsFormEvent(event)) return;
    const index = rangeIndex(this.data.ranges, event);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.ranges.length) return;
    this.setData({ ranges: displayRanges(this.data.ranges.filter((_, i) => i !== index), this.data.times) });
    this.rememberWeekday();
  },
  setTime(event) {
    if (!this.acceptsFormEvent(event)) return;
    const index = rangeIndex(this.data.ranges, event), { field } = event.currentTarget.dataset;
    const timeIndex = Number(event.detail.value), time = this.data.times[timeIndex];
    if (!Number.isInteger(index) || index < 0 || index >= this.data.ranges.length
      || !["startTime", "endTime"].includes(field) || !Number.isInteger(timeIndex) || !time) return;
    const minimum = Number(this.data.minDuration);
    if (!validMinimum(minimum, this.data.step)) { errorText("最短时长须为精度的正整数倍"); return; }
    const previous = this.data.ranges[index], updated = { ...previous, [field]: time };
    let adjusted = false;
    if (minutes(updated.endTime) - minutes(updated.startTime) < minimum) {
      if (field === "startTime") updated.endTime = format(Math.min(minutes(time) + minimum, minutes(this.data.times[this.data.times.length - 1])));
      else updated.startTime = format(Math.max(0, minutes(time) - minimum));
      if (minutes(updated.endTime) - minutes(updated.startTime) < minimum) {
        errorText(`修改失败：当天边界内不足 ${minimum} 分钟`); return;
      }
      adjusted = true;
    }
    const overlaps = this.data.ranges.some((r, i) => i !== index && updated.startTime < r.endTime && r.startTime < updated.endTime);
    const ranges = this.data.ranges.map((r, i) => i === index ? updated : r)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    this.setData({ ranges: displayRanges(ranges, this.data.times) });
    this.rememberWeekday();
    if (overlaps) errorText("新增排班与现有排班重叠，请调整后保存");
    else if (adjusted) errorText(`已自动调整${field === "startTime" ? "结束时间" : "开始时间"}，以满足最短时长 ${minimum} 分钟`);
  },
  async save(event) {
    if (!this.acceptsFormEvent(event)) return;
    if (this.data.singleId) return this.saveWeekdays();
    const d = this.data;
    if (!d.therapistIds.length || !d.selectedDays.length) { errorText("请选择芳疗师和星期"); return; }
    const body = { therapistIds: d.therapistIds.slice(), weekdays: d.selectedDays.slice() };
    const minDuration = Number(d.minDuration);
    if (!Number.isInteger(minDuration) || minDuration < d.step || minDuration > 2147483647 || minDuration % d.step) { errorText("最短时长须为精度的正整数倍"); return; }
    const ranges = d.ranges.map(({startTime,endTime}) => ({startTime,endTime})).sort((a,b) => a.startTime.localeCompare(b.startTime));
    if (ranges.some((r,i) => !d.times.includes(r.startTime) || !d.times.includes(r.endTime) || r.startTime >= r.endTime || (i && r.startTime < ranges[i-1].endTime))) {
      errorText("请检查起止时间、精度和排班重叠"); return;
    }
    const continuous = [];
    for (const range of ranges) {
      const previous = continuous[continuous.length - 1];
      if (previous && previous.endTime === range.startTime) previous.endTime = range.endTime;
      else continuous.push({ ...range });
    }
    if (continuous.some(range => (d.times.indexOf(range.endTime) - d.times.indexOf(range.startTime)) * d.step < minDuration)) {
      errorText(`每段连续排班至少需要 ${minDuration} 分钟`); return;
    }
    body.schedule = { step: d.step, minDuration, ranges };
    body.serviceItemIds = d.projectIds.slice();
    const memoryKey = d.singleId ? "" : batchMemory.storageKey();
    const read = this._request, owner = this._owner;
    const current = () => !this._gone && read === this._request && owner === session.sessionKey();
    const confirmationVersion = ++formVersion;
    this.setData({ saving: true, formVersion: confirmationVersion });
    try {
      const changes = [body.schedule && (body.schedule.ranges.length ? "覆盖原排班" : "设为全天休息"),
        body.serviceItemIds && (body.serviceItemIds.length ? "覆盖可约项目" : "清空可约项目")].filter(Boolean).join("、");
      const accept = await new Promise((resolve,reject) => wx.showModal({ title: "保存每周排班",
        content: d.therapistIds.length + " 位芳疗师 × " + d.selectedDays.length + " 个星期，共 " + d.therapistIds.length*d.selectedDays.length + " 组，将" + changes + "。已存在预约的日期沿用原有排班。",
        confirmText: "保存", success: res => resolve(res.confirm), fail: reject }));
      if (!current() || !this._visible || this.data.formVersion !== confirmationVersion || !accept) return;
      const pendingSave = batchMemory.beginSave(memoryKey);
      await admin.saveWeekly(body);
      // Preferences outlive this page; session and save ordering still protect them.
      const remembered = !memoryKey || (owner === session.sessionKey()
        && memoryKey === batchMemory.storageKey() && batchMemory.write(pendingSave, body));
      if (!current()) return;
      this.syncLeaveAlert(true);
      if (this._visible) wx.showToast(remembered ? { title: "周排班已保存" } : { title: "排班已保存，预填未记住", icon: "none" });
      if (d.singleId) { this.setData({ saving: false }); await this.loadWeekday(d.selectedDays[0]); }
    } catch (error) { if (current() && this._visible) errorText(error.message || "保存失败，请重试"); }
    finally { if (current()) this.setData({ saving: false, formVersion: ++formVersion }); }
  },
  async saveWeekdays() {
    this.rememberWeekday();
    const days = [];
    for (const weekday of this.data.dirtyDays) {
      const draft = this._weekDrafts[weekday];
      try { days.push({ weekday, schedule: validateDraft(draft), serviceItemIds: draft.projectIds.slice() }); }
      catch (error) {
        const message = "周" + "一二三四五六日"[weekday - 1] + "：" + error.message;
        this.setData({ weekNotice: message }); errorText(message); return;
      }
    }
    if (!days.length) return;
    const id = this.data.singleId, read = this._request, owner = this._owner;
    const current = () => !this._gone && read === this._request && owner === session.sessionKey();
    const confirmationVersion = ++formVersion;
    this.setData({ saving: true, weekNotice: "", formVersion: confirmationVersion });
    try {
      const names = days.map(day => "周" + "一二三四五六日"[day.weekday - 1]).join("、");
      const accept = await new Promise((resolve, reject) => wx.showModal({ title: "保存每周排班",
        content: `将修改${names}的排班和可约项目，整批保存。已存在预约的日期沿用原有排班。`,
        confirmText: "保存", success: res => resolve(res.confirm), fail: reject }));
      if (!current() || !this._visible || this.data.formVersion !== confirmationVersion || !accept) return;
      const result = await admin.saveWeeklyDays(id, days);
      if (!current()) return;
      for (const day of result.days) {
        const draft = { ...day.schedule, minDuration: String(day.schedule.minDuration), projectIds: day.serviceItemIds };
        draft.ranges = displayRanges(draft.ranges, times(draft.step));
        this._weekDrafts[day.weekday] = draftOf(draft);
        this._weekOriginals[day.weekday] = draftSignature(draft);
      }
      this.showWeekday(this._weekDrafts[this.data.selectedDays[0]]);
      this.syncDirtyDays(true);
      if (this._visible) wx.showToast({ title: "周排班已保存" });
    } catch (error) {
      if (current()) {
        const message = error.message || "保存失败，请重试";
        this.setData({ weekNotice: message });
        if (this._visible) errorText(message);
      }
    } finally {
      if (current()) this.setData({ saving: false, formVersion: ++formVersion });
    }
  }
});
