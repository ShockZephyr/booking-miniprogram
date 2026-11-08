Component({
  properties: {
    user: { type: Object, value: null }
  },
  observers: {
    user(user) {
      const name = (user && user.nickname) || "芳";
      this.setData({ initial: name.slice(0, 1) });
    }
  },
  data: {
    initial: "芳"
  }
});
