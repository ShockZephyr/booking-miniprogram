const request = require("../utils/request");
const env = require("../config/env");
const cache = require("../utils/resourceCache");
function imageUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${String(env.API_BASE_URL || "").replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}
function decorate(item) { return Object.assign({}, item, { imageSrc: imageUrl(item.imageUrl) }); }
module.exports = {
  imageUrl,
  list: (options = {}) => cache.get(cache.KEYS.therapists,
    () => request({ url: "/api/therapists", anonymous: true }).then((data) => ({ therapists: data.therapists.map(decorate) })),
    { force: options.force, ttl: 30 * 1000 }),
  detail: (id) => request({ url: `/api/therapists/${id}`, anonymous: true }).then((data) => ({ therapist: decorate(data.therapist) })),
  adminDetail: (id) => request({ url: `/api/admin/therapists/${id}` }).then((data) => ({ therapist: decorate(data.therapist) })),
  recycleBin: () => request({ url: "/api/admin/therapists/recycle-bin" })
    .then((data) => ({ therapists: data.therapists.map(decorate), retentionDays: data.retentionDays })),
  save: (id, data) => request({ url: `/api/admin/therapists${id ? `/${id}` : ""}`, method: id ? "PATCH" : "POST", data })
    .then((result) => { cache.invalidate(cache.KEYS.therapists); return { ...result, therapist: decorate(result.therapist) }; }),
  remove: (id) => request({ url: `/api/admin/therapists/${id}`, method: "DELETE" })
    .then((result) => { cache.invalidate(cache.KEYS.therapists); return result; }),
  restore: (ids) => request({ url: "/api/admin/therapists/restore", method: "PATCH", data: { ids } })
    .then((result) => { cache.invalidate(cache.KEYS.therapists); return result; }),
  purge: (ids) => request({ url: "/api/admin/therapists/purge", method: "POST", data: { ids } })
    .then((result) => { cache.invalidate(cache.KEYS.therapists); return result; }),
  upload: (filePath) => request.uploadFile({
    url: "/api/admin/therapist-images",
    filePath,
    name: "image"
  })
};
