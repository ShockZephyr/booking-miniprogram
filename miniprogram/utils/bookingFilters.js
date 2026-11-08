const filterTime = require("./filterTime");
const loginReturn = require("./loginReturn");
const fresh = () => ({ serviceItemIds: [], therapistIds: [], allProjects: false, allTherapists: false,
  startTime: "00:00", endTime: "23:59" });
const owner = () => loginReturn.sessionKey() + ":" + (getApp()._loginSessionVersion || 0);
const query = filters => ({ serviceItemIds: filters.allProjects ? [] : filters.serviceItemIds,
  therapistIds: filters.allTherapists ? [] : filters.therapistIds, startTime: filters.startTime, endTime: filters.endTime });
const count = filters => {
  const value = query(filters);
  return Number(!!value.serviceItemIds.length) + Number(!!value.therapistIds.length)
    + Number(value.startTime !== "00:00" || value.endTime !== "23:59");
};

function minimumFor(filters, catalog) {
  const value = query(filters);
  const candidates = catalog.therapists.filter(person => person.hasSchedule && person.serviceItemIds.length
    && (!value.therapistIds.length || value.therapistIds.includes(person.id))
    && (!value.serviceItemIds.length || person.serviceItemIds.some(id => value.serviceItemIds.includes(id))));
  return candidates.length ? Math.min(...candidates.map(person => person.minDuration)) : null;
}

const adjustRange = filterTime.expandRange;

const initialData = { filters: fresh(), draftFilters: fresh(), filterDrawerVisible: false, filterReady: false,
  filterVersion: 0, activeFilterCount: 0, filterProjects: [], filterTherapists: [], draftMinimum: null,
  startTimeRange: filterTime.startLabels, endTimeRange: filterTime.endLabels,
  draftStartPickerValue: 0, draftEndPickerValue: 48 };

const methods = {
  resetBookingFilters() {
    this._filterOwner = owner(); this._filterCatalog = null;
    this.setData({ filters: fresh(), draftFilters: fresh(), activeFilterCount: 0, filterDrawerVisible: false,
      filterReady: false, filterProjects: [], filterTherapists: [], filterVersion: this.data.filterVersion + 1 });
  },
  receiveBookingFilters(result) {
    if (!result.filterOptions || !result.appliedFilters) {
      if (count(this.data.filters)) throw new Error("筛选暂不可用，请稍后重试");
      this.setData({ filterReady: false }); return;
    }
    this._filterCatalog = result.filterOptions;
    const filters = { ...this.data.filters, ...result.appliedFilters };
    if (filters.allProjects) filters.serviceItemIds = result.filterOptions.projects.map(item => item.id);
    if (filters.allTherapists) filters.therapistIds = result.filterOptions.therapists.map(item => item.id);
    this.setData({ filters, filterReady: true, activeFilterCount: count(filters) });
  },
  filterPageCurrent() {
    return this._alive && this.data.visible && !this.data.isTherapist && this._filterOwner === owner();
  },
  filterEventCurrent(event) {
    return this.filterPageCurrent() && this.data.filterDrawerVisible && !this.data.loading && this.data.filterReady
      && event && event.currentTarget && Number(event.currentTarget.dataset.filterVersion) === this.data.filterVersion;
  },
  openFilterDrawer() {
    if (!this.filterPageCurrent() || this.data.loading || this.data.error) return;
    if (!this.data.filterReady) { wx.showToast({ title: "筛选暂不可用，请稍后重试", icon: "none" }); return; }
    this.setData({ filterDrawerVisible: true, calendarVisible: false, filterVersion: this.data.filterVersion + 1 });
    this.updateFilterDraft({ ...this.data.filters, serviceItemIds: this.data.filters.serviceItemIds.slice(),
      therapistIds: this.data.filters.therapistIds.slice() });
  },
  closeFilterDrawer(event) {
    if (event && !this.filterEventCurrent(event)) return;
    this.setData({ filterDrawerVisible: false, filterVersion: this.data.filterVersion + 1 });
  },
  updateFilterDraft(filters) {
    const catalog = this._filterCatalog, minimum = minimumFor(filters, catalog);
    const draftFilters = { ...filters, ...adjustRange(filters.startTime, filters.endTime, minimum) };
    this.setData({ draftFilters, draftMinimum: minimum,
      draftStartPickerValue: filterTime.indexFromTime(draftFilters.startTime, "startTime"),
      draftEndPickerValue: filterTime.indexFromTime(draftFilters.endTime, "endTime"),
      filterProjects: catalog.projects.map(item => ({ ...item, checked: draftFilters.allProjects || draftFilters.serviceItemIds.includes(item.id) })),
      filterTherapists: catalog.therapists.map(item => ({ id: item.id, name: item.name,
        checked: draftFilters.allTherapists || draftFilters.therapistIds.includes(item.id) })) });
  },
  selectRosterOptions(event) {
    if (!this.filterEventCurrent(event)) return;
    const kind = event.currentTarget.dataset.kind;
    if (!["projects", "therapists"].includes(kind)) return;
    const options = this._filterCatalog[kind], all = kind === "projects" ? "allProjects" : "allTherapists";
    const field = kind === "projects" ? "serviceItemIds" : "therapistIds";
    const selected = event.currentTarget.dataset.all ? options.map(item => item.id)
      : options.filter(item => event.detail.value.includes(item.id)).map(item => item.id);
    this.updateFilterDraft({ ...this.data.draftFilters, [field]: selected, [all]: !!options.length && selected.length === options.length });
  },
  inputRosterTime(event) {
    if (!this.filterEventCurrent(event)) return;
    const field = event.currentTarget.dataset.field;
    if (!["startTime", "endTime"].includes(field)) return;
    const time = filterTime.timeFromIndex(event.detail.value, field);
    if (!time) return;
    const next = filterTime.editRange(this.data.draftFilters, field, time, this.data.draftMinimum);
    if (!next) {
      wx.showToast({ title: "当天剩余时间不足，请选择其他时间", icon: "none" });
      this.updateFilterDraft(this.data.draftFilters);
      return;
    }
    this.updateFilterDraft({ ...this.data.draftFilters, ...next });
  },
  useRosterAllTimes(event) {
    if (!this.filterEventCurrent(event)) return;
    this.setData({ filterVersion: this.data.filterVersion + 1 });
    this.updateFilterDraft({ ...this.data.draftFilters, startTime: "00:00", endTime: "23:59" });
  },
  resetRosterDraft(event) {
    if (!this.filterEventCurrent(event)) return;
    this.setData({ filterVersion: this.data.filterVersion + 1 });
    this.updateFilterDraft(fresh());
  },
  confirmRosterFilters(event) {
    if (!this.filterEventCurrent(event)) return;
    const filters = this.data.draftFilters;
    this.setData({ filters, activeFilterCount: count(filters) });
    this.closeFilterDrawer();
    return this.loadDay();
  },
  clearRosterFilters(event) {
    if (!this.filterPageCurrent() || this.data.loading || !event || !event.currentTarget
      || Number(event.currentTarget.dataset.filterVersion) !== this.data.filterVersion) return;
    this.setData({ filters: fresh(), activeFilterCount: 0 });
    this.closeFilterDrawer(); return this.loadDay();
  },
  noop() {}
};

module.exports = { fresh, query, count, minimumFor, adjustRange, initialData, methods };
