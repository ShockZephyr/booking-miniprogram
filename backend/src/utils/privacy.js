function maskPhone(phone = "") {
  const value = String(phone);
  if (value.length < 7) return value ? "***" : "";
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function stripSensitiveHeaders(headers = {}) {
  const clone = { ...headers };
  delete clone.authorization;
  delete clone.Authorization;
  delete clone.cookie;
  delete clone.Cookie;
  return clone;
}

function sanitizeErrorPayload(payload = {}) {
  return sanitizeLogPayload(payload);
}

function sanitizeLogPayload(value, seen = new WeakSet()) {
  if (typeof value === "string") return value
    .replace(/(?<![A-Za-z0-9])1[3-9]\d{9}(?![A-Za-z0-9])/g, maskPhone)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***")
    .replace(/((?:[a-z][a-z0-9+.-]*):\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1***@")
    .replace(/((?:["']?)(?:review[_-]?(?:login[_-]?)?code|access[_-]?token|refresh[_-]?token|session[_-]?key|app[_-]?secret|openid|password|token|jwt|secret)(?:["']?)\s*[:=]\s*["']?)[^\s&"',}\]]+/gi, "$1***");
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) {
    const result = sanitizeLogPayload({ ...value, name: value.name, message: value.message, stack: value.stack }, seen);
    seen.delete(value);
    return result;
  }
  const result = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = /^(review[_-]?(?:login[_-]?)?code|authorization|cookie|token|access[_-]?token|refresh[_-]?token|app[_-]?secret|jwt|password|openid|session[_-]?key|secret)$/i.test(key)
      ? "***" : sanitizeLogPayload(child, seen);
  }
  seen.delete(value);
  return result;
}

module.exports = {
  maskPhone,
  stripSensitiveHeaders,
  sanitizeErrorPayload,
  sanitizeLogPayload
};

