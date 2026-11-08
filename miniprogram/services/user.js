const request = require("../utils/request");
const cache = require("../utils/resourceCache");

function business(options = {}) {
  return cache.get(cache.KEYS.business, () => request({ url: "/api/meta/business", anonymous: true }), {
    force: options.force,
    ttl: 5 * 60 * 1000
  });
}

function serviceItems(options = {}) {
  return cache.get(cache.KEYS.serviceItems, () => request({ url: "/api/meta/service-items", anonymous: true }), {
    force: options.force,
    ttl: 30 * 1000
  });
}

module.exports = {
  business,
  serviceItems
};
