const covers = require("../services/coverService");
const context = req => ({ user: req.user, requestId: req.requestId, ip: req.ip });
const send = (res, data) => res.json({ success: true, data });

module.exports = {
  list: async (_req, res) => send(res, { items: await covers.list() }),
  save: async (req, res) => send(res, await covers.save(req.params.id, req.body, context(req))),
  remove: async (req, res) => send(res, await covers.remove(req.params.id, req.body?.previousImageUrl, context(req))),
  reorder: async (req, res) => send(res, await covers.reorder(req.body, context(req)))
};
