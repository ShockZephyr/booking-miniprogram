const whitelistRepository = require("../repositories/whitelistRepository");

async function isActiveMember(phone, client) {
  return whitelistRepository.isActive(phone, client);
}

async function getEffectiveRole(user, client) {
  if (!user) return "guest";
  if (user.role === "admin") return "admin";
  return (await isActiveMember(user.phone, client)) ? "member" : "user";
}

module.exports = {
  isActiveMember,
  getEffectiveRole
};

