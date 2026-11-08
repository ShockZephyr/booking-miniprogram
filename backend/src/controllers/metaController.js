const env = require("../config/env");
const serviceItemRepository = require("../repositories/serviceItemRepository");

async function business(req, res) {
  res.json({ success: true, data: env.business });
}

async function serviceItems(req, res) {
  res.json({ success: true, data: { items: await serviceItemRepository.listActive() } });
}

module.exports = {
  business,
  serviceItems
};

