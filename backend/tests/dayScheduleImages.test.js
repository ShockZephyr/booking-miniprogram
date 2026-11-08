const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, flush, plain, tap } = require("./support/scheduleUI");

const imageEvent = attempt => ({ currentTarget: { dataset: { attempt } } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("same-image date reload ignores the removed node's error before and after the response", async () => {
  const h = setup(), board = h.board(); await flush();
  const oldAttempt = board.data.imageAttempt, response = deferred();
  h.deps.schedules.day = () => response.promise;
  board.properties.target = { ...board.properties.target, date: "2026-11-02" };
  board.activate();
  board.imageError(imageEvent(oldAttempt));
  assert.equal(board.data.imageFailed, false, "a removed image cannot fail the loading view");
  assert.equal(board.data.imageSource, "");
  response.resolve({ ...plain(h.day), date: "2026-11-02" }); await flush();
  assert.equal(board.data.day.date, "2026-11-02");
  assert.equal(board.data.imageSource, h.day.therapistImageSrc);
  assert.notEqual(board.data.imageAttempt, oldAttempt);
  board.imageError(imageEvent(oldAttempt));
  assert.equal(board.data.imageFailed, false);

  const currentAttempt = board.data.imageAttempt;
  board.imageError(imageEvent(currentAttempt));
  assert.equal(board.data.imageFailed, true, "a current image failure still offers retry");
  board.retryImage();
  assert.equal(board.data.imageFailed, false);
  assert.notEqual(board.data.imageAttempt, currentAttempt);
  assert.equal(board.data.imageSource, h.day.therapistImageSrc, "retry retains the original URL");
  board.imageError(imageEvent(currentAttempt));
  assert.equal(board.data.imageFailed, false, "a retry invalidates its preceding image attempt");
  board.imageError(imageEvent(board.data.imageAttempt));
  assert.equal(board.data.imageFailed, true);
  board.detach();
});

test("out-of-order date responses and image callbacks leave the latest date and avatar intact", async () => {
  const h = setup(), board = h.board(); await flush();
  const oldAttempt = board.data.imageAttempt, responses = new Map();
  h.deps.schedules.day = (id, date) => {
    const response = deferred(); responses.set(date, response); return response.promise;
  };
  for (const date of ["2026-11-01", "2026-11-02"]) {
    board.properties.target = { ...board.properties.target, date }; board.activate();
  }
  responses.get("2026-11-02").resolve({ ...plain(h.day), date: "2026-11-02" }); await flush();
  const latestAttempt = board.data.imageAttempt;
  responses.get("2026-11-01").resolve({ ...plain(h.day), date: "2026-11-01", therapistImageSrc: "https://example.test/old.png" });
  await flush();
  board.imageError(imageEvent(oldAttempt));
  assert.equal(board.data.day.date, "2026-11-02");
  assert.equal(board.data.imageSource, h.day.therapistImageSrc);
  assert.equal(board.data.imageAttempt, latestAttempt);
  assert.equal(board.data.imageFailed, false);
  board.detach();
});

test("saving day projects reloads the same avatar without changing the write payload", async () => {
  const h = setup(); h.app.globalData.user.role = "admin";
  const board = h.board(); await flush();
  const oldAttempt = board.data.imageAttempt, response = deferred();
  h.deps.schedules.day = () => response.promise;
  board.setData({ projectIds: ["p", "q"] });
  const save = board.applyDay({ currentTarget: { dataset: { action: "projects", viewVersion: board.data.viewVersion } } });
  await flush();
  assert.equal(board.data.loading, true);
  board.imageError(imageEvent(oldAttempt));
  assert.equal(board.data.imageFailed, false);
  response.resolve({ ...plain(h.day), serviceItemIds: ["p", "q"] }); await save;
  assert.deepEqual(plain(h.calls.filter(call => call[0] === "change")), [
    ["change", h.day.therapistId, { date: h.day.date, serviceItemIds: ["p", "q"] }]
  ]);
  assert.equal(board.data.day.date, h.day.date);
  assert.deepEqual(plain(board.data.projectIds), ["p", "q"]);
  board.imageError(imageEvent(oldAttempt));
  assert.equal(board.data.imageFailed, false);
  assert.equal(board.data.saving, false);
  board.detach();
});

test("a failed reload can recover the same URL and preserves valid selection on that date", async () => {
  const h = setup(), board = h.board(); await flush();
  tap(board, "09:00"); tap(board, "10:30");
  const oldAttempt = board.data.imageAttempt;
  board.imageError(imageEvent(oldAttempt));
  h.deps.schedules.day = async () => { throw new Error("测试加载失败"); };
  await board.load();
  board.imageError(imageEvent(oldAttempt)); board.retryImage();
  assert.equal(board.data.error, "测试加载失败");
  assert.equal(board.data.day, null);
  assert.equal(board.data.imageSource, "");
  h.deps.schedules.day = async () => plain(h.day);
  await board.load();
  assert.equal(board.data.error, "");
  assert.equal(board.data.imageSource, h.day.therapistImageSrc);
  assert.equal(board.data.imageFailed, false);
  assert.deepEqual([board.data.start, board.data.end, board.data.nextReady], ["09:00", "10:30", true]);
  board.imageError(imageEvent(oldAttempt));
  assert.equal(board.data.imageFailed, false);
  board.detach();
});

for (const mode of ["hidden", "detached", "account"]) {
  test(`image error and retry do not update a ${mode} day view`, async () => {
    const h = setup(), board = h.board(); await flush();
    const attempt = board.data.imageAttempt;
    if (mode === "hidden") board.properties.visible = false;
    if (mode === "detached") board.detach();
    if (mode === "account") h.app._loginSessionVersion++;
    let updates = 0;
    const setData = board.setData;
    board.setData = function (patch) { updates++; setData.call(this, patch); };
    board.imageError(imageEvent(attempt));
    assert.equal(updates, 0);
    board.data.imageFailed = true;
    board.retryImage();
    assert.equal(updates, 0);
    board.detach();
  });
}
