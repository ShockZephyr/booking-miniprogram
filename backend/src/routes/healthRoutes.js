const router = require("express").Router();
const asyncHandler = require("../middleware/asyncHandler");
const controller = require("../controllers/healthController");

router.get("/health", asyncHandler(controller.health));
router.get("/health/ready", asyncHandler(controller.ready));

module.exports = router;

