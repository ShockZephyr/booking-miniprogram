const router = require("express").Router();
const asyncHandler = require("../middleware/asyncHandler");
const controller = require("../controllers/therapistController");
router.get("/", asyncHandler(controller.list));
router.get("/:id", asyncHandler(controller.detail));
module.exports = router;
