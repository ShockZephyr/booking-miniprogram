const router = require("express").Router();
const asyncHandler = require("../middleware/asyncHandler");
const { requireLogin, requireTherapist } = require("../middleware/auth");
const controller = require("../controllers/therapistPortalController");

router.use(requireLogin, requireTherapist);
router.get("/appointments", asyncHandler(controller.appointments));
router.get("/appointments/:id", asyncHandler(controller.appointment));
router.patch("/appointments/:id/check-in", asyncHandler(controller.checkIn));

module.exports = router;
