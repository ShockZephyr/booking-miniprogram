const express = require("express");
const multer = require("multer");
const { AppError } = require("../utils/errors");
const { MAX_IMAGE_BYTES } = require("../services/therapistImageService");

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1,
    fields: 0,
    parts: 1
  }
}).single("image");

const legacyJson = express.json({ limit: "8mb" });

function mapError(error) {
  if (!error) return null;
  if (error.code === "LIMIT_FILE_SIZE" || error.type === "entity.too.large") {
    return new AppError("IMAGE_TOO_LARGE", "图片不能超过 5MB", 400);
  }
  if (error.name === "MulterError") {
    return new AppError("INVALID_IMAGE_UPLOAD", "一次只能上传一张图片", 400);
  }
  return error;
}

function imageUpload(req, res, next) {
  const parser = req.is("multipart/form-data") ? multipart : legacyJson;
  parser(req, res, (error) => next(mapError(error)));
}

module.exports = imageUpload;
