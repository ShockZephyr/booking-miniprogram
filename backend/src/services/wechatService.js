const env = require("../config/env");
const client = require("./wechatClient");
const { AppError } = require("../utils/errors");

async function code2Session(loginCode, options = {}) {
  if (env.wechat.mockLogin) {
    return {
      openid: `mock_openid_${loginCode || "dev"}`,
      session_key: "mock_session_key"
    };
  }
  if (!env.wechat.appId || !env.wechat.appSecret) {
    throw new AppError("WECHAT_NOT_CONFIGURED", "登录服务暂不可用，请联系门店", 503);
  }
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(env.wechat.appId)}&secret=${encodeURIComponent(env.wechat.appSecret)}&js_code=${encodeURIComponent(loginCode)}&grant_type=authorization_code`;
  const result = await client.requestJson(url, { deadline: options.deadline });
  if (result.errcode || !result.openid) {
    throw new AppError("WECHAT_LOGIN_FAILED", "登录失败，请重试", 401);
  }
  return result;
}

async function getPhoneNumber(phoneCode, fallbackPhone, options = {}) {
  if (env.wechat.mockLogin) {
    return fallbackPhone || "13800000000";
  }
  if (!phoneCode) {
    throw new AppError("PHONE_CODE_REQUIRED", "手机号授权凭证缺失，请重试", 400);
  }
  const send = async (force) => {
    const accessToken = await client.getAccessToken({ force, deadline: options.deadline });
    return client.requestJson(
      `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: phoneCode }), deadline: options.deadline }
    );
  };
  let result = await send(false);
  if ([40001, 40014, 42001].includes(Number(result.errcode))) result = await send(true);
  if (result.errcode || !result.phone_info || !result.phone_info.phoneNumber) {
    throw new AppError("WECHAT_PHONE_FAILED", "手机号获取失败，请重试", 400);
  }
  return result.phone_info && result.phone_info.phoneNumber;
}

module.exports = {
  code2Session,
  getAccessToken: client.getAccessToken,
  getPhoneNumber
};
