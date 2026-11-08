const request = require("../utils/request");
const session = require("../utils/loginReturn");
const images = require("./therapist");

const pending = new Set();
function write(options) {
  const task = request(options);
  pending.add(task);
  return task.finally(() => pending.delete(task));
}

async function list() {
  // Going back to the home or management page while a save is in flight must read its result.
  await Promise.all(Array.from(pending, task => task.catch(() => {})));
  const { items } = await request({ url: "/api/meta/covers", anonymous: true });
  return items.map(item => ({ ...item, imageSrc: images.imageUrl(item.imageUrl) }));
}

function adminOwner() {
  const app = getApp();
  return app.globalData.token && app.globalData.user && app.globalData.user.role === "admin"
    ? session.sessionKey() + ":" + (app._loginSessionVersion || 0) : "";
}

module.exports = {
  list, adminOwner, upload: images.upload,
  save: (id, imageUrl, previousImageUrl, creationKey) => write({ url: "/api/admin/covers" + (id ? "/" + encodeURIComponent(id) : ""),
    method: id ? "PATCH" : "POST", data: id ? { imageUrl, previousImageUrl } : { imageUrl, creationKey } }),
  remove: (id, previousImageUrl) => write({ url: "/api/admin/covers/" + encodeURIComponent(id), method: "DELETE", data: { previousImageUrl } }),
  reorder: (ids, previousIds) => write({ url: "/api/admin/covers/order", method: "PATCH", data: { ids, previousIds } })
};
