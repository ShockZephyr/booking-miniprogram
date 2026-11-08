const router = require("express").Router();
const asyncHandler = require("../middleware/asyncHandler");
const controller = require("../controllers/metaController");
const covers = require("../controllers/coverController");

router.get("/business", asyncHandler(controller.business));
router.get("/covers", asyncHandler(covers.list));
router.get("/service-items", asyncHandler(controller.serviceItems));

module.exports = router;

