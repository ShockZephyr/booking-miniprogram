const { AppError } = require("./errors");
const { assertDateString } = require("./date");
const { validTimestamp } = require("./cursor");
const SOURCES = ["business", "audit", "http", "client", "alert"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => new AppError("INVALID_LOG_FILTER", "日志筛选条件无效", 400);

function parseLogQuery(input = {}) {
  const result = {};
  for (const key of ["source", "requestId", "userId", "effectiveRole", "action", "from", "to", "cursor", "limit"]) {
    const value = input[key];
    if (value == null || value === "") continue;
    if (typeof value !== "string" || value.length > (key === "cursor" ? 1024 : 128)) throw invalid();
    result[key] = value;
  }
  if (result.source && result.source !== "all" && !SOURCES.includes(result.source)) throw invalid();
  if (result.userId && !UUID.test(result.userId)) throw invalid();
  if (result.effectiveRole && !["user", "member", "admin", "therapist", "system", "guest"].includes(result.effectiveRole)) throw invalid();
  if (result.limit && !/^\d+$/.test(result.limit)) throw invalid();
  result.limit = Number(result.limit || 200);
  if (result.limit < 1 || result.limit > 200) throw invalid();
  for (const key of ["from", "to"]) {
    if (!result[key]) continue;
    if (assertDateString(result[key])) {
      result[key] += "T00:00:00+08:00";
      if (key === "to") {
        result.to = new Date(Date.parse(result.to) + 86400000).toISOString();
        result.toExclusive = true;
      }
    } else {
      // Date-time values without an offset are interpreted in Shanghai time.
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(result[key])) result[key] += "+08:00";
      if (!validTimestamp(result[key])) throw invalid();
    }
  }
  if (result.from && result.to && Date.parse(result.from) > Date.parse(result.to)) throw invalid();
  if (result.cursor) {
    try {
      if (!/^[\w-]+$/.test(result.cursor)) throw invalid();
      const parts = JSON.parse(Buffer.from(result.cursor, "base64url").toString());
      if (!Array.isArray(parts) || parts.length !== 3 || parts.some(value => typeof value !== "string") ||
          !validTimestamp(parts[0]) || !SOURCES.includes(parts[1]) || !UUID.test(parts[2])) throw invalid();
      result.cursor = parts;
    } catch (_) { throw invalid(); }
  }
  return result;
}

module.exports = { parseLogQuery, SOURCES };
