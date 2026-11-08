const entries = Object.create(null);

const KEYS = Object.freeze({
  business: "business",
  serviceItems: "service-items",
  therapists: "therapists",
  projects: "projects"
});

function get(key, loader, options = {}) {
  const force = !!options.force;
  const ttl = Number.isFinite(options.ttl) ? Math.max(0, options.ttl) : 30000;
  const current = entries[key];
  const now = Date.now();

  if (!force && current) {
    if (current.promise) return current.promise;
    if (current.hasValue && current.expiresAt > now) return Promise.resolve(current.value);
  }

  const entry = { promise: null, hasValue: false, value: undefined, expiresAt: 0 };
  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      if (entries[key] === entry) {
        entry.promise = null;
        entry.hasValue = true;
        entry.value = value;
        entry.expiresAt = Date.now() + ttl;
      }
      return value;
    })
    .catch((error) => {
      if (entries[key] === entry) delete entries[key];
      throw error;
    });

  entry.promise = promise;
  entries[key] = entry;
  return promise;
}

function invalidate(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  list.filter(Boolean).forEach((key) => delete entries[key]);
}

module.exports = { KEYS, get, invalidate };
