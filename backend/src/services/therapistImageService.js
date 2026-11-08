const fs = require("fs/promises");
const fsConstants = require("fs").constants;
const path = require("path");
const { randomUUID } = require("crypto");
const { AppError } = require("../utils/errors");
const env = require("../config/env");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const directory = path.resolve(env.imageUploadDirectory || path.join(__dirname, "../../uploads/therapists"));

function inspect(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new AppError("INVALID_IMAGE", "请选择有效图片", 400);
  }
  if (buffer.length > MAX_IMAGE_BYTES) throw new AppError("IMAGE_TOO_LARGE", "图片不能超过 5MB", 400);
  let extension;
  if (buffer.length > 12 && buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) extension = "jpg";
  if (buffer.length > 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) extension = "png";
  if (buffer.length > 20 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") extension = "webp";
  if (!extension) throw new AppError("INVALID_IMAGE", "仅支持 JPG、PNG、WebP 图片", 400);
  return { buffer, extension };
}

function decode(base64) {
  if (typeof base64 !== "string" || !base64.length || base64.length > 7 * 1024 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new AppError("INVALID_IMAGE", "图片无效或超过 5MB", 400);
  }
  return inspect(Buffer.from(base64, "base64"));
}

async function ensureReady() {
  await fs.mkdir(directory, { recursive: true });
  await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK);
  return directory;
}

async function persist({ buffer, extension }) {
  await ensureReady();
  const name = `${randomUUID()}.${extension}`;
  await fs.writeFile(path.join(directory, name), buffer, { flag: "wx" });
  return { imageUrl: `/uploads/therapists/${name}` };
}

async function upload(base64) {
  return persist(decode(base64));
}

async function uploadBuffer(buffer) {
  return persist(inspect(buffer));
}

async function assertExists(imageUrl, missingCode = "INVALID_IMAGE") {
  try { await fs.access(path.join(directory, path.basename(imageUrl))); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new AppError(missingCode, "图片不存在，请重新上传", 400);
  }
}
module.exports = { MAX_IMAGE_BYTES, directory, upload, uploadBuffer, decode, inspect, ensureReady, assertExists };
