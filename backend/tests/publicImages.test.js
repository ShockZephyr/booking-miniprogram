const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const request = require("supertest");

// Use synthetic files and an empty environment file; never load a real database
// connection or the developer's upload directory. Exercise the actual app stack.
const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, "booking-public-images-"));
const environmentFile = path.join(directory, "test.env");
fs.writeFileSync(environmentFile, "");
Object.assign(process.env, {
  NODE_TEST_CONTEXT: "1", NODE_ENV: "test", DATABASE_URL: "",
  BOOKING_ENV_FILE: environmentFile, THERAPIST_UPLOAD_DIR: directory,
  LOG_LEVEL: "silent", JWT_SECRET: "synthetic-public-image-test-secret"
});
test.mock.method(require("../src/repositories/logRepository"), "createHttpRequest", async () => {});
const app = require("../src/app")();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=", "base64");
const imagePath = "/uploads/therapists/00000000-0000-4000-8000-000000000001.png";
fs.writeFileSync(path.join(directory, path.basename(imagePath)), png);
fs.writeFileSync(path.join(directory, ".hidden.png"), png);

test.after(() => {
  assert.equal(path.dirname(fs.realpathSync(directory)), temporaryRoot);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("public catalog images allow cross-origin embedding without weakening MIME protection", async () => {
  const response = await request(app).get(imagePath)
    .set("Referer", "https://servicewechat.com/synthetic-app/0/page-frame.html")
    .set("Sec-Fetch-Mode", "no-cors").set("Sec-Fetch-Dest", "image")
    .expect(200).expect("Content-Type", /image\/png/)
    .expect("Cross-Origin-Resource-Policy", "cross-origin")
    .expect("X-Content-Type-Options", "nosniff");
  assert.deepEqual(response.body, png);
  assert.match(response.headers["cache-control"], /max-age=2592000/);
});

test("image HEAD, range and cache revalidation keep the public resource policy", async () => {
  const head = await request(app).head(imagePath).expect(200)
    .expect("Cross-Origin-Resource-Policy", "cross-origin");
  await request(app).get(imagePath).set("If-None-Match", head.headers.etag).expect(304)
    .expect("Cross-Origin-Resource-Policy", "cross-origin");
  const range = await request(app).get(imagePath).set("Range", "bytes=0-7").expect(206)
    .expect("Cross-Origin-Resource-Policy", "cross-origin");
  assert.deepEqual(range.body, png.subarray(0, 8));
});

test("public image policy does not relax APIs or anonymous upload permissions", async () => {
  await request(app).get("/api/meta/business").expect(200)
    .expect("Cross-Origin-Resource-Policy", "same-origin");
  await request(app).post("/api/admin/therapist-images").expect(401)
    .expect("Cross-Origin-Resource-Policy", "same-origin");
  await request(app).get("/api/appointments/my").expect(401)
    .expect("Cross-Origin-Resource-Policy", "same-origin");
});

test("missing images and hidden files stay unavailable", async () => {
  for (const suffix of ["missing.png", ".hidden.png"]) {
    await request(app).get(`/uploads/therapists/${suffix}`).expect(404)
      .expect("Cross-Origin-Resource-Policy", "same-origin");
  }
});
