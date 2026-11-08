const dateUtil = require("../../utils/date");

Component({
  properties: {
    locked: { type: Boolean, value: false },
    first: { type: String, value: "", observer() { this.rebuildDates(); } },
    last: { type: String, value: "", observer() { this.rebuildDates(); } },
    selected: {
      type: String,
      value: "",
      observer() {
        this.rebuildDates();
      }
    },
    statusMap: { type: Object, value: {}, observer() { this.rebuildDates(); } },
    hideDots: { type: Boolean, value: false, observer() { this.rebuildDates(); } }
  },
  data: {
    scrollLeft: 0,
    visibleDates: []
  },
  lifetimes: {
    attached() {
      this.rebuildDates();
    },
    detached() {
      this._centerRequestId = (this._centerRequestId || 0) + 1;
    }
  },
  pageLifetimes: {
    show() { this.rebuildDates(); },
    resize() { this.centerSelected(); }
  },
  methods: {
    rebuildDates() {
      const selected = this.properties.selected || dateUtil.today();
      const statusLabels = { booked: "有待签到预约", cancelled: "有已取消预约", checked_in: "有已签到预约", no_show: "有未签到预约" };
      const visibleDates = dateUtil.buildDateStrip(selected, this.properties.first, this.properties.last).map((item) => {
        const status = !this.properties.hideDots && statusLabels[this.properties.statusMap[item.date]];
        return Object.assign({}, item, {
          selected: item.date === selected,
          accessibilityLabel: `${item.date}，${item.weekday}${item.date === selected ? "，已选择" : ""}${status ? `，${status}` : ""}`
        });
      });
      this.setData({ visibleDates });
      this.centerSelected();
    },
    centerSelected() {
      const requestId = this._centerRequestId = (this._centerRequestId || 0) + 1;
      wx.nextTick(() => {
        if (requestId !== this._centerRequestId) return;
        const dates = this.data.visibleDates || [];
        const selected = this.properties.selected || dateUtil.today();
        const index = dates.findIndex((item) => item.date === selected);
        if (index < 0) return;
        const query = wx.createSelectorQuery().in(this);
        query.select(".date-scroll").boundingClientRect();
        query.selectAll(".date-item").boundingClientRect();
        query.exec(([rect, items]) => {
          if (requestId !== this._centerRequestId) return;
          const first = items && items[0];
          const item = items && items[index];
          if (!rect || !rect.width || !first || !item || !item.width) return;
          // Relative positions cancel the current scroll offset; all values are measured px.
          const scrollLeft = Math.max(0, item.left - first.left - (rect.width - item.width) / 2);
          this.setData({ scrollLeft });
        });
      });
    },
    selectDate(event) {
      if (this.properties.locked) return;
      const date = event.currentTarget.dataset.date;
      this.triggerEvent("change", { date });
    },
    openCalendar() {
      if (this.properties.locked) return;
      this.triggerEvent("calendar");
    }
  }
});
