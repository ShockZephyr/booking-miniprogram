const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const request = require("supertest");

process.env.NODE_TEST_CONTEXT = "1";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "booking-multipart-test-"));
process.env.THERAPIST_UPLOAD_DIR = directory;

const imageUpload = require("../src/middleware/imageUpload");
const controller = require("../src/controllers/therapistController");
const errorHandler = require("../src/middleware/errorHandler");
const asyncHandler = require("../src/middleware/asyncHandler");

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=", "base64");

function app() {
  const instance = express();
  instance.post("/upload", imageUpload, asyncHandler(controller.upload));
  instance.use(errorHandler);
  return instance;
}

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("multipart image upload persists a validated image", async () => {
  const response = await request(app())
    .post("/upload")
    .attach("image", png, { filename: "portrait.png", contentType: "image/png" })
    .expect(200);
  assert.match(response.body.data.imageUrl, /^\/uploads\/therapists\/[0-9a-f-]+\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(directory, path.basename(response.body.data.imageUrl))), png);
});

test("multipart image upload rejects missing and oversized files", async () => {
  const missing = await request(app()).post("/upload").expect(400);
  assert.equal(missing.body.code, "IMAGE_REQUIRED");
  const tooLarge = await request(app())
    .post("/upload")
    .attach("image", Buffer.alloc(5 * 1024 * 1024 + 1), { filename: "large.png", contentType: "image/png" })
    .expect(400);
  assert.equal(tooLarge.body.code, "IMAGE_TOO_LARGE");
});
