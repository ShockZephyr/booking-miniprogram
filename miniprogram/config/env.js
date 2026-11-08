const { canUseTestLogin } = require("../utils/runtime");
const development = require("./development");

module.exports = {
  API_BASE_URL: canUseTestLogin() ? development.LOCAL_API_BASE_URL : "https://api.example.invalid",
  APP_VERSION: "1.0.0",
  REQUEST_TIMEOUT: 15000,
  UPLOAD_TIMEOUT: 60000
};

