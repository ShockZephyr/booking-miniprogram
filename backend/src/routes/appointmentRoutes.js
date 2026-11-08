const router = require("express").Router();
const asyncHandler = require("../middleware/asyncHandler");
const { requireLogin, requireMember, requireCustomer } = require("../middleware/auth");
const { bookingLimiter } = require("../middleware/rateLimit");
const controller = require("../controllers/appointmentController");

router.get("/my", requireLogin, asyncHandler(controller.my));
router.get("/filter-options", requireLogin, asyncHandler(controller.filterOptions));
router.get("/calendar-status", requireLogin, asyncHandler(controller.calendarStatus));
router.get("/:id", requireCustomer, asyncHandler(controller.ownGet));
router.post("/", requireMember, bookingLimiter, asyncHandler(controller.create));
router.patch("/:id/cancel", requireCustomer, bookingLimiter, asyncHandler(controller.cancel));
router.patch("/:id/check-in", requireCustomer, bookingLimiter, asyncHandler(controller.checkIn));
router.patch("/:id/modify", requireMember, bookingLimiter, asyncHandler(controller.modify));

module.exports = router;
