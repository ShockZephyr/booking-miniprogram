const whitelistService = require("../services/whitelistService");

async function list(req, res) {
  const data = await whitelistService.list(req.query, true);
  res.json({ success: true, data });
}

async function add(req, res) {
  const item = await whitelistService.add(req.body, {
    user: req.user,
    requestId: req.requestId,
    ip: req.ip
  });
  res.json({ success: true, data: { item } });
}

async function update(req, res) {
  const item = await whitelistService.update(req.params.id, req.body, {
    user: req.user,
    requestId: req.requestId,
    ip: req.ip
  });
  res.json({ success: true, data: { item } });
}

async function remove(req, res) {
  const item = await whitelistService.remove(req.params.id, {
    user: req.user,
    requestId: req.requestId,
    ip: req.ip
  });
  res.json({ success: true, data: { item } });
}

async function batchRemove(req, res) {
  const items = await whitelistService.batchRemove(req.body.ids, {
    user: req.user,
    requestId: req.requestId,
    ip: req.ip
  });
  res.json({ success: true, data: { items } });
}

module.exports = {
  list,
  add,
  update,
  remove,
  batchRemove
};

