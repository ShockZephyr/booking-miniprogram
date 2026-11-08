const { AppError } = require("./errors");
const { assertDateString } = require("./date");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAMP = /^(\d{4}-\d{2}-\d{2})[ T]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?([0-5]\d))?)$/;

function validTimestamp(value) {
  const match = STAMP.exec(value);
  // Date.parse normalizes February 30; validate the calendar independently.
  // PostgreSQL accepts offsets smaller than 16 hours, including its own +HH output.
  return !!match && assertDateString(match[1]) && (!match[5] || Number(match[5]) < 16);
}

function encodeCursor(kind, values, scope = "") {
  return Buffer.from(JSON.stringify([scope ? `${kind}:${scope}` : kind, ...values])).toString("base64url");
}

function decodeCursor(value, kind, scope = "") {
  if (!value) return null;
  try {
    if (typeof value !== "string" || value.length > 1024 || !/^[\w-]+$/.test(value)) throw Error();
    const [type, ...parts] = JSON.parse(Buffer.from(value, "base64url").toString());
    const length = kind === "appointments" ? 4 : 2;
    if (type !== (scope ? `${kind}:${scope}` : kind) || parts.length !== length || parts.some((part) => typeof part !== "string")) throw Error();
    if (!UUID.test(parts.at(-1)) || !validTimestamp(parts.at(-2))) throw Error();
    if (length === 4 && (!assertDateString(parts[0]) || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(parts[1]))) throw Error();
    return parts;
  } catch (_) {
    throw new AppError("INVALID_CURSOR", "分页位置无效，请刷新列表", 400);
  }
}

module.exports = { encodeCursor, decodeCursor, validTimestamp };
