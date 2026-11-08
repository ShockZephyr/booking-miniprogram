const { AppError } = require("./errors");

function normalizePhone(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function requirePhone(value) {
  const phone = normalizePhone(value);
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    throw new AppError("INVALID_PHONE", "请输入 11 位有效手机号", 400);
  }
  return phone;
}

function maskPhone(value) {
  return normalizePhone(value).replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2");
}

module.exports = { normalizePhone, requirePhone, maskPhone };
