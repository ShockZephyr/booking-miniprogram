const router = require("express").Router();
const asyncHandler = require("../middleware/asyncHandler");
const controller = require("../controllers/scheduleController");

router.get("/", asyncHandler(controller.list));
router.get("/:therapistId", asyncHandler(controller.detail));
module.exports = router;
