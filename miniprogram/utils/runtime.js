const development = require("../config/development");

function canUseTestLogin() {
  try {
    const device = typeof wx.getDeviceInfo === "function" ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    return development.ENABLE_LOCAL_DEBUG === true && device.platform === "devtools"
      && wx.getAccountInfoSync().miniProgram.envVersion === "develop";
  } catch (error) { return false; }
}

module.exports = { canUseTestLogin };
