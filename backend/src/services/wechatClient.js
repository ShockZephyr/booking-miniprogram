const env = require("../config/env");
const { AppError } = require("../utils/errors");

const TOKEN_URL = "https://api.weixin.qq.com/cgi-bin/token";

function unavailable() {
  return Object.assign(new AppError("WECHAT_UNAVAILABLE", "登录服务暂不可用，请稍后重试", 503), { retryable: true });
}

function createWechatClient(configuration = env) {
  let tokenCache = { value: "", expiresAt: 0 };
  let pendingToken = null;

  function configured() { return !!(configuration.wechat.appId && configuration.wechat.appSecret); }

  async function requestJson(url, options = {}, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") throw unavailable();
    const { deadline, timeout, ...requestOptions } = options;
    const timeoutMs = Math.min(timeout || configuration.wechat.requestTimeoutMs || 10000, deadline ? deadline - Date.now() : Infinity);
    if (timeoutMs <= 0) throw unavailable();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...requestOptions, signal: controller.signal });
      if (!response.ok) {
        const error = unavailable();
        error.retryable = response.status >= 500 || response.status === 429;
        throw error;
      }
      const result = await response.json();
      if (!result || typeof result !== "object" || Array.isArray(result)) throw unavailable();
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Fetch errors may contain a URL carrying AppSecret or access_token.
      throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  async function getAccessToken(options = {}) {
    if (!configured()) throw new AppError("WECHAT_NOT_CONFIGURED", "登录服务暂不可用，请联系门店", 503);
    if (!options.force && tokenCache.value && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.value;
    if (!pendingToken) {
      const query = new URLSearchParams({ grant_type: "client_credential", appid: configuration.wechat.appId, secret: configuration.wechat.appSecret });
      const request = requestJson(`${TOKEN_URL}?${query}`, { deadline: options.deadline }, options.fetch).then((body) => {
        if (!body.access_token || typeof body.access_token !== "string") throw unavailable();
        tokenCache = { value: body.access_token, expiresAt: Date.now() + Math.max(60, Number(body.expires_in) || 7200) * 1000 };
        return tokenCache.value;
      });
      pendingToken = request;
      request.finally(() => { if (pendingToken === request) pendingToken = null; }).catch(() => {});
    }
    if (!options.deadline) return pendingToken;
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw unavailable();
    let timer;
    try {
      return await Promise.race([pendingToken, new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), remaining); })]);
    } finally { clearTimeout(timer); }
  }

  function resetTokenCache() { tokenCache = { value: "", expiresAt: 0 }; }
  return { configured, requestJson, getAccessToken, resetTokenCache };
}

module.exports = { createWechatClient, ...createWechatClient() };
