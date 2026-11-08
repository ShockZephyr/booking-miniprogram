const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const filterEvent = (page, value, field) => ({ currentTarget: { dataset: { filterVersion: page.data.filterVersion, field } }, detail: { value } });
const vm = require("node:vm");
const imageFallback = require("../../miniprogram/utils/imageFallback");

const root = path.join(__dirname, "../../miniprogram");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function load(file, modules = {}, globals = {}) {
  let definition;
  vm.runInNewContext(read(file), {
    require: (name) => name.endsWith("/imageFallback") ? imageFallback : modules[name.split("/").at(-1)] || {},
    Page: (value) => { definition = value; }, Component: (value) => { definition = value; },
    wx: { showToast() {}, setNavigationBarTitle() {} }, ...globals
  }, { filename: file });
  const host = Object.assign({}, definition, definition.methods);
  host.data = plain(definition.data || {});
  host.properties = {};
  host.setData = (patch, callback) => { Object.assign(host.data, patch); if (callback) callback(); };
  return host;
}

// Model the actual rpx rules, including the existing narrow breakpoint. This
// detects hit-layer overlap, but cannot replace native WeChat hit testing.
function style(css, selector, width) {
  // Remove only inactive media blocks, not ordinary rules following them.
  const active = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /@media\s*\(max-width:\s*(\d+)px\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g,
    (_, maxWidth, rules) => width <= Number(maxWidth) ? rules : ""
  );
  const result = {};
  for (const [, selectors, declarations] of active.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(",").map((part) => part.trim()).includes(selector)) continue;
    for (const declaration of declarations.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > -1) result[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return result;
}
function px(value, width) {
  assert.match(value, /^-?[\d.]+(?:rpx|px)$/);
  return parseFloat(value) * (value.endsWith("rpx") ? width / 750 : 1);
}
function rectangle(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height };
}
function expand(box, rule, width) {
  return { left: box.left + px(rule.left, width), right: box.right - px(rule.right, width),
    top: box.top + px(rule.top, width), bottom: box.bottom - px(rule.bottom, width) };
}
function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
function contains(box, point) {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}
const catalog = { serviceItems: [{ id: "p1", name: "项目一" }, { id: "p2", name: "项目二" }], therapists: [{ id: "t1", name: "甲" }], supportsInactiveFilters: true };
function appointments(list, filterOptions = async () => catalog, extra = {}) {
  const page = load("pages/my-appointments/index.js", {
    appointment: { my: (status, query) => list(query, "user"), filterOptions },
    admin: { appointments: (query) => list(query, "admin") },
    therapistPortal: { appointments: (query) => list(query, "therapist") },
    date: { today: () => "2026-10-25", addDays: (date) => date, isExpired: () => false },
    filterTime: require("../../miniprogram/utils/filterTime"),
    checkIn: { canCheckIn: () => true }, ...extra
  });
  page.onLoad({});
  return page;
}
const row = (id) => ({ id, status: "booked", serviceItemName: "项目一", date: "2026-10-25", startTime: "12:00", endTime: "13:00" });

for (const role of ["user", "therapist", "admin"]) {
  test(`list failure/retry keeps confirmed and draft filters and routes correctly for ${role}`, async () => {
    const requests = [];
    let pending;
    const page = appointments((query, route) => {
      requests.push({ query: plain(query), route });
      pending = deferred(); return pending.promise;
    });
    page.setData({ hasUser: true, isAdminMode: role === "admin", isTherapistMode: role === "therapist", active: "all",
      filterServiceItemIds: ["p1"], filterTherapistIds: ["t1"], filterAllDates: false,
      filterFromDate: "2026-10-24", filterToDate: "2026-10-28", filterStartTime: "09:00", filterEndTime: "11:00",
      filterDrawerVisible: true, draftFilterServiceItemIds: ["p2"], draftStartTime: "10:00" });
    page.load(); pending.reject(new Error("暂时离线")); await flush();
    assert.equal(page.data.listError, "暂时离线");
    assert.equal(page.data.loading, false);
    page.retryAppointments(); page.retryAppointments();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[1].route, role);
    assert.deepEqual(requests[1].query.therapistIds, role === "therapist" ? [] : ["t1"]);
    pending.resolve({ appointments: [row("a")], pagination: {} }); await flush();
    assert.equal(page.data.listError, "");
    assert.equal(page.data.appointments[0].id, "a");
    assert.equal(page.data.active, "all");
    assert.equal(page.data.draftStartTime, "10:00");
    assert.deepEqual(plain(page.data.draftFilterServiceItemIds), ["p2"]);
    assert.equal(page.data.filterDrawerVisible, true);
    page.retryAppointments(); assert.equal(requests.length, 2);
  });
}

test("append retry retains rows, selection and cursor; end scrolling does not retry in a loop", async () => {
  const queries = []; let pending;
  const page = appointments((query) => { queries.push(plain(query)); pending = deferred(); return pending.promise; });
  page.data.hasUser = true;
  page.load(); pending.resolve({ appointments: [row("a")], pagination: { page: 1, hasMore: true, nextCursor: "cursor-a" } }); await flush();
  page.setData({ isAdminMode: true, selectedAppointmentId: "a", selectedAppointment: page.data.appointments[0] });
  page.onReachBottom(); pending.reject(new Error("分页失败")); await flush();
  assert.equal(page.data.moreError, "分页失败");
  assert.equal(page.data.nextCursor, "cursor-a");
  assert.equal(page.data.page, 1);
  assert.equal(page.data.appointments[0].id, "a");
  page.onReachBottom(); assert.equal(queries.length, 2);
  page.retryAppointments(); assert.deepEqual(queries[2], queries[1]);
  pending.resolve({ appointments: [row("a"), row("b")], pagination: { page: 2, hasMore: false } }); await flush();
  assert.deepEqual(plain(page.data.appointments.map((item) => item.id)), ["a", "b"]);
  assert.equal(page.data.moreError, "");
  assert.equal(page.data.selectedAppointmentId, "a");
});

test("a late retry cannot overwrite a different status or an account reset", async () => {
  const requests = [];
  const page = appointments(() => { const pending = deferred(); requests.push(pending); return pending.promise; });
  page.showForUser({ id: "first", role: "user" });
  requests[0].reject(new Error("离线")); await flush();
  page.retryAppointments();
  page.switchTab({ currentTarget: { dataset: { key: "cancelled" } } });
  requests[2].resolve({ appointments: [], pagination: {} }); await flush();
  requests[1].reject(new Error("旧请求失败")); await flush();
  assert.equal(page.data.listError, "");
  assert.equal(page.data.emptyText, "暂无已取消预约");
  page.load();
  page.showForUser(null);
  requests[3].resolve({ appointments: [row("private-old-row")], pagination: {} }); await flush();
  page.retryAppointments();
  assert.equal(requests.length, 4);
  assert.equal(page.data.appointments.length, 0);
  assert.equal(page.data.hasUser, false);
});

for (const failedCategory of ["projects", "therapists"]) {
  test(`partial fallback only retries failed ${failedCategory}, retaining selections made during loading`, async () => {
    let projectsCalls = 0, therapistsCalls = 0, failing = true, pending;
    const page = appointments(async () => ({ appointments: [], pagination: {} }), async () => { throw { statusCode: 404 }; }, {
      user: { serviceItems: () => {
        projectsCalls++;
        if (failedCategory !== "projects") return Promise.resolve({ items: catalog.serviceItems });
        if (failing) return Promise.reject(new Error("离线"));
        pending = deferred(); return pending.promise;
      } },
      therapist: { list: () => {
        therapistsCalls++;
        if (failedCategory !== "therapists") return Promise.resolve({ therapists: catalog.therapists });
        if (failing) return Promise.reject(new Error("离线"));
        pending = deferred(); return pending.promise;
      } }
    });
    page.data.hasUser = true;
    page.setData({ serviceItems: catalog.serviceItems, therapists: catalog.therapists,
      filterServiceItemIds: ["p1"], filterTherapistIds: ["t1"], filterDrawerVisible: true,
      draftFilterServiceItemIds: ["p2"], draftFilterTherapistIds: ["t1"], draftStartTime: "12:00" });
    page.loadFilterOptions(); await flush();
    assert.equal(page.data[failedCategory === "projects" ? "serviceItemsError" : "therapistsError"].length > 0, true);
    assert.deepEqual(plain(page.data.filterServiceItemIds), ["p1"]);
    assert.deepEqual(plain(page.data.draftFilterServiceItemIds), ["p2"]);
    failing = false;
    page.retryFilterOptions(filterEvent(page)); page.retryFilterOptions(filterEvent(page)); await flush();
    page.data.draftStartTime = "14:00";
    page.selectFilterProjects(filterEvent(page, ["p1"]));
    pending.resolve(failedCategory === "projects" ? { items: catalog.serviceItems } : { therapists: catalog.therapists }); await flush();
    assert.equal(projectsCalls, failedCategory === "projects" ? 2 : 1);
    assert.equal(therapistsCalls, failedCategory === "therapists" ? 2 : 1);
    assert.equal(page.data.serviceItemsError, "");
    assert.equal(page.data.therapistsError, "");
    assert.equal(page.data.serviceItems[0].filterChecked, true);
    assert.equal(page.data.serviceItems[1].filterChecked, false);
    assert.equal(page.data.draftStartTime, "14:00");
    assert.equal(page.data.filterDrawerVisible, true);
    page.retryFilterOptions(filterEvent(page)); await flush();
    assert.equal(projectsCalls + therapistsCalls, 3);
  });
}

test("catalog failure and pending refresh never erase committed filters; successful empty results do", async () => {
  let failing = true;
  const page = appointments(async () => ({ appointments: [], pagination: {} }), async () => {
    if (failing) throw new Error("离线");
    return { serviceItems: [], therapists: [], supportsInactiveFilters: false };
  });
  page.setData({ hasUser: true, filterServiceItemIds: ["p1"], filterTherapistIds: ["t1"], activeFilterCount: 2 });
  page.loadFilterOptions();
  page.openFilterDrawer(filterEvent(page)); page.confirmFilters(filterEvent(page));
  assert.deepEqual(plain(page.data.filterServiceItemIds), ["p1"]);
  await flush();
  page.openFilterDrawer(filterEvent(page)); page.confirmFilters(filterEvent(page)); await flush();
  assert.deepEqual(plain(page.data.filterServiceItemIds), ["p1"]);
  assert.deepEqual(plain(page.data.filterTherapistIds), ["t1"]);
  assert.equal(page.data.activeFilterCount, 2);
  failing = false; page.openFilterDrawer(filterEvent(page)); page.retryFilterOptions(filterEvent(page)); await flush();
  assert.equal(page.data.serviceItemsError, "");
  assert.equal(page.data.serviceItems.length, 0);
  assert.equal(page.data.activeFilterCount, 0);
  assert.deepEqual(plain(page.data.filterServiceItemIds), []);
});

test("therapist fallback failure remains retryable without fetching other therapists", async () => {
  let failing = true, calls = 0;
  const page = appointments(async () => ({ appointments: [] }), undefined, {
    appointment: {},
    user: { serviceItems: async () => { calls++; if (failing) throw new Error("离线"); return { items: [] }; } },
    therapist: { list: () => assert.fail("therapist list must not be requested") }
  });
  page.setData({ hasUser: true, isTherapistMode: true });
  page.loadFilterOptions(); await flush();
  assert.equal(page.data.serviceItemsError, "项目加载失败");
  assert.equal(page.data.therapistsError, "");
  failing = false; page.openFilterDrawer(filterEvent(page)); page.retryFilterOptions(filterEvent(page)); await flush();
  assert.equal(calls, 2);
  assert.equal(page.data.serviceItemsError, "");
});

test("old catalog errors cannot replace a different account's successful catalogs", async () => {
  const pending = deferred(); let call = 0;
  const page = appointments(async () => ({ appointments: [] }), () => ++call === 1 ? pending.promise : Promise.resolve(catalog));
  page.showForUser({ id: "first", role: "user" });
  page.showForUser({ id: "second", role: "admin" }); await flush();
  pending.reject(new Error("旧账号失败")); await flush();
  assert.equal(page.data.serviceItemsError, "");
  assert.equal(page.data.therapistsError, "");
  assert.equal(page.data.serviceItems.length, 3);
});

test("admin detail retry uses the same target and rechecks authorization before any API request", async () => {
  let calls = 0, allowed = true, failing = true;
  const targets = [];
  const page = load("pages/admin/slot-appointment/index.js", {
    loginReturn: { ensure: async (target, role) => { targets.push([target, role]); return allowed; }, sessionKey: () => "session" },
    admin: { appointment: async (id) => {
      calls++; assert.equal(id, "s1");
      if (failing) throw new Error("离线");
      return { appointment: row(id), history: [] };
    } },
    user: { serviceItems: async () => ({ items: [] }) }, therapist: { list: async () => ({ therapists: [] }) },
    date: { isExpired: () => false }, checkIn: { canCheckIn: () => false }
  });
  page.onLoad({ appointmentId: "s1" }); await page.load();
  assert.equal(page.data.error, "离线");
  failing = false; page.retryLoad(); page.retryLoad(); await flush();
  assert.equal(calls, 2);
  assert.deepEqual(targets[1], targets[0]);
  assert.equal(page.data.currentAppointment.id, "s1");
  allowed = false; page.retryLoad(); await flush();
  assert.equal(calls, 2);
  assert.equal(page.data.currentAppointment, null);
});

for (const kind of ["project", "therapist"]) {
  test(`${kind} card image fallback retries the original URL, ignores old errors and keeps navigation intact`, () => {
    const card = load(`components/${kind}-card/index.js`);
    const record = { id: "catalog-record", name: "展示项", imageSrc: "/uploads/image-a.jpg?signature=original" };
    card.data[kind] = record;
    const observe = (source) => card.observers[`${kind}.imageSrc`].call(card, source);
    const events = []; card.triggerEvent = (...args) => events.push(args);
    observe(record.imageSrc);
    const first = card.data.imageAttempt;
    observe(record.imageSrc);
    assert.equal(card.data.imageAttempt, first, "unchanged component properties must not restart downloads");
    card.imageError({ currentTarget: { dataset: { attempt: first } } });
    assert.equal(card.data.imageFailed, true);
    observe(record.imageSrc);
    assert.equal(card.data.imageFailed, true, "unchanged properties must not automatically retry a failed image");
    assert.equal(record.imageSrc, "/uploads/image-a.jpg?signature=original");
    card.retryImage(); card.retryImage();
    assert.equal(card.data.imageAttempt, first + 1);
    assert.equal(card.data.imageFailed, false);
    assert.equal(card.data.imageRequests[0].src, record.imageSrc);
    card.imageError({ currentTarget: { dataset: { attempt: first } } });
    assert.equal(card.data.imageFailed, false);
    observe("/uploads/image-b.jpg");
    card.imageError({ currentTarget: { dataset: { attempt: first + 1 } } });
    assert.equal(card.data.imageFailed, false);
    assert.equal(card.data.imageRequests[0].src, "/uploads/image-b.jpg");
    card.tap(); assert.equal(events[0][0], "select"); assert.equal(events[0][1][kind], record);
    observe(""); card.retryImage();
    assert.equal(card.data.imageRequests.length, 0);
    assert.equal(card.data.imageFailed, false);
    const template = read(`components/${kind}-card/index.wxml`);
    assert.match(template, /catchtap="retryImage"/); // Retrying cannot open the card detail.
    assert.match(template, /wx:key="key"[^>]*data-attempt="{{imageRequest.key}}"[^>]*binderror="imageError"/);
  });

  test(`${kind} detail download failure does not remove the record or staff booking restrictions`, async () => {
    const record = { id: "detail-record", name: "展示项", imageSrc: "/uploads/a.jpg" };
    const page = load(`pages/${kind}-detail/index.js`, {
      [kind]: { detail: async () => ({ [kind === "project" ? "item" : "therapist"]: record }) }
    });
    page.loadForUser({ role: "admin", therapistId: "t1" }); await flush();
    page.imageError({ currentTarget: { dataset: { attempt: page.data.imageAttempt } } });
    assert.equal(page.data.imageFailed, true);
    assert.equal(page.data[kind === "project" ? "item" : "therapist"], record);
    assert.equal(page.data.canBook, false);
    assert.equal(page.data.error, "");
    page.retryImage(); assert.equal(page.data.imageRequests[0].src, record.imageSrc);
    assert.equal(page.data.canBook, false);
  });

  test(`${kind} detail same-URL recreation ignores the previous image both during and after reload`, async () => {
    const requests = [];
    const key = kind === "project" ? "item" : "therapist";
    const record = { id: "same-url", imageSrc: "/uploads/test.jpg?signature=unchanged" };
    const page = load(`pages/${kind}-detail/index.js`, {
      [kind]: { detail: () => { const pending = deferred(); requests.push(pending); return pending.promise; } }
    });
    page.loadForUser({ role: "user" });
    requests[0].resolve({ [key]: record }); await flush();
    const oldAttempt = page.data.imageAttempt;
    page.loadForUser({ role: "user" });
    page.imageError({ currentTarget: { dataset: { attempt: oldAttempt } } });
    assert.equal(page.data.loading, true);
    assert.equal(page.data.imageFailed, false);
    requests[1].resolve({ [key]: record }); await flush();
    assert.equal(page.data.loading, false);
    assert.ok(page.data.imageAttempt > oldAttempt);
    assert.equal(page.data.imageRequests[0].src, record.imageSrc);
    page.imageError({ currentTarget: { dataset: { attempt: oldAttempt } } });
    assert.equal(page.data.imageFailed, false);
    assert.equal(page.data.canBook, true);
    const currentAttempt = page.data.imageAttempt;
    page.imageError({ currentTarget: { dataset: { attempt: currentAttempt } } });
    assert.equal(page.data.imageFailed, true, "a current failure must still offer retry");
    page.retryImage();
    page.imageError({ currentTarget: { dataset: { attempt: currentAttempt } } });
    assert.equal(page.data.imageFailed, false);
    assert.equal(page.data.imageRequests[0].src, "/uploads/test.jpg?signature=unchanged");
    assert.equal(page.data[key], record);
  });

  test(`${kind} detail stale success or failure cannot replace a newer render or booking capability`, async () => {
    const requests = [];
    const key = kind === "project" ? "item" : "therapist";
    const page = load(`pages/${kind}-detail/index.js`, {
      [kind]: { detail: () => { const pending = deferred(); requests.push(pending); return pending.promise; } }
    });
    page.loadForUser({ role: "user" });
    page.loadForUser({ role: "user" });
    page.loadForUser({ role: "admin" });
    requests[0].resolve({ [key]: { id: "old", imageSrc: "/uploads/old.jpg" } }); await flush();
    assert.equal(page.data.loading, true, "an old request cannot finish a newer loading state");
    const record = { id: "current", imageSrc: "/uploads/current.jpg" };
    requests[2].resolve({ [key]: record }); await flush();
    const attempt = page.data.imageAttempt;
    requests[1].reject(new Error("stale failure")); await flush();
    assert.equal(page.data[key], record);
    assert.equal(page.data.imageAttempt, attempt);
    assert.equal(page.data.error, "");
    assert.equal(page.data.loading, false);
    assert.equal(page.data.canBook, false);
  });
}

test("transparent action layers keep the pinned visual dimensions and route the same actions", () => {
  const css = read("components/appointment-card/index.wxss");
  assert.match(css, /\.compact-action \{[^}]*width: 108rpx;[^}]*height: 60rpx;[^}]*padding: 8rpx 6rpx;[^}]*flex: 0 0 108rpx;/s);
  assert.match(css, /\.compact-actions\.user-actions \{[^}]*grid-row: 3;[^}]*justify-self: end;[^}]*margin-top: 16rpx;/s);
  assert.match(css, /\.action-hit \{[^}]*position:absolute;/);
  const template = read("components/appointment-card/index.wxml");
  const hits = [...template.matchAll(/<view class="action-hit" data-type="([^"]+)" catchtap="action"[^>]*>/g)];
  assert.deepEqual(hits.map((hit) => hit[1]), ["checkIn", "cancel", "uncheckIn", "checkIn", "modify", "cancel"]);
  const card = load("components/appointment-card/index.js");
  card.properties.appointment = row("a");
  const emitted = []; card.triggerEvent = (...args) => emitted.push(args);
  for (const type of ["checkIn", "modify", "cancel"]) card.action({ currentTarget: { dataset: { type } } });
  assert.deepEqual(emitted.map((event) => event[1].type), ["checkIn", "modify", "cancel"]);
  assert.ok(emitted.every((event) => event[1].appointment.id === "a"));
});

test("action hit areas avoid metadata, status, notes and adjacent actions at 320/375/430px", () => {
  const css = read("components/appointment-card/index.wxss");
  for (const width of [320, 375, 430]) {
    for (const layout of [".list-layout", ".detail-layout"]) {
      const unit = (value) => px(value, width);
      const button = style(css, ".compact-action", width);
      const hit = { ...style(css, ".action-hit", width), ...style(css, `${layout} .action-hit`, width) };
      const gap = unit(style(css, ".compact-actions", width).gap);
      const rowGap = unit(style(css, layout, width)["row-gap"]);
      const margin = unit((layout === ".list-layout"
        ? style(css, ".list-layout.mode-user .user-actions", width)
        : style(css, `${layout} .compact-actions`, width))["margin-top"]);
      const buttonWidth = unit(button.width), buttonHeight = unit(button.height);
      for (const count of [2, 3]) {
        const boxes = Array.from({ length: count }, (_, index) =>
          rectangle(index * (buttonWidth + gap), 0, buttonWidth, buttonHeight));
        const hits = boxes.map((box) => expand(box, hit, width));
        // Customer lists now leave a gap; details retain their flush action row.
        // Neither transparent target may borrow area from preceding content.
        const metadata = rectangle(-100, -200 - rowGap - margin, width + 200, 200);
        const note = rectangle(-100, -100 - rowGap - margin, width + 200, 100);
        for (let index = 0; index < hits.length; index++) {
          const target = hits[index], visual = boxes[index];
          assert.ok(target.left <= visual.left && target.right >= visual.right);
          assert.equal(target.top, visual.top);
          assert.ok(target.bottom > visual.bottom);
          assert.equal(overlaps(target, metadata), false, `${width}: therapist text is not an action`);
          assert.equal(overlaps(target, note), false, `${width}: note is not an action`);
          assert.equal(contains(target, { x: visual.left + buttonWidth / 2, y: metadata.bottom - 1 }), false);
          if (index) assert.equal(overlaps(target, hits[index - 1]), false);
        }
      }
      // Staff details retain the separate zero-gap action row.
      const staff = expand(rectangle(0, 0, buttonWidth, buttonHeight), hit, width);
      const status = rectangle(0, -100, buttonWidth, 100);
      const metadata = rectangle(-200, -200, width + 200, 200);
      assert.equal(overlaps(staff, status), false);
      assert.equal(overlaps(staff, metadata), false);
    }
  }
});

test("staff list actions align to the image bottom without covering member text or notes", () => {
  const css = read("components/appointment-card/index.wxss");
  const template = read("components/appointment-card/index.wxml");
  const condition = template.match(/{{([^{}]+) \? 'staff-inline-actions' : ''}}/)[1];
  const cardCondition = template.match(/{{([^{}]+) \? 'staff-action-card' : ''}}/)[1];
  for (const actionMode of ["user", "therapist", "admin"]) {
    for (const detail of [false, true]) for (const showActions of [false, true]) for (const canCheckIn of [false, true]) {
      const expected = !detail && showActions && canCheckIn && actionMode !== "user";
      const context = { detail, showActions, actionMode, appointment: { canCheckIn } };
      assert.equal(vm.runInNewContext(condition, context), expected);
      assert.equal(vm.runInNewContext(cardCondition, context), expected);
    }
  }
  for (const width of [320, 375, 430]) {
    const unit = value => px(value, width);
    const button = style(css, ".compact-action", width);
    const action = style(css, ".list-layout.staff-inline-actions .staff-actions", width);
    assert.equal(action["grid-row"], "2");
    assert.equal(action["align-self"], "end");
    assert.equal(action.transform, "translateY(12rpx)");
    assert.equal(style(css, ".appointment-card.staff-action-card", width)["padding-bottom"], "36rpx");
    const hit = { ...style(css, ".action-hit", width), ...style(css, ".list-layout .action-hit", width) };
    const contentWidth = unit("420rpx");
    // Four one-line rows form the shortest normal staff body. Wrapping extends
    // the same grid row, so image and button retain their common bottom edge.
    for (const bodyHeight of [unit("168rpx"), unit("276rpx")]) {
      const visual = rectangle(contentWidth - unit(button.width), bodyHeight - unit(button.height), unit(button.width), unit(button.height));
      const target = expand(visual, hit, width);
      assert.ok(Math.abs(visual.bottom - bodyHeight) < 1e-8, "button and image share a bottom edge");
      for (const field of [".member-info", ".note"]) {
        const reserved = unit(style(css, `.list-layout.staff-inline-actions ${field}`, width)["padding-right"]);
        const text = rectangle(0, 0, contentWidth - reserved, bodyHeight);
        assert.equal(overlaps(target, text), false, `${width}: ${field} stays outside the check-in hit area`);
      }
      assert.equal(overlaps(target, rectangle(-unit("200rpx"), 0, unit("180rpx"), bodyHeight)), false);
    }
    assert.equal(unit(style(css, ".list-layout.mode-user .user-actions", width)["margin-top"]), unit("24rpx"));
    assert.equal(style(css, ".detail-layout .compact-actions", width)["margin-top"], "0rpx");
  }
});

test("narrow appointment actions remain disjoint after native rpx quantization", () => {
  const css = read("components/appointment-card/index.wxss");
  const hit = style(css, ".action-hit", 320);
  // Captured in DevTools at 320px/DPR2: 46px pills, 1px visual gaps.
  // Nonzero 1rpx offsets rendered as 1px, not the floating-point 0.427px.
  const nativeOffset = (value) => {
    const number = px(value, 320);
    return number === 0 ? 0 : Math.sign(number) * Math.max(1, Math.floor(Math.abs(number)));
  };
  for (const count of [2, 3]) {
    const boxes = Array.from({ length: count }, (_, index) => rectangle(index * 47, 0, 46, 25));
    const hits = boxes.map((box) => ({ ...box,
      left: box.left + nativeOffset(hit.left), right: box.right - nativeOffset(hit.right) }));
    for (let index = 1; index < count; index++) {
      assert.equal(overlaps(hits[index - 1], hits[index]), false);
      assert.ok(hits[index].left - hits[index - 1].right >= 1, "retain a real pixel of safe whitespace");
    }
  }
});

test("arrow hit areas avoid drag handles, cards, neighboring arrows and rows at 320/375/430px", () => {
  const css = read("pages/projects/index.wxss");
  assert.match(css, /\.reorder-button \{[^}]*width:60rpx;[^}]*height:60rpx;[^}]*background:transparent;/);
  for (const width of [320, 375, 430]) {
    const unit = (value) => px(value, width);
    const control = style(css, ".reorder-controls", width);
    const button = style(css, ".reorder-button", width);
    const handle = style(css, ".drag-handle", width);
    const rowStyle = style(css, ".project-row", width);
    const gap = unit(control.gap), columnWidth = unit(control.width);
    const buttonWidth = unit(button.width), buttonHeight = unit(button.height);
    assert.equal(button.width, width <= 340 ? "56rpx" : "60rpx", "visible arrow size stays pinned");
    const handleHeight = unit(handle.height);
    const top = (unit(control["min-height"]) - handleHeight - 2 * buttonHeight - 2 * gap) / 2;
    const drag = rectangle((columnWidth - unit(handle.width)) / 2, top, unit(handle.width), handleHeight);
    const up = rectangle((columnWidth - buttonWidth) / 2, drag.bottom + gap, buttonWidth, buttonHeight);
    const down = rectangle(up.left, up.bottom + gap, buttonWidth, buttonHeight);
    const hits = [up, down].map((box) => expand(box, style(css, ".reorder-hit", width), width));
    const cardGap = unit(style(css, ".project-row.manage", width).gap);
    const card = rectangle(-width - cardGap, -width, width, width * 3);
    const listPadding = unit(style(css, ".list-content", width).padding.split(/\s+/)[1]);
    for (const [index, target] of hits.entries()) {
      const visual = [up, down][index];
      assert.ok(target.left < visual.left && target.right > visual.right);
      assert.ok(target.top < visual.top && target.bottom > visual.bottom);
      assert.equal(overlaps(target, drag), false, `${width}: drag handle must not trigger sort`);
      assert.equal(overlaps(target, card), false, `${width}: card must not trigger sort`);
      assert.ok(target.right < columnWidth + listPadding, "target stays inside list whitespace");
      assert.equal(contains(target, { x: columnWidth / 2, y: (drag.top + drag.bottom) / 2 }), false);
      assert.equal(contains(target, { x: card.right - 1, y: (target.top + target.bottom) / 2 }), false);
    }
    assert.equal(overlaps(hits[0], hits[1]), false);
    const rowHeight = unit(rowStyle["min-height"]);
    assert.ok(hits[1].bottom < rowHeight + drag.top, "next row's drag handle stays clear");
    assert.ok(hits[1].bottom < rowHeight + hits[0].top, "next row's arrows stay clear");
  }
  const template = read("pages/projects/index.wxml");
  assert.match(template, /class="reorder-hit up"[^>]*data-direction="-1"[^>]*catchtap="moveProject"[^>]*aria-disabled=/);
  assert.match(template, /class="reorder-hit down"[^>]*data-direction="1"[^>]*catchtap="moveProject"[^>]*aria-disabled=/);
  assert.match(template, /bindlongpress="startDrag"[^]*?bindtouchend="endDrag"/);
});

test("catalog failure content keeps image frames and a separate, optional retry icon", () => {
  for (const location of ["components/project-card", "pages/project-detail", "components/therapist-card", "pages/therapist-detail"]) {
    const template = read(`${location}/index.wxml`);
    const css = read(`${location}/index.wxss`);
    const host = load(`${location}/index.js`);
    assert.equal(host.data.retryIconFailed, false);
    host.setData(imageFallback.sourcePatch(host, "/uploads/original.jpg"));
    host.imageError({ currentTarget: { dataset: { attempt: host.data.imageAttempt } } });
    const beforeIcon = plain(host.data);
    host.retryIconError();
    assert.deepEqual(plain(host.data), { ...beforeIcon, retryIconFailed: true });
    host.retryImage();
    assert.equal(host.data.imageFailed, false, "a missing custom icon cannot break image retry");
    assert.equal(host.data.imageRequests[0].src, "/uploads/original.jpg");
    assert.match(template, /class="image-retry-label"><text>点击重试<\/text><image wx:if="{{!retryIconFailed}}"[^>]*src="\/assets\/icons\/image-retry.png"[^>]*binderror="retryIconError"/);
    if (location.includes("project")) {
      assert.match(template, /class="image-error-content"/);
      assert.equal(style(css, ".image-error-content", 375).display, "inline-flex");
      assert.equal(style(css, ".image-error-content", 375).width, undefined);
    }
  }
  const cardCss = read("components/project-card/index.wxss");
  assert.equal(style(cardCss, ".cover", 375).width, "140rpx");
  assert.equal(style(cardCss, ".cover", 375).height, "140rpx");
  assert.equal(style(read("pages/project-detail/index.wxss"), ".hero", 375).width, "100%");
  for (const width of [320, 375, 430]) {
    const fontSize = px(style(cardCss, ".image-error-content", width)["font-size"], width);
    const iconWidth = px(style(cardCss, ".retry-icon", width).width, width);
    const gap = px(style(cardCss, ".image-retry-label", width).gap, width);
    const coverWidth = px(style(cardCss, ".cover", width).width, width);
    // Four CJK glyphs plus icon and gap fit within the preserved thumbnail,
    // with the inner group's 8rpx horizontal allowance.
    assert.ok(4 * fontSize + iconWidth + gap <= coverWidth - px("8rpx", width));
  }
  assert.match(read("assets/icons/README.md"), /image-retry\.png/);
});

test("error markup takes precedence over empty results, and retry remains available after pagination failure", () => {
  const template = read("pages/my-appointments/index.wxml");
  assert.ok(template.indexOf('wx:elif="{{listError}}"') < template.indexOf('wx:elif="{{appointments.length === 0}}"'));
  assert.match(template, /wx:elif="{{moreError}}"[^]*?bindtap="retryAppointments"/);
  for (const field of ["serviceItems", "therapists"]) {
    assert.ok(template.indexOf(`wx:elif="{{${field}Error}}"`) < template.indexOf(`wx:elif="{{!${field}.length}}"`));
  }
  const admin = read("pages/admin/slot-appointment/index.wxml");
  assert.match(admin, /wx:elif="{{error}}"[^]*?bindtap="load"/);
  assert.match(admin, /busy="{{signing}}" bind:action="action"/);
  assert.match(read("components/appointment-card/index.wxml"), /data-type="uncheckIn" catchtap="action"/);
});

test("selectable inactive labels have 4.5:1 contrast and every page inherits or declares a white native navbar", () => {
  const css = read("pages/my-appointments/index.wxss");
  const hex = css.match(/\.filter-inactive \{ color:(#[\da-f]+);/i)[1];
  const luminance = (color) => color.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  assert.ok(1.05 / (luminance(hex) + 0.05) >= 4.5);
  const app = JSON.parse(read("app.json"));
  assert.equal(app.window.navigationBarBackgroundColor.toLowerCase(), "#ffffff");
  for (const page of app.pages) {
    const config = JSON.parse(read(`${page}.json`));
    const color = config.navigationBarBackgroundColor || app.window.navigationBarBackgroundColor;
    assert.ok(["#fff", "#ffffff"].includes(color.toLowerCase()), page);
  }
});
