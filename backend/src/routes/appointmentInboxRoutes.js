const router = require('express').Router();
const { requireLogin } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const service = require('../services/appointmentInboxService');
router.use(requireLogin);
router.get('/', asyncHandler(async (req, res) => res.json({ success: true,
  data: await service.summary({ user: req.user }) })));
router.post('/read', asyncHandler(async (req, res) => res.json({ success: true,
  data: await service.acknowledge(req.body, { user: req.user }) })));
module.exports = router;
