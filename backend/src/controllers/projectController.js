const service = require('../services/projectService');
const env = require('../config/env');
const context = req => ({user:req.user, requestId:req.requestId, ip:req.ip});
const send = (res,data) => res.json({success:true,data});
module.exports = {
  list: async (req,res) => send(res,{items:await service.list()}),
  recycleBin: async (req,res) => send(res,{items:await service.recycleBin(),retentionDays:env.recycleBinRetentionDays}),
  detail: async (req,res) => send(res,{item:await service.active(req.params.id)}),
  save: async (req,res) => send(res,{item:await service.save(req.params.id,req.body,context(req))}),
  reorder: async (req,res) => send(res,await service.reorder(req.body.ids,context(req))),
  remove: async (req,res) => send(res,await service.remove(req.params.id,context(req))),
  restore: async (req,res) => send(res,await service.restore(req.body.ids,context(req))),
  purge: async (req,res) => send(res,await service.purge(req.body.ids,context(req)))
};
