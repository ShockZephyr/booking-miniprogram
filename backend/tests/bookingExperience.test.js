const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { setup, flush, plain } = require("./support/scheduleUI");
const root = path.join(__dirname, "../../miniprogram");
const source = file => fs.readFileSync(path.join(root, file), "utf8");
function setData(patch) { Object.assign(this.data, patch); }

test("roster exposes available, full and off therapists as one accessible list on the selected date", async () => {
  const h = setup(); h.deps.schedules.list = async date => ({ today: h.day.today, daysVisible: 7,
    therapists: ["available", "full", "off"].map((status,index) => ({ id: "t" + index, name: "人员" + index,
      bio: "人员简介", imageUrl: "/uploads/therapists/portrait.png", tags: ["项目甲", "项目乙", "项目丙"], status })) });
  const page = h.page("pages/booking"); page.onLoad(); await page.onShow();
  assert.deepEqual(plain(page.data.therapists.map(t => t.label)), ["可预约", "暂无可约时段", "当天休息"]);
  assert.equal(page.data.therapists[0].bio, "人员简介");
  assert.deepEqual(plain(page.data.therapists[0].tags), ["项目甲", "项目乙", "项目丙"]);
  assert.equal(page.data.therapists[0].imageSrc,
    require("../../miniprogram/config/env").API_BASE_URL + "/uploads/therapists/portrait.png");
  page.changeDate({ detail: { date: "2026-11-01" } }); await flush();
  page.openDay({ detail: { therapist: page.data.therapists[2] } });
  assert.match(h.calls.find(c => c[0] === "navigate")[1].url, /therapistId=t2&date=2026-11-01&from=booking&returnId=\d+$/);
  const navigations = () => h.calls.filter(c => c[0] === "navigate").length;
  page.openDay({ detail: { therapist: { id: "removed-person" } } });
  assert.equal(navigations(), 1);
  h.app._loginSessionVersion += 1;
  page.openDay({ detail: { therapist: page.data.therapists[0] } });
  assert.equal(navigations(), 1, "an old card cannot navigate after the login session changes");

  const styles = source("components/therapist-card/index.wxss");
  assert.match(styles, /\.availability \{[^}]*font-weight:700;/s);
  assert.match(styles, /\.availability\.available \{[^}]*color:#2b854a;/s);
  assert.match(styles, /\.availability\.off \{[^}]*color:#9a6600;/s);
});

test("a personal schedule returns its selected date to the booking roster in the same login session", async () => {
  const h = setup(), requestedDates = [], list = h.deps.schedules.list;
  h.deps.schedules.list = async date => { requestedDates.push(date); return list(date); };
  const roster = h.page("pages/booking");
  roster.onLoad(); await roster.onShow();
  roster.openDay({ detail: { therapist: roster.data.therapists[0] } });
  const navigation = h.calls.find(call => call[0] === "navigate")[1];
  assert.equal(typeof navigation.events.dateChange, "function");
  roster.onHide();

  const detail = h.page("pages/schedule-day");
  detail.getOpenerEventChannel = () => ({ emit: (name, payload) => navigation.events[name](payload) });
  detail.onLoad(Object.fromEntries(new URLSearchParams(navigation.url.split("?")[1])));
  await detail.onShow();
  detail.setData({ first: h.day.today, last: "2026-11-05" });
  detail.changeDate({ detail: { date: "2026-11-02" } });
  assert.equal(roster.data.selectedDate, h.day.today, "a hidden roster does not switch its date ahead of its data");

  detail.onHide(); detail.onUnload(); await roster.onShow();
  assert.equal(roster.data.selectedDate, "2026-11-02");
  assert.equal(requestedDates.at(-1), "2026-11-02", "the roster reloads the returned date");
});

test("a personal schedule synchronizes its date and roster even when the opener event channel is unavailable", async () => {
  const h = setup(), requestedDates = [], list = h.deps.schedules.list;
  h.deps.schedules.list = async date => { requestedDates.push(date); return list(date); };
  const roster = h.page("pages/booking");
  roster.onLoad(); await roster.onShow();
  roster.changeDate({ detail: { date: "2026-11-02" } }); await flush();
  roster.openDay({ detail: { therapist: roster.data.therapists[0] } });
  const firstNavigation = h.calls.find(call => call[0] === "navigate")[1];
  assert.match(firstNavigation.url, /date=2026-11-02&from=booking&returnId=\d+$/);
  roster.onHide();

  const detail = h.page("pages/schedule-day");
  detail.getOpenerEventChannel = () => { throw new Error("event channel unavailable"); };
  detail.onLoad(Object.fromEntries(new URLSearchParams(firstNavigation.url.split("?")[1])));
  await detail.onShow();
  detail.setData({ first: h.day.today, last: "2026-11-05" });
  detail.changeDate({ detail: { date: "2026-11-04" } });

  detail.onHide(); detail.onUnload(); await roster.onShow();
  assert.equal(roster.data.selectedDate, "2026-11-04");
  assert.equal(requestedDates.at(-1), "2026-11-04", "the returned date reloads the matching therapist roster");
  roster.openDay({ detail: { therapist: roster.data.therapists[0] } });
  assert.match(h.calls.filter(call => call[0] === "navigate").at(-1)[1].url, /date=2026-11-04&from=booking&returnId=\d+$/);
});

test("a stale personal-schedule date event cannot alter another login or an unloaded roster", async () => {
  const h = setup(), roster = h.page("pages/booking");
  roster.onLoad(); await roster.onShow();
  roster.openDay({ detail: { therapist: roster.data.therapists[0] } });
  const callback = h.calls.find(call => call[0] === "navigate")[1].events.dateChange;
  h.app._loginSessionVersion += 1;
  callback({ date: "2026-11-02" });
  assert.equal(roster.data.selectedDate, h.day.today);

  h.app._loginSessionVersion -= 1;
  roster.onUnload();
  callback({ date: "2026-11-02" });
  assert.equal(roster.data.selectedDate, h.day.today);
});

test("a returned personal-schedule date cannot cross a login-session boundary", async () => {
  const h = setup(), roster = h.page("pages/booking");
  roster.onLoad(); await roster.onShow();
  roster.openDay({ detail: { therapist: roster.data.therapists[0] } });
  const navigation = h.calls.find(call => call[0] === "navigate")[1];
  navigation.events.dateChange({ date: "2026-11-04" });
  roster.onHide();
  h.app._loginSessionVersion += 1;
  h.app.globalData.token = "next-session";
  await roster.onShow();
  assert.equal(roster.data.selectedDate, h.day.today);
  assert.equal(h.app._bookingDateNavigation, null);
});

test("booking card previews limit long biographies, preserve the source and clear a reused empty biography", () => {
  let definition;
  vm.runInNewContext(source("components/therapist-card/index.js"), {
    Component: value => { definition = value; },
    require: () => require("../../miniprogram/utils/imageFallback")
  });
  const card = { data: plain(definition.data), setData, ...definition.methods };
  const preview = value => definition.observers["therapist.bio"].call(card, value);
  preview("  简介\n\t内容  "); assert.equal(card.data.bioPreview, "简介 内容");
  preview("中".repeat(30)); assert.equal(card.data.bioPreview, "中".repeat(30));
  const biography = "中".repeat(29) + "😀" + "不应显示的后续文字";
  card.data.therapist = { id: "person", bio: biography };
  preview(biography);
  assert.equal(card.data.bioPreview, "中".repeat(29) + "😀......");
  assert.equal(card.data.therapist.bio, biography);
  let selected;
  card.triggerEvent = (name, detail) => { selected = { name, detail }; };
  card.tap();
  assert.equal(selected.name, "select");
  assert.equal(selected.detail.therapist, card.data.therapist);
  for (const missing of ["", undefined, null, " \n "]) {
    preview(missing); assert.equal(card.data.bioPreview, "");
  }
  assert.equal(definition.properties.variant.value, "catalog", "existing catalog cards keep their default variant");

  const template = source("components/therapist-card/index.wxml");
  const styles = source("components/therapist-card/index.wxss");
  assert.match(template, /class="booking-heading"[^]*?class="name"[^]*?class="status-divider"[^>]*>·<\/text>[^]*?class="availability \{\{therapist\.status\}\}"/);
  assert.match(template, /class="bio"[^]*?class="tags booking-tags"[^]*?wx:if="\{\{index < 2\}\}"/);
  assert.match(styles, /\.booking-heading \{[^}]*justify-content:flex-start;[^}]*gap:8rpx;/s);
  assert.match(styles, /\.booking \.name \{[^}]*flex:0 1 auto;/s);
  assert.match(styles, /\.bio \{[^}]*height:76rpx;[^}]*-webkit-line-clamp:2;/s);
  assert.match(styles, /\.booking-tags \{[^}]*white-space:nowrap;/s);
});

test("an existing booking's date stays fixed and accessible after the browse window shrinks", async () => {
  const h = setup(), page = h.page("pages/schedule-day"); h.day.daysVisible = 1;
  page.onLoad({ therapistId: h.day.therapistId, appointmentId: h.record.id, date: "2026-11-14" });
  await page.onShow(); await page.windowLoaded({ detail: h.day });
  assert.equal(page.data.first, page.data.last); assert.equal(page.data.first, "2026-11-14");
  page.changeDate({ detail: { date: h.day.today } }); page.openCalendar();
  assert.equal(page.data.target.date, "2026-11-14"); assert.equal(page.data.calendarVisible, false);
});

test("calendar covers the visible date window without generating a potentially unbounded number of days", () => {
  const dates = require("../../miniprogram/utils/date");
  const first = "2026-10-30", last = "9999-12-31";
  const months = dates.buildCalendarMonths(first, first, last);
  assert.ok(months.length <= 6);
  assert.equal(months[0].days.find(d => d.date === "2026-10-29").disabled, true);
  assert.ok(dates.buildDateStrip(first, first, last).length <= 21);
  assert.deepEqual(dates.buildDateStrip(first, first, "2026-11-01").map(d => d.date), ["2026-10-30", "2026-10-31", "2026-11-01"]);
});

test("project details enter the roster; therapist details directly open today's personal schedule", () => {
  const h = setup(); const project = h.page("pages/project-detail"), therapist = h.page("pages/therapist-detail");
  h.wx.switchTab = options => h.calls.push(["tab", options]); project.data.item = { id: "p" };
  project.book(); assert.equal(h.calls.at(-1)[1].url, "/pages/booking/index"); assert.equal(h.storage.size, 0);
  therapist.data.therapist = { id: h.day.therapistId }; therapist.book();
  assert.match(h.calls.at(-1)[1].url, /schedule-day\/index\?therapistId=/);
  assert.ok(h.calls.at(-1)[1].url.endsWith("date=" + h.day.today));
});

function dateStrip() {
  let definition;
  const pending = [], ticks = [];
  vm.runInNewContext(source("components/date-strip/index.js"), {
    Component: (value) => { definition = value; },
    require: () => require("../../miniprogram/utils/date"),
    wx: { nextTick: (callback) => ticks.push(callback), createSelectorQuery: () => {
      const selectors = [];
      return { in() { return this; }, select(value) { selectors.push(value); return this; },
        selectAll(value) { selectors.push(value); return this; }, boundingClientRect() { return this; },
        exec(callback) {
          assert.deepEqual(selectors, [".date-scroll", ".date-item"]);
          pending.push(callback);
        } };
    } }
  });
  const component = { ...definition.methods, data: plain(definition.data),
    properties: { selected: "2999-01-01", statusMap: {}, hideDots: false }, setData };
  component.rebuildDates();
  return { component, definition, pending, render: () => { while (ticks.length) ticks.shift()(); } };
}

test("date-strip text, highlight and accessibility state share the same selected date after returning", () => {
  const { component, definition } = dateStrip();
  component.properties.first = "2026-10-31";
  component.properties.last = "2026-11-06";
  for (const date of ["2026-10-31", "2026-11-02", "2026-10-31", "2026-10-31"]) {
    component.properties.selected = date;
    definition.properties.selected.observer.call(component);
    definition.pageLifetimes.show.call(component);
    const active = component.data.visibleDates.filter(item => item.selected);
    assert.equal(active.length, 1);
    assert.equal(active[0].date, date);
    assert.match(active[0].accessibilityLabel, /已选择/);
    assert.ok(component.data.visibleDates.filter(item => !item.selected).every(item => !item.accessibilityLabel.includes("已选择")));
  }
  assert.match(source("components/date-strip/index.wxml"), /item\.selected \? 'active'/);
});

test("selected date centers using actual geometry at narrow, standard, wide and tablet widths", () => {
  for (const width of [320, 375, 390, 430, 768]) {
    for (const existingScroll of [0, 230]) {
      const { component, pending, render } = dateStrip();
      render();
      const viewport = { left: 16, width: Math.min(width, 520) - 100 };
      const step = 52 + 8 * width / 750;
      const items = component.data.visibleDates.map((_, index) => ({ left: 16 - existingScroll + index * step, width: 52 }));
      pending.shift()([viewport, items]);
      const selectedCenter = viewport.left + 10 * step + 26 - component.data.scrollLeft;
      assert.ok(Math.abs(selectedCenter - (viewport.left + viewport.width / 2)) < 0.001,
        `selected date must be centered at ${width}px regardless of previous scroll`);
    }
  }
});

test("date measurement ignores stale queries, missing geometry and detached instances; resize remeasures", () => {
  const { component, definition, pending, render } = dateStrip();
  render();
  component.properties.selected = "2999-01-02";
  component.rebuildDates(); render();
  const rows = Array.from({ length: 21 }, (_, index) => ({ left: index * 60, width: 52 }));
  pending[1]([{ width: 200 }, rows]);
  const current = component.data.scrollLeft;
  pending[0]([{ width: 500 }, rows]);
  assert.equal(component.data.scrollLeft, current);
  definition.pageLifetimes.resize.call(component); render();
  pending[2]([{ width: 400 }, rows]);
  assert.equal(component.data.scrollLeft, current - 100);
  component.centerSelected(); render();
  const before = component.data.scrollLeft;
  pending[3]([null, []]);
  assert.equal(component.data.scrollLeft, before);
  component.centerSelected(); render();
  definition.lifetimes.detached.call(component);
  pending[4]([{ width: 100 }, rows]);
  assert.equal(component.data.scrollLeft, before);
});
