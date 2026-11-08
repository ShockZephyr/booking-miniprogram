const router = require("express").Router();
const asyncHandler = require("../middleware/asyncHandler");
const { clientErrorLimiter } = require("../middleware/rateLimit");
const controller = require("../controllers/clientErrorController");

router.post("/", clientErrorLimiter, asyncHandler(controller.report));

module.exports = router;

