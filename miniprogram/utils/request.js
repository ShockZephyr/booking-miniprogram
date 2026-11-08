const env = require("../config/env");

function createRequestId() {
  return `mp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function currentToken() {
  try {
    if (typeof getApp === "function") {
      const app = getApp();
      if (app && app.globalData) return app.globalData.token || "";
    }
  } catch (error) {}
  return wx.getStorageSync("token");
}

function request(options) {
  const token = currentToken();
  const requestId = createRequestId();
  const header = Object.assign(
    {
      "content-type": "application/json",
      "x-request-id": requestId
    },
    options.header || {}
  );
  // Only identity-independent public DTOs opt out. All other requests, including
  // uploads and management mutations, keep the current session by default.
  if (token && !options.anonymous) header.authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${env.API_BASE_URL}${options.url}`,
      method: options.method || "GET",
      data: options.data || {},
      timeout: env.REQUEST_TIMEOUT,
      header,
      success(res) {
        const body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300 && body.success !== false) {
          resolve(body.data || body);
        } else {
          reject(
            Object.assign(
              {
                code: body.code || "REQUEST_FAILED",
                message: body.message || "请求失败",
                requestId: body.requestId || requestId,
                statusCode: res.statusCode
              },
              body
            )
          );
        }
      },
      fail(error) {
        reject({
          code: "NETWORK_ERROR",
          message: "网络连接失败",
          requestId,
          error
        });
      }
    });
  });
}

function parseUploadBody(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    return {};
  }
}

request.uploadFile = function uploadFile(options) {
  const token = currentToken();
  const requestId = createRequestId();
  const header = Object.assign({ "x-request-id": requestId }, options.header || {});
  if (token) header.authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${env.API_BASE_URL}${options.url}`,
      filePath: options.filePath,
      name: options.name || "file",
      formData: options.formData || {},
      timeout: options.timeout || env.UPLOAD_TIMEOUT,
      header,
      success(res) {
        const body = parseUploadBody(res.data);
        if (res.statusCode >= 200 && res.statusCode < 300 && body.success !== false) {
          resolve(body.data || body);
        } else {
          reject(Object.assign({
            code: body.code || "UPLOAD_FAILED",
            message: body.message || "上传失败",
            requestId: body.requestId || requestId,
            statusCode: res.statusCode
          }, body));
        }
      },
      fail(error) {
        reject({
          code: "UPLOAD_NETWORK_ERROR",
          message: "图片上传失败，请检查网络后重试",
          requestId,
          error
        });
      }
    });
  });
};

module.exports = request;
