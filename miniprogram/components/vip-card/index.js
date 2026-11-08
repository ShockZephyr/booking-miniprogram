Component({
  properties: {
    user: { type: Object, value: null }
  },
  methods: {
    open() {
      wx.navigateTo({ url: "/pages/member/index" });
    }
  }
});

