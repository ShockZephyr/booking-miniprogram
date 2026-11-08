Component({
  properties: {
    visible: { type: Boolean, value: false },
    months: { type: Array, value: [] },
    selected: { type: String, value: "" },
    statusMap: { type: Object, value: {} },
    hideDots: { type: Boolean, value: false }
  },
  data: {
    pendingDate: "",
    currentMonthId: "",
    statusLabels: {
      booked: "有待签到预约",
      cancelled: "有已取消预约",
      checked_in: "有已签到预约",
      no_show: "有未签到预约"
    }
  },
  observers: {
    visible(value) {
      if (value) this.setData({ pendingDate: this.properties.selected || "" });
    },
    selected(value) {
      this.setData({ pendingDate: value });
    },
    "months, visible"(months, visible) {
      if (!visible || !months || !months.length) return;
      const currentMonth = months.find((month) => month.current) || months[2] || months[0];
      this.setData({ currentMonthId: currentMonth.id });
    }
  },
  methods: {
    moveMonths(event) {
      this.triggerEvent("move", { direction: event.currentTarget.dataset.direction });
    },
    close() {
      this.setData({ pendingDate: this.properties.selected || "" });
      this.triggerEvent("close");
    },
    selectDay(event) {
      const date = event.currentTarget.dataset.date;
      if (!date || event.currentTarget.dataset.disabled) return;
      this.setData({ pendingDate: date });
    },
    confirm() {
      this.triggerEvent("confirm", { date: this.data.pendingDate || this.properties.selected });
    }
  }
});
