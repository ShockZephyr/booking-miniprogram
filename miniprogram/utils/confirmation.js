const loginReturn = require("./loginReturn");
const checkIn = require("./checkIn");

function sessionKey() {
  return loginReturn.sessionKey();
}

function clear(page) {
  const action = page._confirmedAction;
  page._confirmedAction = null;
  if (action && !page._unloaded && page.data[action.busyKey]) page.setData({ [action.busyKey]: false });
}

function reconcile(page) {
  if (page._confirmedAction && !page._confirmedAction.current()) clear(page);
}

// The confirmation belongs to a session and an immutable resource, not a read
// request version. A harmless onShow reload must not revoke explicit consent.
function start(page, options) {
  reconcile(page);
  if (page._unloaded || page._confirmedAction) return;
  const owner = sessionKey();
  const action = { busyKey: options.busyKey || "signing" };
  action.current = () => page._confirmedAction === action && !page._unloaded
    && owner === sessionKey() && (!options.isTargetCurrent || options.isTargetCurrent());
  page._confirmedAction = action;
  const ask = (modal) => new Promise((resolve, reject) => {
    if (!action.current()) { resolve(false); return; }
    wx.showModal(Object.assign({}, modal, {
      success: (result) => resolve(!!result.confirm && action.current()),
      fail: () => reject(new Error("确认未完成，请重试"))
    }));
  });
  const work = async () => {
    if (!await ask(options.modal) || !action.current()) return;
    page.setData({ [action.busyKey]: true });
    wx.showToast({ title: options.progress || "正在核对预约…", icon: "none" });
    await options.run({ current: action.current, ask });
  };
  action.promise = work().catch((error) => {
    if (action.current()) wx.showToast({ title: error.message || "操作失败，请重试", icon: "none" });
  }).finally(() => {
    if (page._confirmedAction === action) clear(page);
  });
  return action.promise;
}

function confirmCheckIn(page, options) {
  const id = options.appointment.id;
  return start(page, Object.assign({}, options, {
    run: async ({ current }) => {
      const read = async () => {
        const result = await options.read(id);
        if (!current()) return null;
        if (!result.appointment || result.appointment.id !== id) throw new Error("预约信息已变化，请重新打开");
        return result;
      };
      const latest = await read();
      if (!latest) return;
      if (latest.appointment.status !== "checked_in") {
        if (!checkIn.canCheckIn(latest.appointment, latest.slot)) {
          options.refresh();
          throw new Error("该预约当前不能签到，请查看最新状态");
        }
        if (!current()) return;
        try {
          await options.submit(id);
        } catch (error) {
          if (!current()) return;
          if (error.code !== "NETWORK_ERROR" && error.code !== "APPOINTMENT_ALREADY_CHECKED_IN") throw error;
          // Never replay a write with an unknown outcome. A read can establish
          // that check-in completed; otherwise leave the next decision explicit.
          let result;
          try { result = await read(); } catch (readError) {
            if (!current()) return;
            throw new Error("签到结果未确认，请刷新后查看");
          }
          if (!current()) return;
          if (!result || result.appointment.status !== "checked_in") {
            options.refresh();
            throw new Error("签到结果未确认，请刷新后查看");
          }
        }
      }
      if (!current()) return;
      wx.showToast({ title: "已签到", icon: "success" });
      options.refresh();
    }
  }));
}

module.exports = { start, confirmCheckIn, reconcile, clear };
