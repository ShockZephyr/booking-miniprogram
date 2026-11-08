const test = require("node:test");
const assert = require("node:assert/strict");
const { setup } = require("./support/scheduleUI");

async function retryFromEditor(origin, admin, token, imageUrl) {
  const h = setup();
  h.app.globalData.user = { id: admin.id, role: "admin" };
  h.app.globalData.token = token;
  h.deps.env = { API_BASE_URL: origin };
  h.deps.therapist = { imageUrl: path => origin + path, upload: async () => ({ imageUrl }) };
  let lostResponse = true;
  h.wx.request = async options => {
    try {
      const response = await fetch(options.url, { method: options.method, headers: options.header,
        body: options.method === "GET" ? undefined : JSON.stringify(options.data) });
      const data = await response.json();
      if (lostResponse && options.method === "POST" && response.ok) {
        lostResponse = false;
        options.success({ statusCode: 504, data: {} });
      } else options.success({ statusCode: response.status, data });
    } catch (error) { options.fail(error); }
  };
  h.wx.chooseMedia = opts => { opts.success({ tempFiles: [{ tempFilePath: "test.png", size: 100 }] }); opts.complete(); };
  const page = h.page("pages/admin/cover-edit");
  page.onLoad({}); await page.onShow();
  const event = () => ({ currentTarget: { dataset: { version: page.data.version } } });
  page.choose(event()); await page.save(event());
  assert.equal(page.data.uncertain, true);
  page.onHide(); await page.onShow(); await page.save(event());
  assert.equal(page.data.uncertain, false);
  assert.equal(h.calls.filter(call => call[0] === "back").length, 1);
  return page.data.id;
}

test("home covers: real upload, public order, concurrent capacity, edit, delete and image retention",
  { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
    const { withDatabase, cleanup } = require("./audit-2026-10-20/isolated");
    try {
      await withDatabase(async ({ api, admin, customer, origin, pool, tokenFor, therapistA }) => {
        const { cleanupOrphans } = require("../src/services/imageCleanupService");
        const images = require("../src/services/therapistImageService");
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2GQAAAABJRU5ErkJggg==", "base64");
        const list = async () => {
          const res = await fetch(origin + "/api/meta/covers");
          assert.equal(res.status, 200);
          return (await res.json()).data.items;
        };
        const write = (method, path, data, who = admin) => api("/api/admin/covers" + path, who, method, data);
        assert.deepEqual(await list(), []);
        const form = new FormData(); form.append("image", new Blob([png], { type: "image/png" }), "test.png");
        const upload = await fetch(origin + "/api/admin/therapist-images", { method: "POST",
          headers: { authorization: "Bearer " + await tokenFor(admin) }, body: form });
        assert.equal(upload.status, 200);
        const { imageUrl } = (await upload.json()).data;
        assert.equal((await write("POST", "", { imageUrl }, customer)).status, 403);
        assert.equal((await write("POST", "", { imageUrl: "/uploads/therapists/../bad.png" })).status, 400);
        const urls = [imageUrl];
        for (let i = 0; i < 5; i++) urls.push((await images.uploadBuffer(png)).imageUrl);
        const inputFor = url => ({ imageUrl: url, creationKey: "audit-create-" + urls.indexOf(url) });
        const creates = await Promise.all(urls.map(url => write("POST", "", inputFor(url))));
        assert.deepEqual(creates.map(r => r.status).sort(), [200, 200, 200, 200, 200, 409]);
        const all = await list();
        assert.equal(all.length, 5);
        const original = all[0];
        const replay = await write("POST", "", inputFor(original.imageUrl));
        assert.deepEqual(replay.body.data.item, original, "a lost response can be recovered even at capacity");
        assert.equal((await write("POST", "", { ...inputFor(original.imageUrl), imageUrl: all[1].imageUrl })).status, 409);
        const previousIds = all.map(row => row.id), ids = previousIds.slice().reverse();
        assert.equal((await write("PATCH", "/order", { ids, previousIds })).status, 200);
        assert.equal((await write("PATCH", "/order", { ids, previousIds })).status, 409);
        assert.deepEqual((await list()).map(row => row.id), ids);

        const first = all[0], shared = first.imageUrl;
        await pool.query("UPDATE therapists SET image_url=$1 WHERE id=$2", [shared, therapistA.id]);
        const changed = await images.uploadBuffer(png);
        await cleanupOrphans({ retentionHours: 24 });
        const candidates = () => pool.query("SELECT 1 FROM image_cleanup_candidates WHERE image_url=$1", [changed.imageUrl]);
        assert.equal((await candidates()).rowCount, 1);
        assert.equal((await write("PATCH", "/" + first.id, { ...changed, previousImageUrl: shared })).status, 200);
        assert.equal((await write("PATCH", "/" + first.id, { ...changed, previousImageUrl: shared })).status, 200);
        assert.equal((await write("POST", "", inputFor(shared))).status, 409, "an old retry cannot overwrite a replacement");
        assert.equal((await candidates()).rowCount, 0);
        assert.equal((await write("DELETE", "/" + first.id, { previousImageUrl: shared })).status, 409);
        await cleanupOrphans({ retentionHours: 0 });
        for (const cover of await list()) await images.assertExists(cover.imageUrl);
        assert.deepEqual(Buffer.from(await (await fetch(origin + changed.imageUrl)).arrayBuffer()), png);
        const middle = (await list())[2];
        assert.equal((await write("DELETE", "/" + middle.id, { previousImageUrl: middle.imageUrl })).status, 200);
        assert.equal((await write("POST", "", inputFor(middle.imageUrl))).status, 409, "a late retry cannot recreate a deleted cover");
        const added = (await write("POST", "", { imageUrl: shared })).body.data.item;
        assert.equal((await list()).at(-1).id, added.id);
        for (const cover of await list()) assert.equal((await write("DELETE", "/" + cover.id, { previousImageUrl: cover.imageUrl })).status, 200);
        assert.deepEqual(await list(), []);
        await cleanupOrphans({ retentionHours: 0 });
        await images.assertExists(shared);
        await assert.rejects(images.assertExists(changed.imageUrl), { code: "INVALID_IMAGE" });
        const nextIntent = { creationKey: "another-intent", imageUrl: changed.imageUrl };
        const missing = await write("POST", "", nextIntent);
        assert.equal(missing.body.code, "COVER_UPLOAD_MISSING");
        const simultaneous = await Promise.all([1, 2].map(() => write("POST", "", { ...nextIntent, imageUrl: shared })));
        assert.deepEqual(simultaneous.map(r => r.status), [200, 200]);
        assert.deepEqual(simultaneous[0].body.data.item, simultaneous[1].body.data.item);
        const separate = await write("POST", "", { imageUrl: shared, creationKey: "intentional-second-cover" });
        assert.equal(separate.status, 200);
        assert.notEqual(separate.body.data.item.id, simultaneous[0].body.data.item.id);
        assert.equal((await list()).length, 2);
        const logs = await pool.query("SELECT count(*)::int AS total FROM audit_logs WHERE resource_id=$1 AND action='create_cover'",
          [simultaneous[0].body.data.item.id]);
        assert.equal(logs.rows[0].total, 1);
        const savedId = await retryFromEditor(origin, admin, await tokenFor(admin), shared);
        const final = await list();
        assert.equal(final.length, 3, "the editor added exactly one cover after a lost success response");
        assert.equal(final.at(-1).id, savedId);
      });
    } finally { cleanup(); }
  });
