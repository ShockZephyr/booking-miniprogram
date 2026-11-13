const request = require("../utils/request");
const loginReturn = require("../utils/loginReturn");
const pending = new Map();
const prefix = admin => admin ? "/api/admin/appointments" : "/api/therapist/appointments";
const ownerKey = () => JSON.stringify([loginReturn.sessionKey(), getApp()._loginSessionVersion || 0]);

module.exports = {
  preview(admin, filters) {
    return request({ url: `${prefix(admin)}/check-in-preview`, method: "POST", data: { filters } });
  },
  pendingForCurrentSession() {
    const owner = ownerKey();
    const work = Array.from(pending.values()).filter(entry => entry.owner === owner).map(entry => entry.work);
    // A recreated list can refresh after a write started by an unloaded page.
    // Rejections also need a read to check the outcome; never replay the write.
    return work.length ? Promise.all(work.map(item => item.then(() => undefined, () => undefined))) : null;
  },
  submit(admin, filters, confirmationVersion) {
    const app = getApp();
    const key = JSON.stringify([loginReturn.sessionKey(), app._loginSessionVersion || 0, admin, confirmationVersion]);
    if (pending.has(key)) return pending.get(key).work;
    const owner = ownerKey();
    const work = request({ url: `${prefix(admin)}/check-in-batch`, method: "POST", data: { filters, confirmationVersion } })
      .finally(() => { if (pending.get(key) && pending.get(key).work === work) pending.delete(key); });
    pending.set(key, { owner, work });
    return work;
  }
};
