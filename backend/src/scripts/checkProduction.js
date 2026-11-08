const fs = require("node:fs");
const path = require("node:path");
const env = require("../config/env");

const errors = [], warnings = [];
const release = process.argv.includes("--release");
function check(condition, message) { if (!condition) errors.push(message); }
check(env.isProduction, "NODE_ENV must be production.");
check(env.trustProxyHops === 1, "Set TRUST_PROXY_HOPS=1 behind the production Nginx container.");
check(!env.wechat.mockLogin && !env.wechat.mockAdmin, "Disable both WeChat mock switches.");
check(!!env.wechat.appId && !!env.wechat.appSecret, "Fill the real WeChat AppID and AppSecret on the server.");
check(env.jwtSecret.length >= 32 && !/dev-only|replace|change.me|your.secret|example/i.test(env.jwtSecret), "Generate a random JWT_SECRET of at least 32 characters.");
check(path.isAbsolute(env.imageUploadDirectory), "Set an absolute THERAPIST_UPLOAD_DIR outside the release.");
check(path.isAbsolute(env.logDirectory), "Set an absolute LOG_DIR outside the release.");
check(env.logRetentionDays >= 186, "Retain security logs for at least six months (186 days).");
check(!!env.business.privacyOperator && /^1[3-9]\d{9}$/.test(env.business.privacyContactPhone), "Fill privacy operator and contact phone.");
check(!!env.business.name && !!env.business.address && !/示例/.test(env.business.address), "Fill the real business name and address.");
check(path.isAbsolute(process.env.BACKUP_DIR || ""), "Set BACKUP_DIR to persistent storage.");
if (!process.env.BACKUP_MIRROR_DIR) warnings.push("No offsite backup mirror configured; arrange a verified separate copy before launch.");
const root = path.resolve(__dirname, "../../..");
const frontend = require(path.join(root, "miniprogram/config/env"));
const project = JSON.parse(fs.readFileSync(path.join(root, "project.config.json"), "utf8"));
if (release) {
  check(require(path.join(root, "miniprogram/config/development")).ENABLE_LOCAL_DEBUG === false, "Disable ENABLE_LOCAL_DEBUG before uploading the mini-program.");
  check(/^https:\/\//.test(frontend.API_BASE_URL) && !/example\.(?:com|invalid)|localhost|127\.0\.0\.1/.test(frontend.API_BASE_URL), "Set the real HTTPS API_BASE_URL.");
  check(project.setting.urlCheck === true, "Enable legal-domain checks in project.config.json.");
  check(project.appid === env.wechat.appId, "Frontend and backend AppID must match.");
  const legal = require(path.join(root, "miniprogram/config/legal"));
  check(![legal.copyright, legal.organizer, legal.icpNumber].some(value => /示例|XXXX|REPLACE_/i.test(value || "")),
    "Replace sample legal details; leave unissued registration fields empty.");
} else warnings.push("Domain configuration and device acceptance are still required before release.");
if (env.reviewLogin.enabled) warnings.push("Private-code review login is enabled; disable it and rotate its code after testing. Review admin actions affect this database.");
const missingAssets = new Set();
function scan(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory() && item.name !== "assets") scan(file);
    else if (item.isFile() && /\.(js|json|wxml)$/.test(item.name)) {
      for (const match of fs.readFileSync(file, "utf8").matchAll(/\/?assets\/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|webp|svg)/g)) {
        if (!fs.existsSync(path.join(root, "miniprogram", match[0].replace(/^\//, "")))) missingAssets.add(match[0]);
      }
    }
  }
}
scan(path.join(root, "miniprogram"));
check(!missingAssets.size, `Missing assets: ${Array.from(missingAssets).join(", ")}`);
console.log(JSON.stringify({ passed: !errors.length, errors, warnings, frontendVersion: frontend.APP_VERSION }, null, 2));
process.exitCode = errors.length ? 1 : 0;
