const router = require("express").Router();
const asyncHandler = require("../middleware/asyncHandler");
const { requireLogin, requireAdmin } = require("../middleware/auth");
const { adminLimiter } = require("../middleware/rateLimit");
const scheduleController = require("../controllers/scheduleController");
const appointmentController = require("../controllers/appointmentController");
const whitelistController = require("../controllers/whitelistController");
const dashboardController = require("../controllers/dashboardController");
const therapistController = require("../controllers/therapistController");
const imageUpload = require("../middleware/imageUpload");

router.use(requireLogin, requireAdmin, adminLimiter);
const covers = require("../controllers/coverController");
router.post("/covers", asyncHandler(covers.save));
router.patch("/covers/order", asyncHandler(covers.reorder));
router.patch("/covers/:id", asyncHandler(covers.save));
router.delete("/covers/:id", asyncHandler(covers.remove));
const projects = require('../controllers/projectController');
router.post('/projects', asyncHandler(projects.save));
router.patch('/projects/order', asyncHandler(projects.reorder));
router.get('/projects/recycle-bin', asyncHandler(projects.recycleBin));
router.patch('/projects/restore', asyncHandler(projects.restore));
router.post('/projects/purge', asyncHandler(projects.purge));
router.patch('/projects/:id', asyncHandler(projects.save));
router.delete('/projects/:id', asyncHandler(projects.remove));
router.post("/therapist-images", imageUpload, asyncHandler(therapistController.upload));
router.post("/therapists", asyncHandler(therapistController.save));
router.get("/therapists/recycle-bin", asyncHandler(therapistController.recycleBin));
router.patch("/therapists/restore", asyncHandler(therapistController.restore));
router.post("/therapists/purge", asyncHandler(therapistController.purge));
router.get("/therapists/:id", asyncHandler(therapistController.adminDetail));
router.patch("/therapists/:id", asyncHandler(therapistController.save));
router.delete("/therapists/:id", asyncHandler(therapistController.remove));

router.get("/schedules/settings", asyncHandler(scheduleController.getSettings));
router.patch("/schedules/settings", asyncHandler(scheduleController.setSettings));
router.get("/schedules/weekly/:therapistId", asyncHandler(scheduleController.getWeekly));
router.put("/schedules/weekly", asyncHandler(scheduleController.putWeekly));
router.put("/schedules/weekly/:therapistId", asyncHandler(scheduleController.putWeeklyDays));
router.patch("/schedules/day/:therapistId", asyncHandler(scheduleController.patchDay));

router.get("/appointments", asyncHandler(appointmentController.adminList));
const batchCheckIn = require("../controllers/batchCheckInController");
router.post("/appointments/check-in-preview", asyncHandler(batchCheckIn.adminPreview));
router.post("/appointments/check-in-batch", asyncHandler(batchCheckIn.adminSubmit));
router.get("/appointments/:id", asyncHandler(appointmentController.adminGet));
router.patch("/appointments/:id/cancel", asyncHandler(appointmentController.adminCancel));
router.patch("/appointments/:id/check-in", asyncHandler(appointmentController.adminCheckIn));
router.patch("/appointments/:id/uncheck-in", asyncHandler(appointmentController.adminUncheckIn));

router.get("/whitelist", asyncHandler(whitelistController.list));
router.post("/whitelist", asyncHandler(whitelistController.add));
router.patch("/whitelist/:id", asyncHandler(whitelistController.update));
router.delete("/whitelist/:id", asyncHandler(whitelistController.remove));
router.post("/whitelist/batch-delete", asyncHandler(whitelistController.batchRemove));

router.get("/dashboard/summary", asyncHandler(dashboardController.summary));
router.get("/logs", asyncHandler(dashboardController.logs));

module.exports = router;
