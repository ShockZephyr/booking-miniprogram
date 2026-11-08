const dotenv = require("dotenv");
const path = require("path");
const cron = require("node-cron");

const loaded = dotenv.config(process.env.BOOKING_ENV_FILE ? { path: process.env.BOOKING_ENV_FILE } : {});
if (process.env.BOOKING_ENV_FILE && loaded.error) throw new Error("BOOKING_ENV_FILE could not be read.");

const isProduction = process.env.NODE_ENV === "production";
// Public examples must never become usable credentials by enabling a switch.
const isPlaceholderCredential = value => /^(?:REPLACE_|CHANGE_|YOUR_)|^wx0{16}$/i.test(value || "");

function parseTrustProxyHops(value) {
  if (value === undefined || value === "") return 0;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 5.");
  }
  return hops;
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  isProduction,
  port: Number(process.env.PORT || 3000),
  trustProxyHops: parseTrustProxyHops(process.env.TRUST_PROXY_HOPS),
  databaseUrl: process.env.DATABASE_URL || "",
  jwtSecret: process.env.JWT_SECRET || "dev-only-secret-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  timezone: "Asia/Shanghai",

  reviewLogin: {
    enabled: process.env.REVIEW_LOGIN_ENABLED === "true",
    code: process.env.REVIEW_LOGIN_CODE || "",
    expiresAt: process.env.REVIEW_LOGIN_EXPIRES_AT || ""
  },

  wechat: {
    appId: process.env.WECHAT_APP_ID || "",
    appSecret: process.env.WECHAT_APP_SECRET || "",
    mockLogin: process.env.WECHAT_MOCK_LOGIN !== "false",
    mockAdmin: process.env.WECHAT_MOCK_ADMIN === "true",
    requestTimeoutMs: Number(process.env.WECHAT_REQUEST_TIMEOUT_MS || 10000)
  },

  business: {
    name: process.env.BUSINESS_NAME || "示例预约馆",
    phone: process.env.BUSINESS_PHONE || "00000000000",
    address: process.env.BUSINESS_ADDRESS || "上海市黄浦区人民广场（示例地址）",
    latitude: Number(process.env.BUSINESS_LATITUDE || 31.228827),
    longitude: Number(process.env.BUSINESS_LONGITUDE || 121.475213),
    providerName: process.env.SERVICE_PROVIDER_NAME || "芳疗师",
    privacyOperator: process.env.PRIVACY_OPERATOR || "示例预约服务工作室（虚构主体）",
    privacyContactPhone: process.env.PRIVACY_CONTACT_PHONE || process.env.BUSINESS_PHONE || "00000000000"
  },

  noShowCron: process.env.NO_SHOW_CRON || "* * * * *",
  imageUploadDirectory: process.env.THERAPIST_UPLOAD_DIR || "",
  imageOrphanRetentionHours: Number(process.env.IMAGE_ORPHAN_RETENTION_HOURS || 24),
  imageCleanupCron: process.env.IMAGE_CLEANUP_CRON || "17 3 * * *",
  recycleBinRetentionDays: Number(process.env.RECYCLE_BIN_RETENTION_DAYS || 30),
  recycleBinCleanupCron: process.env.RECYCLE_BIN_CLEANUP_CRON || "7 3 * * *",
  logLevel: process.env.LOG_LEVEL || "info",
  logRetentionDays: Number(process.env.LOG_RETENTION_DAYS || (isProduction ? 186 : 21)),
  logDirectory: process.env.LOG_DIR || "",
  logMaxBytes: Number(process.env.LOG_MAX_BYTES || 10485760),
  adminDashboardEnabled: process.env.ADMIN_DASHBOARD_ENABLED !== "false",
  metricsEnabled: process.env.METRICS_ENABLED !== "false",
  alert5xxThreshold5m: Number(process.env.ALERT_5XX_THRESHOLD_5M || 10)
};

if (env.isProduction && (env.jwtSecret.length < 32 || /dev-only|replace|change.me|your.secret|example/i.test(env.jwtSecret))) {
  throw new Error("JWT_SECRET must be a random secret of at least 32 characters in production.");
}

if (env.isProduction && (env.wechat.mockLogin || env.wechat.mockAdmin)) {
  throw new Error("WECHAT_MOCK_LOGIN and WECHAT_MOCK_ADMIN must both be false in production.");
}

if (env.reviewLogin.enabled && (isPlaceholderCredential(env.reviewLogin.code) || !/^[A-Za-z0-9_-]{32,128}$/.test(env.reviewLogin.code)
  || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(env.reviewLogin.expiresAt)
  || !Number.isFinite(Date.parse(env.reviewLogin.expiresAt)))) {
  throw new Error("Review login requires a random REVIEW_LOGIN_CODE (32-128 URL-safe characters) and REVIEW_LOGIN_EXPIRES_AT with an explicit timezone.");
}

if (env.isProduction && !env.imageUploadDirectory) {
  throw new Error("THERAPIST_UPLOAD_DIR must point to persistent storage in production.");
}

if (env.isProduction) {
  const releaseRoot = path.resolve(__dirname, "../../..");
  for (const [label, directory] of [["THERAPIST_UPLOAD_DIR", env.imageUploadDirectory], ["LOG_DIR", env.logDirectory]]) {
    const relative = path.relative(releaseRoot, directory || releaseRoot);
    if (!path.isAbsolute(directory) || !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error(`${label} must be an absolute persistent directory outside the release directory.`);
    }
  }
}

if (env.isProduction && (!env.wechat.appId || !env.wechat.appSecret
  || isPlaceholderCredential(env.wechat.appId) || isPlaceholderCredential(env.wechat.appSecret))) {
  throw new Error("WECHAT_APP_ID and WECHAT_APP_SECRET must be configured with real values in production.");
}

if (!Number.isFinite(env.imageOrphanRetentionHours) || env.imageOrphanRetentionHours < 1) {
  throw new Error("IMAGE_ORPHAN_RETENTION_HOURS must be at least 1.");
}

if (!Number.isInteger(env.recycleBinRetentionDays) || env.recycleBinRetentionDays < 1) {
  throw new Error("RECYCLE_BIN_RETENTION_DAYS must be a positive integer.");
}

if (!Number.isInteger(env.wechat.requestTimeoutMs) || env.wechat.requestTimeoutMs < 100 || env.wechat.requestTimeoutMs > 10000) {
  throw new Error("WECHAT_REQUEST_TIMEOUT_MS must be between 100 and 10000.");
}
if (!Number.isInteger(env.logRetentionDays) || env.logRetentionDays < 1 || !Number.isInteger(env.logMaxBytes) || env.logMaxBytes < 1024) {
  throw new Error("LOG_RETENTION_DAYS and LOG_MAX_BYTES must be valid positive limits.");
}
if (env.isProduction && env.logRetentionDays < 186) {
  throw new Error("LOG_RETENTION_DAYS must be at least 186 in production to retain security logs for six months.");
}
for (const name of ["noShowCron", "imageCleanupCron", "recycleBinCleanupCron"]) {
  if (!cron.validate(env[name])) throw new Error(`${name} is invalid.`);
}

if (!env.databaseUrl && !process.env.NODE_TEST_CONTEXT) {
  throw new Error("DATABASE_URL is required.");
}

module.exports = env;
