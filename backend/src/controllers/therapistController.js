const service = require("../services/therapistService");
const env = require("../config/env");
const images = require("../services/therapistImageService");
const { AppError } = require("../utils/errors");
const context = (req) => ({ user: req.user, requestId: req.requestId, ip: req.ip });
module.exports = {
  list: async (req, res) => res.json({ success: true, data: { therapists: await service.list() } }),
  recycleBin: async (req, res) => res.json({ success: true, data: { therapists: await service.recycleBin(), retentionDays: env.recycleBinRetentionDays } }),
  detail: async (req, res) => res.json({ success: true, data: { therapist: await service.detail(req.params.id) } }),
  adminDetail: async (req, res) => res.json({ success: true, data: { therapist: await service.adminDetail(req.params.id) } }),
  save: async (req, res) => res.json({ success: true, data: { therapist: await service.save(req.params.id, req.body, context(req)) } }),
  remove: async (req, res) => res.json({ success: true, data: await service.remove(req.params.id, context(req)) }),
  restore: async (req, res) => res.json({ success: true, data: await service.restore(req.body.ids, context(req)) }),
  purge: async (req, res) => res.json({ success: true, data: await service.purge(req.body.ids, context(req)) }),
  upload: async (req, res) => {
    if (req.file && req.file.buffer) {
      return res.json({ success: true, data: await images.uploadBuffer(req.file.buffer) });
    }
    if (req.body && req.body.base64) {
      return res.json({ success: true, data: await images.upload(req.body.base64) });
    }
    throw new AppError("IMAGE_REQUIRED", "请选择要上传的图片", 400);
  }
};
