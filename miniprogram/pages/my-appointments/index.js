const loginReturn = require("../../utils/loginReturn");
const appointmentService = require("../../services/appointment");
const adminService = require("../../services/admin");
const therapistPortal = require("../../services/therapistPortal");
const userService = require("../../services/user");
const therapistService = require("../../services/therapist");
const dateUtil = require("../../utils/date");
const filterTime = require("../../utils/filterTime");
const checkIn = require("../../utils/checkIn");
const confirmation = require("../../utils/confirmation");
const appointmentInbox = require('../../services/appointmentInbox');

const PAGE_SIZE = 20;
const DEFAULT_SORT = "service_desc";
const SORT_OPTIONS = [
  { key: "service_asc", text: "服务时间：从早到晚" },
  { key: "service_desc", text: "服务时间：从晚到早" },
  { key: "created_asc", text: "创建时间：从早到晚" },
  { key: "created_desc", text: "创建时间：从晚到早" }
];
function currentDate() {
  return typeof dateUtil.today === "function" ? dateUtil.today() : "1970-01-01";
}
function defaultDateRange() {
  const today = currentDate();
  return {
    from: typeof dateUtil.addDays === "function" ? dateUtil.addDays(today, -10) : today,
    to: typeof dateUtil.addDays === "function" ? dateUtil.addDays(today, 10) : today
  };
}
const INITIAL_DATES = defaultDateRange();
const DEFAULT_START_TIME = "00:00";
const DEFAULT_END_TIME = "23:59";
const INACTIVE_PROJECT_FILTER_ID = "__inactive_projects__";
const INACTIVE_THERAPIST_FILTER_ID = "__inactive_therapists__";
const pickerValue = filterTime.indexFromTime;

function filterSessionKey() {
  const app = typeof getApp === "function" ? getApp() : null;
  const state = app && app.globalData || {};
  return `${identityKey(state.user)}:${state.token || ""}:${app && app._loginSessionVersion || 0}`;
}

function allOptionsSelected(selectedIds, options) {
  return !!options.length && options.every((item) => selectedIds.includes(item.id));
}

function visibleSelection(selectedIds, options) {
  const visibleIds = new Set(options.map((item) => item.id));
  return selectedIds.filter((id) => visibleIds.has(id));
}

function filterOption(item, checkedIds) {
  return {
    id: item.id,
    name: item.name,
    filterInactiveOption: !!item.filterInactiveOption,
    filterChecked: checkedIds.includes(item.id)
  };
}

function filterOptions(items, inactiveId, supportsInactiveFilters) {
  const activeItems = (items || []).filter((item) => !item.inactive);
  const inactiveName = inactiveId === INACTIVE_PROJECT_FILTER_ID ? "已停用的项目" : "已停用的芳疗师";
  return supportsInactiveFilters
    ? activeItems.concat({ id: inactiveId, name: inactiveName, filterInactiveOption: true })
    : activeItems;
}

function activeFilterOptionsFallback(therapistMode, requested) {
  const settle = (promise, map) => promise
    .then((value) => ({ value: map(value) }))
    .catch((error) => ({ error }));
  const projectsRequest = requested.projects
    ? settle(userService.serviceItems(), (data) => data.items || [])
    : Promise.resolve({});
  const therapistsRequest = therapistMode || !requested.therapists
    ? Promise.resolve({})
    : settle(therapistService.list(), (data) => data.therapists || []);

  return Promise.all([projectsRequest, therapistsRequest]).then(([projects, therapists]) => {
    return {
      serviceItems: projects.value,
      therapists: therapists.value,
      serviceItemsError: projects.error ? "项目加载失败" : "",
      therapistsError: therapists.error ? "芳疗师加载失败" : "",
      requested,
      supportsInactiveFilters: false,
      partial: !!(projects.error || therapists.error)
    };
  });
}

function appointmentFilterCount(data, options = {}) {
  return (data.filterServiceItemIds.length && !data.filterAllProjects ? 1 : 0)
    + (!options.therapist && data.filterTherapistIds.length && !data.filterAllTherapists ? 1 : 0)
    + (!data.filterAllDates ? 1 : 0)
    + (data.filterStartTime !== DEFAULT_START_TIME || data.filterEndTime !== DEFAULT_END_TIME ? 1 : 0);
}

function identityKey(user) {
  if (!user) return "guest";
  return `${user.id || ""}:${user.role || "user"}:${user.therapistId || ""}`;
}

const TABS = [
  { key: "pending", text: "待签到" },
  { key: "checked_in", text: "已签到" },
  { key: "cancelled", text: "已取消" },
  { key: "all", text: "全部" }
];

const EMPTY_TEXT = {
  pending: "暂无待签到预约",
  checked_in: "暂无已签到预约",
  cancelled: "暂无已取消预约",
  all: "暂无预约记录"
};

function decorate(item, options = {}) {
  const actionableBooked = item.status === "booked";
  const actionableNoShow = item.status === "no_show";
  const canCheckIn = checkIn.canCheckIn(item);
  const statusText = {
    booked: "已预约",
    checked_in: "已签到",
    cancelled: "已取消",
    replaced: "已修改",
    no_show: "未签到"
  }[item.status] || item.status;
  const notePreview = item.note && item.note.length > 13 ? `${item.note.slice(0, 13)}...` : item.note;
  return Object.assign({}, item, {
    displayStatus: item.status,
    statusText,
    notePreview,
    canAct: canCheckIn || (!options.therapist && (actionableBooked || actionableNoShow)),
    canCheckIn,
    canCancel: !options.therapist && (actionableBooked || actionableNoShow),
    canModify: !!options.canBook && (actionableBooked || item.status === "checked_in") && !dateUtil.isExpired(item.date, item.endTime)
  });
}

Page({
  data: {
    tabs: TABS,
    unreadTabs: {},
    active: "pending",
    emptyText: EMPTY_TEXT.pending,
    isAdminMode: false,
    isTherapistMode: false,
    hasUser: false,
    identityReady: true,
    appointments: [],
    loading: false,
    loadingMore: false,
    listError: "",
    moreError: "",
    serviceItemsLoading: false,
    therapistsLoading: false,
    serviceItemsError: "",
    therapistsError: "",
    nextCursor: "",
    page: 1,
    hasMore: false,
    selectedAppointmentId: "",
    selectedAppointment: null,
    signing: false,
    cancelling: false,
    sort: DEFAULT_SORT,
    sortOptions: SORT_OPTIONS,
    sortMenuVisible: false,
    sortVersion: 0,
    filterDrawerVisible: false,
    filterServiceItemIds: [], filterTherapistIds: [],
    filterAllProjects: false, filterAllTherapists: false,
    filterFromDate: INITIAL_DATES.from, filterToDate: INITIAL_DATES.to, filterAllDates: true,
    filterStartTime: DEFAULT_START_TIME, filterEndTime: DEFAULT_END_TIME,
    draftFilterServiceItemIds: [], draftFilterTherapistIds: [],
    draftAllProjects: false, draftAllTherapists: false,
    draftFromDate: INITIAL_DATES.from, draftToDate: INITIAL_DATES.to, draftAllDates: true,
    draftStartTime: DEFAULT_START_TIME, draftEndTime: DEFAULT_END_TIME,
    draftStartPickerValue: pickerValue(DEFAULT_START_TIME, "startTime"),
    draftEndPickerValue: pickerValue(DEFAULT_END_TIME, "endTime"),
    filterVersion: 0,
    activeFilterCount: 0,
    serviceItems: [], therapists: [], startTimeRange: filterTime.startLabels, endTimeRange: filterTime.endLabels
  },

  onLoad(query) {
    this._unloaded = false;
    this._filterOwner = filterSessionKey();
    this._inboxEntryOwner = query.inbox === '1' ? this._filterOwner : '';
    if (this._inboxEntryOwner) this.setData({ sort: 'created_desc' });
    this.setData({ filterVersion: this.data.filterVersion + 1 });
    const status = ["booked", "no_show"].includes(query.status) ? "pending" : query.status;
    const isAdminMode = query.admin === "1";
    const isTherapistMode = query.therapist === "1" && !isAdminMode;
    const active = TABS.some((item) => item.key === status) ? status : "pending";
    this.setData({ active, emptyText: EMPTY_TEXT[active], isAdminMode, isTherapistMode });
    if (wx.setNavigationBarTitle) {
      wx.setNavigationBarTitle({ title: isAdminMode ? "全部预约" : isTherapistMode ? "客户预约" : "我的预约" });
    }
  },

  onShow() {
    // Returning starts a new visible visit before asynchronous identity refresh.
    // Hidden loads/render callbacks must not survive into this loading screen.
    this.invalidateReadConfirmations();
    this._openingDetail = false;
    this._hidden = false;
    this.setData({ filterVersion: this.data.filterVersion + 1,
      sortMenuVisible: false, sortVersion: this.data.sortVersion + 1 });
    if (this._confirmedAction) confirmation.reconcile(this);
    this._openingEditor = false;
    this._editorNavigationId = (this._editorNavigationId || 0) + 1;
    checkIn.startWatching(this, this.refreshCheckInAvailability);
    const dates = defaultDateRange();
    if (this.data.filterAllDates && !this.data.filterDrawerVisible) {
      this.setData({ filterFromDate: dates.from, filterToDate: dates.to,
        draftFromDate: dates.from, draftToDate: dates.to });
    }
    const app = typeof getApp === "function" ? getApp() : null;
    if (!app || !app.globalData) {
      if (this.data.isAdminMode || this.data.isTherapistMode) this.loadFilterOptions();
      this.load();
      return;
    }
    const identityRequestId = this._identityRequestId = (this._identityRequestId || 0) + 1;
    this._listRequestId = (this._listRequestId || 0) + 1;
    this._filterOptionsRequestId = (this._filterOptionsRequestId || 0) + 1;
    if (app.globalData.token && app.refreshMe) {
      this.setData({
        identityReady: false,
        isAdminMode: false,
        isTherapistMode: false,
        hasUser: false,
        appointments: [],
        selectedAppointmentId: "",
        selectedAppointment: null,
        loading: true,
        loadingMore: false
      });
      app.refreshMe().then((user) => {
        if (this._hidden || this._unloaded || identityRequestId !== this._identityRequestId) return;
        this.showForUser(user);
      });
      return;
    }
    this.showForUser(app.globalData.user);
  },

  onHide() {
    this._hidden = true;
    this._identityRequestId = (this._identityRequestId || 0) + 1;
    this.invalidateReadConfirmations();
    this._cancelViewVersion = (this._cancelViewVersion || 0) + 1;
    this.setData({ filterVersion: this.data.filterVersion + 1,
      sortMenuVisible: false, sortVersion: this.data.sortVersion + 1 });
    checkIn.stopWatching(this);
  },
  onUnload() {
    this._unloaded = true;
    this.invalidateReadConfirmations();
    if (this._confirmedAction) confirmation.clear(this);
    this._identityRequestId = (this._identityRequestId || 0) + 1;
    this._listRequestId = (this._listRequestId || 0) + 1;
    this._editorNavigationId = (this._editorNavigationId || 0) + 1;
    checkIn.stopWatching(this);
  },

  refreshCheckInAvailability() {
    if (!this.data.identityReady || this.data.loading) return;
    let changed = false;
    const appointments = this.data.appointments.map((item) => {
      const updated = decorate(item, { therapist: this.data.isTherapistMode, canBook: this.data.canBook });
      if (updated.canCheckIn === item.canCheckIn && updated.canAct === item.canAct && updated.canModify === item.canModify) return item;
      changed = true;
      return updated;
    });
    if (changed) this.setData({
      appointments,
      selectedAppointment: appointments.find((item) => item.id === this.data.selectedAppointmentId) || null
    });
  },

  showForUser(user) {
    const isAdminMode = !!user && user.role === "admin";
    const isTherapistMode = !!user && !isAdminMode && !!user.therapistId;
    const nextIdentityKey = identityKey(user);
    const identityChanged = this._identityKey !== undefined && this._identityKey !== nextIdentityKey;
    const filterOwner = filterSessionKey();
    const filterSessionChanged = this._filterOwner !== undefined && this._filterOwner !== filterOwner;
    this._filterOwner = filterOwner;
    this._identityKey = nextIdentityKey;
    this._listRequestId = (this._listRequestId || 0) + 1;
    this._filterOptionsRequestId = (this._filterOptionsRequestId || 0) + 1;
    const dates = defaultDateRange();
    const reset = identityChanged ? {
      sort: DEFAULT_SORT,
      filterDrawerVisible: false,
      filterServiceItemIds: [], filterTherapistIds: [],
      filterAllProjects: false, filterAllTherapists: false,
      filterFromDate: dates.from, filterToDate: dates.to, filterAllDates: true,
      filterStartTime: DEFAULT_START_TIME, filterEndTime: DEFAULT_END_TIME,
      draftFilterServiceItemIds: [], draftFilterTherapistIds: [],
      draftAllProjects: false, draftAllTherapists: false,
      draftFromDate: dates.from, draftToDate: dates.to, draftAllDates: true,
      draftStartTime: DEFAULT_START_TIME, draftEndTime: DEFAULT_END_TIME,
      draftStartPickerValue: pickerValue(DEFAULT_START_TIME, "startTime"),
      draftEndPickerValue: pickerValue(DEFAULT_END_TIME, "endTime"),
      activeFilterCount: 0,
      serviceItems: [], therapists: []
    } : {};
    if (this._inboxEntryOwner && this._inboxEntryOwner !== filterOwner) {
      Object.assign(reset, { sort: DEFAULT_SORT, active: 'pending' });
      this._inboxEntryOwner = '';
    }
    if (identityChanged || filterSessionChanged) {
      // Keep same-account confirmed filters, but never resume an old session's drawer.
      Object.assign(reset, { filterDrawerVisible: false, filterVersion: this.data.filterVersion + 1,
        sortMenuVisible: false, sortVersion: this.data.sortVersion + 1 });
    }
    this.setData(Object.assign(reset, {
      isAdminMode,
      isTherapistMode,
      hasUser: !!user,
      canBook: !!(user && user.capabilities && user.capabilities.bookAppointment && !isAdminMode && !isTherapistMode),
      identityReady: true,
      nextCursor: "",
      page: 1,
      hasMore: false,
      appointments: [],
      unreadTabs: {},
      selectedAppointmentId: "",
      selectedAppointment: null,
      loading: !!user,
      loadingMore: false,
      listError: "", moreError: "",
      serviceItemsLoading: false, therapistsLoading: false,
      serviceItemsError: "", therapistsError: "",
      emptyText: user ? EMPTY_TEXT[this.data.active] : "请先登录"
    }));
    if (wx.setNavigationBarTitle) {
      wx.setNavigationBarTitle({ title: isAdminMode ? "全部预约" : isTherapistMode ? "客户预约" : "我的预约" });
    }
    if (!user) {
      this.loginForAppointment();
      return;
    }
    this.loadFilterOptions();
    this.load();
  },

  loginForAppointment() {
    if (loginReturn.request) loginReturn.request(`/pages/my-appointments/index?status=${this.data.active}`);
  },

  switchTab(event) {
    this.setData({
      sortMenuVisible: false, sortVersion: this.data.sortVersion + 1,
      active: event.currentTarget.dataset.key,
      emptyText: EMPTY_TEXT[event.currentTarget.dataset.key],
      page: 1,
      hasMore: false,
      selectedAppointmentId: "",
      selectedAppointment: null
    }, () => this.load());
  },

  load(options = {}) {
    if (!this.data.identityReady) return;
    const append = !!options.append;
    if (append) {
      if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
      this.setData({ loadingMore: true, moreError: "" });
    } else {
      this.invalidateReadConfirmations();
      this.setData({
        loading: true,
        loadingMore: false,
        listError: "",
        moreError: "",
        appointments: [],
        unreadTabs: {},
        page: 1,
        nextCursor: "",
        hasMore: false,
        selectedAppointmentId: "",
        selectedAppointment: null
      });
    }

    const requestId = this._listRequestId = (this._listRequestId || 0) + 1;
    const owner = filterSessionKey();
    const readGeneration = this._readGeneration;
    const current = () => !this._unloaded && requestId === this._listRequestId && owner === filterSessionKey();
    const nextPage = append ? this.data.page + 1 : 1;
    const query = { status: this.data.active, sort: this.data.sort, page: nextPage, pageSize: PAGE_SIZE };
    if (this.data.isAdminMode || this.data.isTherapistMode) query.unread = '1';
    if (append && this.data.nextCursor) query.cursor = this.data.nextCursor;
    const selectedProjectIds = this.data.filterAllProjects ? [] : this.data.filterServiceItemIds;
    const selectedTherapistIds = this.data.isTherapistMode || this.data.filterAllTherapists
      ? []
      : this.data.filterTherapistIds;
    Object.assign(query, {
      serviceItemIds: selectedProjectIds.filter((id) => id !== INACTIVE_PROJECT_FILTER_ID),
      therapistIds: selectedTherapistIds.filter((id) => id !== INACTIVE_THERAPIST_FILTER_ID),
      includeInactiveServiceItems: selectedProjectIds.includes(INACTIVE_PROJECT_FILTER_ID) ? "1" : "",
      includeInactiveTherapists: selectedTherapistIds.includes(INACTIVE_THERAPIST_FILTER_ID) ? "1" : "",
      fromDate: this.data.filterAllDates ? "" : this.data.filterFromDate,
      toDate: this.data.filterAllDates ? "" : this.data.filterToDate,
      startTime: this.data.filterStartTime,
      endTime: this.data.filterEndTime
    });
    const request = this.data.isAdminMode
      ? adminService.appointments(query)
      : this.data.isTherapistMode
        ? therapistPortal.appointments(query)
        : appointmentService.my(this.data.active, query);

    request
      .then((data) => {
        if (!current()) return;
        const incoming = (data.appointments || []).map((item) => decorate(item, { therapist: this.data.isTherapistMode, canBook: this.data.canBook }));
        // Capture receipt versions before handing mutable card objects to setData.
        const readEntries = incoming.filter(item => item.unreadKind && item.unreadVersion)
          .map(item => ({ id: item.id, version: item.unreadVersion }));
        const pagination = data.pagination || {};
        this._readViewId = data.inboxViewId || '';
        this.setData({
          appointments: append ? Array.from(new Map(this.data.appointments.concat(incoming).map((item) => [item.id, item])).values()) : incoming,
          nextCursor: pagination.nextCursor || "",
          page: pagination.page || nextPage,
          hasMore: !!pagination.hasMore,
          loading: false,
          loadingMore: false,
          unreadTabs: data.unread && data.unread.tabs || {}
        }, () => {
          // Append has its own transport request, but retains previous pages.
          // Only a new browsing generation/session (or hide) invalidates their
          // render completion, not the next page starting or finishing first.
          if (!query.unread || !this.isReadConfirmationCurrent(data.inboxViewId, owner, readGeneration)) return;
          this.queueReadConfirmation(data.inboxViewId, readEntries, owner);
        });
      })
      .catch((error) => {
        if (!current()) return;
        if (append && error.code === 'INBOX_VIEW_EXPIRED') {
          this.load();
          return;
        }
        this.setData({ loading: false, loadingMore: false,
          [append ? "moreError" : "listError"]: error.message || "预约记录加载失败" });
        wx.showToast({ title: error.message || "加载失败", icon: "none" });
      });
  },

  invalidateReadConfirmations() {
    this._readGeneration = (this._readGeneration || 0) + 1;
    this._readViewId = '';
    if (this._readRetryTimer) clearTimeout(this._readRetryTimer);
    this._readRetryTimer = null;
    this._readPending = [];
    // A request already sent may finish. Its generation cannot update this visit.
  },

  isReadConfirmationCurrent(viewId, owner, generation) {
    return !this._hidden && !this._unloaded && this.data.identityReady && this.data.hasUser
      && (this.data.isAdminMode || this.data.isTherapistMode) && !this.data.loading
      && owner === filterSessionKey() && generation === this._readGeneration
      && !!viewId && viewId === this._readViewId;
  },

  displayedReadEntries(entries) {
    const displayed = new Map(this.data.appointments.filter(item => item.unreadKind && item.unreadVersion)
      .map(item => [item.id, item.unreadVersion]));
    return entries.filter(item => displayed.get(item.id) === item.version);
  },

  queueReadConfirmation(viewId, readEntries, owner) {
    const entries = this.displayedReadEntries(readEntries);
    if (!entries.length) return;
    this._readPending = this._readPending || [];
    this._readPending.push({ viewId, entries, owner, generation: this._readGeneration });
    this.flushReadConfirmations();
  },

  flushReadConfirmations() {
    if (this._hidden || this._unloaded || this._reading || !this._readPending || !this._readPending.length) return;
    if (this.data.filterDrawerVisible || this.data.sortMenuVisible) return;
    if (this._readRetryTimer) clearTimeout(this._readRetryTimer);
    const job = this._readPending[0];
    const current = () => this.isReadConfirmationCurrent(job.viewId, job.owner, job.generation);
    if (!current()) { this._readPending.shift(); return this.flushReadConfirmations(); }
    this._reading = job;
    let failed = false;
    let sent = false;
    Promise.resolve().then(() => {
      if (!current() || this.data.filterDrawerVisible || this.data.sortMenuVisible) return null;
      const entries = this.displayedReadEntries(job.entries);
      if (!entries.length) {
        if (this._readPending[0] === job) this._readPending.shift();
        return null;
      }
      sent = true;
      job.attempts = (job.attempts || 0) + 1;
      return appointmentInbox.acknowledge(job.viewId, entries);
    })
      .then(result => {
        if (!current() || !sent) return;
        // An expired/rejected receipt remains unread on the server. Do not retry
        // an unusable view forever or clear the markers of this browsing visit.
        if (!result || !Array.isArray(result.acknowledged)) { failed = true; return; }
        if (this._readPending[0] === job) this._readPending.shift();
      }).catch(() => { failed = true; }).finally(() => {
        if (this._reading === job) this._reading = null;
        if (current() && failed && job.attempts < 3) {
          this._readRetryTimer = setTimeout(() => this.flushReadConfirmations(), 5000);
        } else {
          if (current() && failed && this._readPending[0] === job) this._readPending.shift();
          this.flushReadConfirmations();
        }
      });
  },

  onReachBottom() {
    if (this.data.sortMenuVisible) return;
    if (this.data.moreError) return;
    this.load({ append: true });
  },

  retryAppointments() {
    if (!this.data.identityReady || !this.data.hasUser || this.data.loading || this.data.loadingMore) return;
    if (!this.data.listError && !this.data.moreError) return;
    this.load({ append: !!this.data.moreError });
  },

  retryFilterOptions(event) {
    if (!this.acceptsFilterEvent(event)) return;
    if (!this.data.identityReady || !this.data.hasUser || this.data.serviceItemsLoading || this.data.therapistsLoading) return;
    if (!this.data.serviceItemsError && !this.data.therapistsError) return;
    this.loadFilterOptions({ projects: !!this.data.serviceItemsError, therapists: !!this.data.therapistsError });
  },

  loadFilterOptions(requested = { projects: true, therapists: true }) {
    const requestId = this._filterOptionsRequestId = (this._filterOptionsRequestId || 0) + 1;
    const owner = filterSessionKey();
    const current = () => !this._unloaded && requestId === this._filterOptionsRequestId && owner === filterSessionKey();
    const therapistMode = this.data.isTherapistMode;
    this.setData({ serviceItemsLoading: requested.projects, therapistsLoading: !therapistMode && requested.therapists });
    const request = typeof appointmentService.filterOptions === "function"
      ? appointmentService.filterOptions().catch((error) => {
        if (error && (error.code === "NOT_FOUND" || error.statusCode === 404)) {
          return activeFilterOptionsFallback(therapistMode, requested);
        }
        throw error;
      })
      : activeFilterOptionsFallback(therapistMode, requested);
    request.then((data) => {
      const canUseFilters = this.data.hasUser || this.data.isAdminMode || this.data.isTherapistMode;
      if (!current() || !canUseFilters) return;
      const supportsInactiveFilters = data.supportsInactiveFilters === true;
      const projectsUpdated = !data.serviceItemsError && (!data.requested || data.requested.projects);
      const therapistsUpdated = !therapistMode && !data.therapistsError && (!data.requested || data.requested.therapists);
      const serviceItems = projectsUpdated ? filterOptions(
        data.serviceItems || data.items || [],
        INACTIVE_PROJECT_FILTER_ID,
        supportsInactiveFilters
      ) : this.data.serviceItems;
      const therapists = therapistMode
        ? []
        : therapistsUpdated ? filterOptions(data.therapists || [], INACTIVE_THERAPIST_FILTER_ID, supportsInactiveFilters) : this.data.therapists;
      const savedProjectIds = !projectsUpdated ? this.data.filterServiceItemIds : this.data.filterAllProjects
        ? serviceItems.map((item) => item.id)
        : visibleSelection(this.data.filterServiceItemIds, serviceItems);
      const savedTherapistIds = !therapistsUpdated ? this.data.filterTherapistIds : this.data.filterAllTherapists
        ? therapists.map((item) => item.id)
        : visibleSelection(this.data.filterTherapistIds, therapists);
      const draftProjectIds = this.data.filterDrawerVisible
        ? (!projectsUpdated ? this.data.draftFilterServiceItemIds : this.data.draftAllProjects ? serviceItems.map((item) => item.id) : visibleSelection(this.data.draftFilterServiceItemIds, serviceItems))
        : savedProjectIds;
      const draftTherapistIds = this.data.filterDrawerVisible
        ? (!therapistsUpdated ? this.data.draftFilterTherapistIds : this.data.draftAllTherapists ? therapists.map((item) => item.id) : visibleSelection(this.data.draftFilterTherapistIds, therapists))
        : savedTherapistIds;
      const queryChanged = (!this.data.filterAllProjects && savedProjectIds.join() !== this.data.filterServiceItemIds.join())
        || (!this.data.filterAllTherapists && savedTherapistIds.join() !== this.data.filterTherapistIds.join());
      const next = {
        serviceItemsLoading: false, therapistsLoading: false,
        serviceItemsError: data.serviceItemsError || "",
        therapistsError: therapistMode ? "" : data.therapistsError || "",
        filterServiceItemIds: savedProjectIds,
        filterTherapistIds: savedTherapistIds,
        draftFilterServiceItemIds: draftProjectIds,
        draftFilterTherapistIds: draftTherapistIds,
        serviceItems: serviceItems.map((item) => filterOption(item, draftProjectIds)),
        therapists: therapists.map((item) => filterOption(item, draftTherapistIds))
      };
      next.activeFilterCount = appointmentFilterCount(Object.assign({}, this.data, next), { therapist: therapistMode });
      this.setData(next, () => {
        if (data.partial) wx.showToast({ title: "部分筛选项加载失败", icon: "none" });
        if (queryChanged) this.load();
      });
    }).catch((error) => {
      const canUseFilters = this.data.hasUser || this.data.isAdminMode || this.data.isTherapistMode;
      if (!current() || !canUseFilters) return;
      this.setData({ serviceItemsLoading: false, therapistsLoading: false,
        serviceItemsError: "项目加载失败", therapistsError: therapistMode ? "" : "芳疗师加载失败" });
      wx.showToast({ title: error.message || "筛选项加载失败", icon: "none" });
    });
  },

  acceptsSortEvent(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset;
    const version = dataset && Number(dataset.sortVersion);
    return Number.isSafeInteger(version) && version === this.data.sortVersion
      && !this._hidden && !this._unloaded && this.data.identityReady && this.data.hasUser
      && !this.data.filterDrawerVisible && this._filterOwner === filterSessionKey();
  },
  toggleSortMenu(event) {
    if (!this.acceptsSortEvent(event)) return;
    this.setData({ sortMenuVisible: !this.data.sortMenuVisible, sortVersion: this.data.sortVersion + 1 }, () => this.flushReadConfirmations());
  },
  closeSortMenu(event) {
    if (!this.acceptsSortEvent(event) || !this.data.sortMenuVisible) return;
    this.setData({ sortMenuVisible: false, sortVersion: this.data.sortVersion + 1 }, () => this.flushReadConfirmations());
  },
  selectSort(event) {
    if (!this.acceptsSortEvent(event) || !this.data.sortMenuVisible) return;
    const sort = event.currentTarget.dataset.sort;
    if (!SORT_OPTIONS.some(option => option.key === sort)) return;
    const changed = sort !== this.data.sort;
    this.setData({ sort, sortMenuVisible: false, sortVersion: this.data.sortVersion + 1 }, () => {
      if (!changed) this.flushReadConfirmations();
    });
    if (changed) {
      this.load();
      if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    }
  },

  acceptsFilterEvent(event, drawer = true) {
    const version = event && event.currentTarget && event.currentTarget.dataset
      && Number(event.currentTarget.dataset.filterVersion);
    return Number.isSafeInteger(version) && version === this.data.filterVersion
      && !this._unloaded && !this._hidden && this.data.identityReady && this.data.hasUser
      && this._filterOwner === filterSessionKey() && this.data.filterDrawerVisible === drawer;
  },
  openFilterDrawer(event) {
    if (!this.acceptsFilterEvent(event, false)) return;
    const projectIds = this.data.serviceItemsError || this.data.serviceItemsLoading
      ? this.data.filterServiceItemIds.slice()
      : this.data.filterAllProjects
      ? this.data.serviceItems.map((item) => item.id)
      : visibleSelection(this.data.filterServiceItemIds, this.data.serviceItems);
    const therapistIds = this.data.therapistsError || this.data.therapistsLoading
      ? this.data.filterTherapistIds.slice()
      : this.data.filterAllTherapists
      ? this.data.therapists.map((item) => item.id)
      : visibleSelection(this.data.filterTherapistIds, this.data.therapists);
    this.setData({
      filterDrawerVisible: true,
      sortMenuVisible: false, sortVersion: this.data.sortVersion + 1,
      filterVersion: this.data.filterVersion + 1,
      draftFilterServiceItemIds: projectIds,
      draftFilterTherapistIds: therapistIds,
      draftAllProjects: this.data.filterAllProjects,
      draftAllTherapists: this.data.filterAllTherapists,
      draftFromDate: this.data.filterFromDate,
      draftToDate: this.data.filterToDate,
      draftAllDates: this.data.filterAllDates,
      draftStartTime: this.data.filterStartTime,
      draftEndTime: this.data.filterEndTime,
      draftStartPickerValue: pickerValue(this.data.filterStartTime, "startTime"),
      draftEndPickerValue: pickerValue(this.data.filterEndTime, "endTime"),
      serviceItems: this.data.serviceItems.map((item) => Object.assign({}, item, { filterChecked: projectIds.includes(item.id) })),
      therapists: this.data.therapists.map((item) => Object.assign({}, item, { filterChecked: therapistIds.includes(item.id) }))
    });
  },

  closeFilterDrawer(event) {
    if (!this.acceptsFilterEvent(event)) return;
    this.setData({ filterDrawerVisible: false, filterVersion: this.data.filterVersion + 1 }, () => this.flushReadConfirmations());
  },
  noop() {},
  selectFilterProjects(event) {
    if (!this.acceptsFilterEvent(event) || !Array.isArray(event.detail.value)) return;
    const ids = event.detail.value;
    this.setData({ draftFilterServiceItemIds: ids, draftAllProjects: allOptionsSelected(ids, this.data.serviceItems),
      serviceItems: this.data.serviceItems.map((item) => Object.assign({}, item, { filterChecked: ids.includes(item.id) })) });
  },
  selectAllProjects(event) {
    if (!this.acceptsFilterEvent(event)) return;
    const ids = this.data.serviceItems.map((item) => item.id);
    this.setData({ filterVersion: this.data.filterVersion + 1, draftFilterServiceItemIds: ids, draftAllProjects: !!ids.length,
      serviceItems: this.data.serviceItems.map((item) => Object.assign({}, item, { filterChecked: true })) });
  },
  selectFilterTherapists(event) {
    if (!this.acceptsFilterEvent(event) || this.data.isTherapistMode || !Array.isArray(event.detail.value)) return;
    const ids = event.detail.value;
    this.setData({ draftFilterTherapistIds: ids, draftAllTherapists: allOptionsSelected(ids, this.data.therapists),
      therapists: this.data.therapists.map((item) => Object.assign({}, item, { filterChecked: ids.includes(item.id) })) });
  },
  selectAllTherapists(event) {
    if (!this.acceptsFilterEvent(event) || this.data.isTherapistMode) return;
    const ids = this.data.therapists.map((item) => item.id);
    this.setData({ filterVersion: this.data.filterVersion + 1, draftFilterTherapistIds: ids, draftAllTherapists: !!ids.length,
      therapists: this.data.therapists.map((item) => Object.assign({}, item, { filterChecked: true })) });
  },
  inputFilterDate(event) {
    if (!this.acceptsFilterEvent(event)) return;
    const field = event.currentTarget.dataset.field;
    if (!["draftFromDate", "draftToDate"].includes(field) || !/^\d{4}-\d{2}-\d{2}$/.test(event.detail.value)) return;
    this.setData({ [field]: event.detail.value, draftAllDates: false });
  },
  useDateFilter(event) {
    if (!this.acceptsFilterEvent(event)) return;
    this.setData({ draftAllDates: false, filterVersion: this.data.filterVersion + 1 });
  },
  useAllDatesFilter(event) {
    if (!this.acceptsFilterEvent(event)) return;
    this.setData({ draftAllDates: true, filterVersion: this.data.filterVersion + 1 });
  },
  inputFilterStart(event) {
    this.inputFilterTime(event, "startTime");
  },
  inputFilterEnd(event) {
    this.inputFilterTime(event, "endTime");
  },
  inputFilterTime(event, field) {
    if (!this.acceptsFilterEvent(event)) return;
    const time = filterTime.timeFromIndex(event.detail.value, field);
    if (!time) return;
    const previous = { startTime: this.data.draftStartTime, endTime: this.data.draftEndTime };
    // Historical appointments have no minimum duration constraint.
    const next = filterTime.editRange(previous, field, time, null);
    if (!next) wx.showToast({ title: "开始时间需早于结束时间", icon: "none" });
    const { startTime, endTime } = next || previous;
    this.setData({
      draftStartTime: startTime,
      draftStartPickerValue: pickerValue(startTime, "startTime"),
      draftEndTime: endTime,
      draftEndPickerValue: pickerValue(endTime, "endTime")
    });
  },
  useAllTimesFilter(event) {
    if (!this.acceptsFilterEvent(event)) return;
    this.setData({
      filterVersion: this.data.filterVersion + 1,
      draftStartTime: DEFAULT_START_TIME,
      draftEndTime: DEFAULT_END_TIME,
      draftStartPickerValue: pickerValue(DEFAULT_START_TIME, "startTime"),
      draftEndPickerValue: pickerValue(DEFAULT_END_TIME, "endTime")
    });
  },
  resetFilterDraft(event) {
    if (!this.acceptsFilterEvent(event)) return;
    const dates = defaultDateRange();
    this.setData({
      filterVersion: this.data.filterVersion + 1,
      draftFilterServiceItemIds: [], draftFilterTherapistIds: [],
      draftAllProjects: false, draftAllTherapists: false,
      draftFromDate: dates.from, draftToDate: dates.to, draftAllDates: true,
      draftStartTime: DEFAULT_START_TIME, draftEndTime: DEFAULT_END_TIME,
      draftStartPickerValue: pickerValue(DEFAULT_START_TIME, "startTime"),
      draftEndPickerValue: pickerValue(DEFAULT_END_TIME, "endTime"),
      serviceItems: this.data.serviceItems.map((item) => Object.assign({}, item, { filterChecked: false })),
      therapists: this.data.therapists.map((item) => Object.assign({}, item, { filterChecked: false }))
    });
  },
  confirmFilters(event) {
    if (!this.acceptsFilterEvent(event)) return;
    if (!this.data.draftAllDates && this.data.draftFromDate > this.data.draftToDate) {
      wx.showToast({ title: "开始日期需早于结束日期", icon: "none" }); return;
    }
    if (this.data.draftStartTime >= this.data.draftEndTime) {
      wx.showToast({ title: "开始时间需早于结束时间", icon: "none" }); return;
    }
    const projectsUnavailable = !!(this.data.serviceItemsError || this.data.serviceItemsLoading);
    const therapistsUnavailable = !!(this.data.therapistsError || this.data.therapistsLoading);
    const filterAllProjects = projectsUnavailable ? this.data.draftAllProjects
      : allOptionsSelected(this.data.draftFilterServiceItemIds, this.data.serviceItems);
    const filterAllTherapists = !this.data.isTherapistMode
      && (therapistsUnavailable ? this.data.draftAllTherapists : allOptionsSelected(this.data.draftFilterTherapistIds, this.data.therapists));
    const next = {
      filterDrawerVisible: false,
      filterVersion: this.data.filterVersion + 1,
      filterServiceItemIds: projectsUnavailable ? this.data.draftFilterServiceItemIds.slice() : visibleSelection(this.data.draftFilterServiceItemIds, this.data.serviceItems),
      filterTherapistIds: this.data.isTherapistMode ? [] : therapistsUnavailable ? this.data.draftFilterTherapistIds.slice() : visibleSelection(this.data.draftFilterTherapistIds, this.data.therapists),
      filterAllProjects,
      filterAllTherapists,
      filterFromDate: this.data.draftFromDate,
      filterToDate: this.data.draftToDate,
      filterAllDates: this.data.draftAllDates,
      filterStartTime: this.data.draftStartTime,
      filterEndTime: this.data.draftEndTime
    };
    next.activeFilterCount = appointmentFilterCount(next, { therapist: this.data.isTherapistMode });
    this.setData(next, () => this.load());
  },

  selectAppointment(event) {
    if (this._unloaded || this._hidden || this._openingDetail || this.data.loading
      || (this._filterOwner !== undefined && this._filterOwner !== filterSessionKey())) return;
    const id = event.currentTarget.dataset.id;
    const appointment = this.data.appointments.find(item => item.id === id);
    if (!appointment || !this.data.hasUser) return;
    const page = this.data.isAdminMode ? "admin/slot-appointment" : this.data.isTherapistMode ? "therapist/appointment-detail" : "appointment-detail";
    this._openingDetail = true;
    wx.navigateTo({ url: `/pages/${page}/index?appointmentId=${encodeURIComponent(id)}`,
      fail: () => { this._openingDetail = false; wx.showToast({ title: "无法打开预约，请重试", icon: "none" }); } });
  },

  cardAction(event) {
    if (this._unloaded || this._hidden || this.data.signing || this.data.cancelling
      || (this._filterOwner !== undefined && this._filterOwner !== filterSessionKey())) return;
    const type = event.detail.type;
    const appointment = event.detail.appointment;
    if (!["checkIn", "cancel", "modify"].includes(type)) return;
    if ((this.data.isAdminMode || this.data.isTherapistMode) && type !== "checkIn") return;
    if (type === "modify") {
      if (this._openingEditor) return;
      const user = getApp().globalData.user;
      if (!user || user.id !== appointment.userId || !user.capabilities || !user.capabilities.bookAppointment
          || !["booked","checked_in"].includes(appointment.status) || dateUtil.isExpired(appointment.date, appointment.endTime)) {
        wx.showToast({ title: "当前预约无法修改", icon: "none" }); return;
      }
      this._openingEditor = true;
      const navigationId = this._editorNavigationId = (this._editorNavigationId || 0) + 1;
      wx.navigateTo({
        url: `/pages/schedule-day/index?therapistId=${encodeURIComponent(appointment.therapistId)}&date=${encodeURIComponent(appointment.date)}&appointmentId=${encodeURIComponent(appointment.id)}`,
        fail: () => {
          if (navigationId !== this._editorNavigationId) return;
          this._openingEditor = false;
          wx.showToast({ title: "无法打开预约，请重试", icon: "none" });
        }
      });
      return;
    }
    if (
      (type === "checkIn" && !appointment.canCheckIn) ||
      (type === "cancel" && !appointment.canCancel)
    ) {
      wx.showToast({ title: "该预约当前不可操作", icon: "none" });
      return;
    }
    if (type === "checkIn") {
      const admin = this.data.isAdminMode, therapist = this.data.isTherapistMode;
      return confirmation.confirmCheckIn(this, {
        appointment,
        modal: { title: admin || therapist ? "为用户签到" : "确认签到",
          content: admin || therapist ? "请确认用户已经到店" : "请确认本人已到店。后续如需取消签到，请联系管理员。",
          confirmText: "确认签到", confirmColor: "#5c556b" },
        read: (id) => admin ? adminService.appointment(id) : therapist ? therapistPortal.appointment(id) : appointmentService.detail(id),
        submit: (id) => admin ? adminService.adminCheckInAppointment(id) : therapist ? therapistPortal.checkIn(id) : appointmentService.checkIn(id),
        refresh: () => this.load()
      });
    }
    const id = appointment.id, view = this._cancelViewVersion || 0, owner = filterSessionKey();
    const cancellable = () => {
      const user = getApp().globalData.user;
      const latest = this.data.appointments.find(item => item.id === id);
      return !this.data.loading && this.data.identityReady && user && user.role !== "admin" && !user.therapistId
        && latest && latest.userId === user.id && ["booked", "no_show"].includes(latest.status);
    };
    if (!cancellable()) { wx.showToast({ title: "预约信息已变化，请刷新后重试", icon: "none" }); return; }
    const work = confirmation.start(this, {
      busyKey: "cancelling",
      isTargetCurrent: () => !this._hidden && view === (this._cancelViewVersion || 0) && owner === filterSessionKey(),
      modal: { title: "确认取消预约", content: "取消后时间段将重新向所有人开放", confirmText: "确认取消", confirmColor: "#8f434c" },
      progress: "正在取消预约…",
      run: async ({ current }) => {
        if (!cancellable()) throw new Error("预约信息已变化，请刷新后重试");
        await appointmentService.cancel(id);
        if (!current()) return;
        wx.showToast({ title: "已取消预约", icon: "success" });
        await this.load();
      }
    });
    if (work) this.setData({ cancelling: true });
    return work;
  }
});
