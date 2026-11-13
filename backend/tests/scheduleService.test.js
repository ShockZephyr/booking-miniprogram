process.env.NODE_TEST_CONTEXT = "1";
process.env.DATABASE_URL = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { normalizeSchedule, availability } = require("../src/utils/schedule");

const range = (startTime, endTime) => ({ startTime, endTime });
test("weekly groups merge only adjacent aligned intervals and enforce each day's last grid point", () => {
  for (const [step, last] of [[10, "23:50"], [15, "23:45"], [30, "23:30"]]) {
    const normalize = ranges => normalizeSchedule({ step, minDuration: 90, ranges }).ranges;
    assert.deepEqual(normalize([range("13:00", last), range("11:00", "12:00"), range("09:00", "11:00")]),
      [range("09:00", "12:00"), range("13:00", last)]);
    assert.throws(() => normalize([range("09:00", "12:00"), range("11:00", "14:00")]), { code: "INVALID_SCHEDULE" });
    assert.throws(() => normalize([range("21:00", "23:59")]), { code: "INVALID_SCHEDULE" });
    assert.throws(() => normalizeSchedule({ step, minDuration: step + 1, ranges: [] }), { code: "INVALID_SCHEDULE" });
    assert.throws(() => normalizeSchedule({ step, minDuration: 0, ranges: [] }), { code: "INVALID_SCHEDULE" });
  }
});

test("display availability includes the current grid through its last second and respects breaks, bookings and projects", () => {
  const day = { date: "2026-10-31", step: 30, minDuration: 90, ranges: [range("09:00", "11:00")],
    serviceItemIds: ["item"], closed: ["10:30"], busy: [] };
  const at = time => new Date(`${day.date}T${time}+08:00`);
  assert.equal(availability(day, at("09:29:59")), "available");
  assert.equal(availability(day, at("09:30:00")), "full");
  assert.equal(availability({ ...day, closed: [], busy: [range("09:00", "09:30")] }, at("09:30:00")), "available");
  assert.equal(availability({ ...day, closed: [], busy: [range("09:30", "10:00")] }, at("09:00:00")), "full");
  assert.equal(availability({ ...day, ranges: [] }, at("09:00:00")), "off");
  assert.equal(availability({ ...day, serviceItemIds: [] }, at("09:00:00")), "full");
});

test("weekly schedule minimum applies to merged continuous groups and still permits an explicit rest day", async () => {
  for (const step of [10, 15, 30]) {
    const rule = ranges => ({ step, minDuration: 90, ranges });
    const tooShort = rule([range("09:00", "10:00")]);
    assert.throws(() => normalizeSchedule(tooShort), { code: "INVALID_SCHEDULE", status: 400 });
    assert.deepEqual(normalizeSchedule(rule([range("10:00", "10:30"), range("09:00", "10:00")])).ranges,
      [range("09:00", "10:30")]);
    assert.throws(() => normalizeSchedule(rule([range("09:00", "10:00"), range("10:30", "11:00")])), { code: "INVALID_SCHEDULE" });
    assert.deepEqual(normalizeSchedule(rule([])).ranges, []);
    assert.deepEqual(normalizeSchedule(rule([range("09:00", "10:30")])).ranges, [range("09:00", "10:30")]);
    // The real service rejects this payload before it opens a transaction or writes any templates.
    await assert.rejects(require("../src/services/scheduleService").putWeekly({
      therapistIds: ["10000000-0000-4000-8000-000000000001"], weekdays: [1], schedule: tooShort, serviceItemIds: []
    }, {}), { code: "INVALID_SCHEDULE", status: 400 });
  }
});

test("full replacement validates the new rule while legacy partial updates cannot preserve an invalid short schedule", async () => {
  const id = "10000000-0000-4000-8000-000000000001", writes = [], client = {};
  let previous = {step:10,minDuration:90,ranges:[range("09:10","10:10")],serviceItemIds:[]};
  const repository = {
    activeTherapists: async () => [{id}], activeProjectIds: async () => [],
    weekly: async () => previous, applyWeeklyToDates: async () => [],
    saveWeekly: async (person, day, rule, tx) => { assert.equal(tx,client); writes.push(JSON.parse(JSON.stringify(rule))); }
  };
  const dependencies = {
    "../config/db": {transaction: async fn => fn(client)},
    "../repositories/scheduleRepository": repository,
    "./currentActorService": {load: async () => ({role:"admin"})},
    "./auditService": {record: async () => {}}, "./noShowService": {},
    "../utils/errors": require("../src/utils/errors"), "../utils/date": require("../src/utils/date"),
    "../utils/phone": require("../src/utils/phone"), "../utils/schedule": require("../src/utils/schedule")
  };
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../src/services/scheduleService.js"),"utf8"), {module, require:name=>dependencies[name]});
  const targets = {therapistIds:[id],weekdays:[1],serviceItemIds:[]}, context = {user:{id:"admin"}};
  await assert.rejects(module.exports.putWeekly(targets,context), {code:"INVALID_SCHEDULE"});
  assert.equal(writes.length,0);
  const schedule = {step:30,minDuration:90,ranges:[range("09:00","12:00")]};
  await module.exports.putWeekly({...targets,schedule},context);
  assert.deepEqual(writes[0], {...schedule,serviceItemIds:[]}, "old 09:10 values do not participate in full replacement validation");
  previous = {...schedule,serviceItemIds:[]};
  await module.exports.putWeekly(targets,context);
  assert.deepEqual(writes[1], {...schedule,serviceItemIds:[]});
});

test("booking roster exposes public portraits and biographies without account fields for every identity", async () => {
  const people = [
    { id: "first", name: "测试芳疗师甲", bio: "用于展示的简介", imageUrl: "/uploads/therapists/synthetic.png",
      tags: ["芳香护理", "深度放松"], phone: "synthetic-private-phone", userId: "private-account", openid: "private-openid" },
    { id: "second", name: "测试芳疗师乙", bio: null, imageUrl: null }
  ];
  for (const actor of [null, { id: "customer", role: "user" }, { id: "admin", role: "admin" },
    { id: "worker", role: "user", therapistId: "first" }, { id: "owner", role: "admin", therapistId: "first" }]) {
    const calls = {}, client = {}, date = "2999-01-01";
    const repository = {
      settings: async tx => { assert.equal(tx, client); return { daysVisible: 7 }; },
      activeTherapists: async (ids, tx) => {
        assert.equal(tx, client); calls.ids = ids;
        return ids ? people.filter(person => ids.includes(person.id)) : people;
      },
      rulesForDate: async ids => ids.map(therapistId => ({ therapistId, step: 30, minDuration: 90,
        ranges: [range("09:00", "12:00")], closed: [], serviceItemIds: ["project"] })),
      busy: async (day, ids, userId) => { assert.equal(day, date); calls.customerId = userId; return []; }
    };
    const module = { exports: {} };
    const dependencies = {
      "../config/db": { transaction: async fn => fn(client), query: async () => ({ rows: [] }) },
      "../repositories/scheduleRepository": repository,
      "./currentActorService": { load: async (context, tx) => { assert.equal(tx, client); return actor; } },
      "./auditService": {}, "./noShowService": {},
      "../utils/errors": require("../src/utils/errors"),
      "../utils/date": { ...require("../src/utils/date"), todayString: () => date },
      "../utils/phone": require("../src/utils/phone"),
      "../utils/schedule": require("../src/utils/schedule")
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/services/scheduleService.js"), "utf8"), {
      module, require: name => {
        assert.ok(Object.hasOwn(dependencies, name), "unexpected service dependency");
        return dependencies[name];
      }
    });
    const result = JSON.parse(JSON.stringify(await module.exports.list(date, actor)));
    const assigned = actor && actor.role !== "admin" && actor.therapistId;
    assert.deepEqual(calls.ids && Array.from(calls.ids), assigned ? ["first"] : null);
    assert.equal(calls.customerId, actor && actor.role === "user" && !actor.therapistId ? actor.id : null);
    assert.deepEqual(result.therapists, (assigned ? people.slice(0, 1) : people).map(person => ({
      id: person.id, name: person.name, bio: person.bio || "", imageUrl: person.imageUrl || "",
      tags: person.tags || [], status: "available"
    })));
  }
});

test("day detail exposes the public profile and limits customer contact details by staff identity", async () => {
  const therapistId = "10000000-0000-4000-8000-000000000001", date = "2999-01-01", client = {};
  const person = { id: therapistId, name: "测试芳疗师", bio: "公开简介", imageUrl: "/uploads/therapists/synthetic.png",
    tags: ["舒缓芳香护理", "深度放松课程"], phone: "private-therapist-phone", userId: "private-account" };
  const row = { id: "20000000-0000-4000-8000-000000000002", status: "booked", serviceItemName: "测试项目",
    startTime: "09:00", endTime: "10:30", userNickname: "测试用户", whitelistRemarkName: "测试会员",
    userPhone: "13800138000", note: "测试备注" };
  let noShows = 0;
  const repository = {
    settings: async () => ({ daysVisible: 7 }),
    activeTherapists: async ids => { assert.deepEqual(Array.from(ids), [therapistId]); return [person]; },
    rulesForDate: async () => [{ therapistId, step: 30, minDuration: 90, ranges: [range("09:00", "12:00")],
      closed: [], serviceItemIds: ["project"] }],
    busy: async () => [],
    staffAppointments: async () => [row]
  };
  const module = { exports: {} };
  const dependencies = {
    "../config/db": { transaction: async fn => fn(client), query: async () => ({ rows: [] }) },
    "../repositories/scheduleRepository": repository,
    "./currentActorService": { load: async ({ user }) => user },
    "./auditService": {}, "./noShowService": { markNoShows: async () => { noShows++; } },
    "../utils/errors": require("../src/utils/errors"),
    "../utils/date": { ...require("../src/utils/date"), todayString: () => date },
    "../utils/phone": require("../src/utils/phone"),
    "../utils/schedule": require("../src/utils/schedule")
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/services/scheduleService.js"), "utf8"), {
    module, require: name => dependencies[name]
  });
  const beforeRead = Date.now();
  const admin = JSON.parse(JSON.stringify(await module.exports.detail({ therapistId, date }, { id: "admin", role: "admin" })));
  assert.ok(Number.isSafeInteger(admin.serverNowMs) && admin.serverNowMs >= beforeRead && admin.serverNowMs <= Date.now());
  assert.equal(admin.therapistBio, person.bio);
  assert.equal(admin.therapistImageUrl, person.imageUrl);
  assert.deepEqual(admin.therapistTags, person.tags);
  assert.equal(admin.phone, undefined);
  assert.equal(admin.userId, undefined);
  assert.equal(admin.appointments[0].userPhone, row.userPhone);
  assert.equal(admin.appointments[0].note, row.note);

  const staff = JSON.parse(JSON.stringify(await module.exports.detail({ therapistId, date }, {
    id: "staff", role: "user", therapistId
  })));
  assert.equal(staff.appointments[0].userPhone, "138****8000");
  assert.equal(noShows, 2);
});
