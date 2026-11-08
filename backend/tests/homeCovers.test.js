const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setup, plain, flush } = require("./support/scheduleUI");

const rows = ["a", "b", "c"].map(id => ({ id, imageUrl: "/" + id, imageSrc: "https://example.invalid/" + id }));
function fixture() {
  const h = setup();
  h.app.globalData.user.role = "admin";
  const catalog = { items: plain(rows) };
  h.deps.cover = {
    adminOwner: () => h.app.globalData.user?.role === "admin" ? h.app.globalData.user.id : "",
    list: async () => plain(catalog.items),
    reorder: async (ids, before) => {
      h.calls.push(["sort", plain(ids), plain(before)]);
      catalog.items = ids.map(id => catalog.items.find(item => item.id === id));
    }
  };
  const event = (page, id, touch) => ({ currentTarget: { dataset: { version: page.data.version, id } },
    touches: touch ? [touch] : [], changedTouches: touch ? [touch] : [] });
  return { h, catalog, event };
}

test("drag across two columns previews order and persists once; releasing does not navigate to edit", async () => {
  const { h, event } = fixture(), page = h.page("pages/admin/covers");
  await page.onShow();
  const rects = [{ left: 0, top: 0, right: 100, bottom: 60 }, { left: 110, top: 0, right: 210, bottom: 60 },
    { left: 0, top: 70, right: 100, bottom: 130 }];
  page.createSelectorQuery = () => ({ selectAll: () => ({ boundingClientRect: callback => ({ exec: () => callback(rects) }) }) });
  page.edit(event(page, "b"));
  assert.match(h.calls.pop()[1].url, /cover-edit\/index\?id=b$/);
  page.startDrag(event(page, "a"));
  const last = event(page, "a", { clientX: 50, clientY: 100 });
  page.dragMove(last);
  assert.deepEqual(plain(page.data.previewOrder), { b: 0, c: 1, a: 2 });
  await page.drop(last); await page.drop(last); page.edit(event(page, "a"));
  assert.deepEqual(h.calls, [["sort", ["b","c","a"], ["a","b","c"]]]);
  assert.deepEqual(plain(page.data.items.map(row => row.id)), ["b","c","a"]);
  page.startDrag(event(page, "b")); page.cancelDrag(); await page.drop(last);
  assert.equal(h.calls.length, 1);
  page.startDrag(event(page, "b"));
  h.app.globalData.user.id = "other"; await page.drop(last);
  assert.equal(h.calls.length, 1, "a dragged card from another session cannot persist");
});

test("saving an image uses the original cover ID, upload failures preserve the draft, and logout stops an unfinished upload", async () => {
  const { h, event } = fixture(), page = h.page("pages/admin/cover-edit");
  page.onLoad({ id: "b" }); await page.onShow();
  let media, finish;
  h.wx.chooseMedia = opts => { media = opts; };
  page.choose(event(page));
  page.onHide(); await page.onShow(); // native picker can temporarily hide the page
  media.success({ tempFiles: [{ tempFilePath: "synthetic.png", size: 100 }] }); media.complete();
  h.deps.cover.upload = async () => { throw new Error("upload failed"); };
  await page.save(event(page));
  assert.equal(page.data.filePath, "synthetic.png");
  h.deps.cover.upload = async () => ({ imageUrl: "/new" });
  h.deps.cover.save = async (...args) => { h.calls.push(["save", ...args]); return { item: { id: "b", imageUrl: "/new" } }; };
  await page.save(event(page)); await page.save(event(page));
  assert.deepEqual(h.calls.filter(c => c[0] === "save"), [["save","b","/new","/b",""]]);
  const add = h.page("pages/admin/cover-edit"); add.onLoad({}); await add.onShow();
  add.choose(event(add)); media.success({ tempFiles: [{ tempFilePath: "second.png", size: 80 }] }); media.complete();
  h.deps.cover.upload = () => new Promise(resolve => { finish = resolve; });
  const pending = add.save(event(add));
  h.app.globalData.user.id = "next-admin";
  finish({ imageUrl: "/ignored" }); await pending;
  assert.equal(h.calls.filter(c => c[0] === "save").length, 1);
});

async function editor(id = "") {
  const { h, event } = fixture();
  const page = h.page("pages/admin/cover-edit");
  page.onLoad({ id });
  await page.onShow();
  h.wx.chooseMedia = options => {
    options.success({ tempFiles: [{ tempFilePath: "draft.png", size: 100 }] });
    options.complete();
  };
  const click = () => event(page);
  page.choose(click());
  return { page, h, click, service: h.deps.cover };
}

test("one confirmed save survives hiding during upload and binding; success navigates once on return", async () => {
  const { page, h, click, service } = await editor();
  let upload, bind, writes = 0;
  service.upload = () => new Promise(resolve => { upload = resolve; });
  service.save = () => { writes++; return new Promise(resolve => { bind = resolve; }); };
  const beforeHide = click();
  const pending = page.save(beforeHide);
  page.onHide();
  upload({ imageUrl: "/uploaded" });
  await flush();
  assert.equal(writes, 1);
  await page.onShow();
  assert.equal(page.data.filePath, "draft.png");
  assert.equal(page.data.saving, true);
  await page.save(beforeHide); await page.save(click());
  page.onHide();
  bind({ item: { id: "created", imageUrl: "/uploaded" } });
  await pending;
  assert.equal(page.data.saving, false);
  assert.equal(h.calls.length, 0);
  await page.onShow(); await page.onShow();
  assert.equal(page.data.id, "created");
  assert.equal(writes, 1);
  assert.deepEqual(h.calls.map(row => row[0]), ["toast", "back"]);
});

test("new session and unload isolate a pending upload and a hidden successful result", async () => {
  for (const transition of ["unload", "new-session", "saved-then-new-session"]) {
    const { page, h, click, service } = await editor();
    let finish, writes = 0;
    service.upload = () => new Promise(resolve => { finish = resolve; });
    service.save = async () => { writes++; return { item: { id: "old-cover", imageUrl: "/u" } }; };
    const pending = page.save(click());
    page.onHide();
    if (transition === "unload") page.onUnload();
    if (transition === "new-session") { h.app.globalData.user.id = "new-admin"; await page.onShow(); }
    finish({ imageUrl: "/u" }); await pending;
    if (transition === "saved-then-new-session") { h.app.globalData.user.id = "new-admin"; await page.onShow(); }
    assert.equal(writes, transition === "saved-then-new-session" ? 1 : 0);
    assert.equal(h.calls.length, 0);
    if (transition !== "unload") {
      assert.equal(page.data.id, "");
      assert.equal(page.data.saving, false);
      assert.equal(page.data.filePath, "");
    }
  }
});

test("network loss and gateway timeout retry the same draft without reuploading or changing the creation key", async () => {
  const { page, click, service } = await editor();
  const keys = [];
  let uploads = 0;
  service.upload = async () => { uploads++; return { imageUrl: "/upload" }; };
  service.save = async (_id, image, _previous, key) => {
    keys.push(key);
    if (keys.length === 1) throw { code: "NETWORK_ERROR" };
    if (keys.length === 2) throw { statusCode: 504 };
    return { item: { id: "persisted", imageUrl: image } };
  };
  await page.save(click()); page.onHide(); await page.onShow(); await page.save(click());
  assert.equal(page.data.uncertain, true);
  page.choose(click()); await page.save(click());
  assert.equal(uploads, 1);
  assert.equal(keys.length, 3);
  assert.match(keys[0], /^[a-z0-9-]{8,80}$/);
  assert.equal(new Set(keys).size, 1);
  assert.equal(page.data.id, "persisted");
});

test("expired upload retries from the local file; unavailable local draft allows a new selection", async () => {
  for (const readable of [true, false]) {
    const { page, h, click, service } = await editor("b");
    let uploads = 0;
    const urls = [];
    h.wx.getFileSystemManager = () => ({ access(options) { assert.equal(options.path, "draft.png"); options.fail(); } });
    service.upload = async () => {
      uploads++;
      if (uploads === 2 && !readable) throw { code: "UPLOAD_NETWORK_ERROR" };
      return { imageUrl: "/image-" + uploads };
    };
    service.save = async (id, url) => {
      urls.push(url);
      if (urls.length === 1) throw { statusCode: 503 };
      if (urls.length === 2) throw { statusCode: 400, code: "COVER_UPLOAD_MISSING" };
      return { item: { id, imageUrl: url } };
    };
    await page.save(click()); await page.save(click());
    assert.equal(page.data.uncertain, false);
    assert.equal(page.data.filePath, "draft.png");
    assert.equal(uploads, 1);
    await page.save(click());
    if (!readable) {
      assert.equal(page.data.filePath, "");
      assert.equal(page.data.imageSrc, rows[1].imageSrc);
      assert.match(page.data.saveHint, /重新选择/);
      page.choose(click()); await page.save(click());
    }
    assert.deepEqual(urls, ["/image-1", "/image-1", readable ? "/image-2" : "/image-3"]);
    assert.equal(page.data.filePath, "");
    assert.equal(page.data.id, "b");
  }
});

test("home uses the saved order, preserves loaded covers on failure and returns to the three original slides after deletion", async () => {
  const { h, catalog } = fixture();
  h.deps.project = { list: async () => ({ items: [] }) };
  h.deps.therapist = { list: async () => ({ therapists: [] }) };
  const home = h.page("pages/home");
  await home.onShow(); await flush();
  assert.deepEqual(plain(home.data.covers.map(row => row.id)), ["a","b","c"]);
  catalog.items.reverse(); await home.onShow(); await flush();
  assert.deepEqual(plain(home.data.covers.map(row => row.id)), ["c","b","a"]);
  const source = h.deps.cover.list; let complete;
  h.deps.cover.list = async () => { throw new Error("offline"); }; await home.onShow(); await flush();
  assert.equal(home.data.covers.length, 3);
  h.deps.cover.list = () => new Promise(r => { complete = r; });
  await home.onShow(); home.onHide();
  catalog.items = []; h.deps.cover.list = source;
  await home.onShow(); await flush();
  complete(rows); await flush();
  assert.deepEqual(plain(home.data.covers), []);
  assert.equal(home.data.banners.length, 3);
  const template = fs.readFileSync(path.resolve(__dirname, "../../miniprogram/pages/home/index.wxml"), "utf8");
  assert.match(template, /swiper wx:if="{{covers.length}}"/);
  assert.match(template, /swiper wx:else[^>]*>[\s\S]*wx:for="{{banners}}"/);
});

test("the add tile opens a new editor below capacity and cannot create a sixth cover", async () => {
  const { h, catalog, event } = fixture(), page = h.page("pages/admin/covers");
  catalog.items = [];
  await page.onShow(); page.add(event(page));
  assert.equal(h.calls.pop()[1].url, "/pages/admin/cover-edit/index");
  catalog.items = Array.from({ length: 5 }, (_, i) => ({ id: String(i) }));
  await page.onShow(); page.add(event(page));
  assert.equal(h.calls.length, 0);
  const add = h.page("pages/admin/cover-edit");
  add.onLoad({}); await add.onShow();
  assert.match(add.data.error, /最多.*5/);
  const template = fs.readFileSync(path.resolve(__dirname, "../../miniprogram/pages/admin/covers/index.wxml"), "utf8");
  assert.match(template, /wx:if="{{items.length < 5}}"/);
});
