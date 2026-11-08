const router = require("express").Router();
const asyncHandler = require("../middleware/asyncHandler");
const { requireLogin } = require("../middleware/auth");
const { loginLimiter } = require("../middleware/rateLimit");
const controller = require("../controllers/authController");

router.post("/wechat-login", loginLimiter, asyncHandler(controller.login));
router.get("/review-options", controller.reviewOptions);
router.post("/review-login", loginLimiter, asyncHandler(controller.reviewLogin));
router.get("/me", requireLogin, asyncHandler(controller.me));
router.post("/logout", requireLogin, asyncHandler(controller.logout));

module.exports = router;

