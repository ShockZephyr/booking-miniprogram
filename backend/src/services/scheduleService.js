const db = require("../config/db");
const repository = require("../repositories/scheduleRepository");
const actors = require("./currentActorService");
const audits = require("./auditService");
const noShows = require("./noShowService");
const { AppError } = require("../utils/errors");
const { assertDateString, assertTimeString, toShanghaiInstant, todayString } = require("../utils/date");
const { maskPhone } = require("../utils/phone");
const { invalid, minutes, normalizeSchedule, availability, parseRosterFilters, expandFilterRange } = require("../utils/schedule");

const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const has = (object, key) => Object.hasOwn(object, key);
const weekday = value => Number.isInteger(value) && value >= 1 && value <= 7;
function fields(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    invalid("提交的排班设置字段无效");
  }
}

function ids(values, allowEmpty = false) {
  if (!Array.isArray(values) || (!values.length && !allowEmpty) || values.some(value => !uuid(value))) invalid("人员或项目选择无效");
  return [...new Set(values.map(value => value.toLowerCase()))].sort();
}

async function projects(values, client) {
  const selected = ids(values, true);
  if ((await repository.activeProjectIds(selected, client)).length !== selected.length) {
    throw new AppError("INVALID_SERVICE_ITEMS", "项目已停用或不存在，请重新选择", 409);
  }
  return selected;
}

async function therapist(id, client, lock) {
  if (!uuid(id)) invalid("芳疗师标识无效");
  const [row] = await repository.activeTherapists([id], client, lock);
  if (!row) throw new AppError("THERAPIST_NOT_FOUND", "芳疗师不存在或已停用", 404);
  return row;
}

async function calendar(date, client, allowOriginal = false) {
  if (!assertDateString(date)) throw new AppError("INVALID_DATE", "日期格式无效", 400);
  const { daysVisible } = await repository.settings(client);
  const today = todayString();
  const ahead = (Date.parse(date) - Date.parse(today)) / 86400000;
  if (ahead < 0 || (!allowOriginal && ahead >= daysVisible)) {
    throw new AppError("DATE_OUT_OF_RANGE", "日期已超出当前可预约范围", 409, { today, daysVisible });
  }
  return { date, today, daysVisible };
}

function presentDay(person, rule, period, occupied) {
  const busy = occupied.filter(row => row.therapistId === person.id || row.own)
    .map(({ startTime, endTime }) => ({ startTime, endTime }));
  return { ...period, ...rule, therapistId: person.id, therapistName: person.name,
    therapistBio: person.bio || "", therapistImageUrl: person.imageUrl || "",
    therapistTags: Array.isArray(person.tags) ? person.tags : [], busy };
}

async function dayFor({ therapistId, date, userId, appointmentId }, client, lock = false) {
  const person = await therapist(therapistId, client, lock);
  if (!assertDateString(date)) throw new AppError("INVALID_DATE", "日期格式无效", 400);
  if (appointmentId !== undefined && appointmentId !== null) {
    if (!uuid(appointmentId) || !userId || !await repository.ownOriginal(appointmentId, person.id, date, userId, client)) {
      throw new AppError("APPOINTMENT_NOT_FOUND", "没有可修改的本人预约", 404);
    }
  }
  const period = await calendar(date, client, !!appointmentId);
  const [rule] = await repository.rulesForDate([person.id], date, client);
  // Existing selections remain editable after removal from availability; this
  // scoped allowance is never exposed to another customer or a new booking.
  if (appointmentId) rule.serviceItemIds = [...new Set([...rule.serviceItemIds, ...await repository.originalProjectIds(appointmentId, client)])];
  const occupied = await repository.busy(date, [person.id], userId, appointmentId, client);
  return presentDay(person, rule, period, occupied);
}

// Call inside the authenticated booking transaction, after the identity lock.
const bookableDay = (input, client) => dayFor(input, client, true);
async function freezeDay(day, client) {
  await repository.freeze(day, client);
  return day;
}

async function read(user, handler) {
  return db.transaction(async client => {
    if (user) return handler(await actors.load({ user }, client), client);
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", [], client);
    return handler(null, client);
  });
}

const isStaff = actor => actor && (actor.role === "admin" || actor.therapistId);
const assignedId = actor => actor && actor.role !== "admin" && actor.therapistId;

async function list(date, user, query = {}) {
  const filtering = query.withFilters === "1" || ["serviceItemIds", "therapistIds", "startTime", "endTime"].some(key => has(query, key));
  const requested = filtering ? parseRosterFilters(query) : null;
  return read(user, async (actor, client) => {
    const period = await calendar(date, client);
    const assigned = assignedId(actor);
    const people = await repository.activeTherapists(assigned ? [assigned] : null, client);
    const personIds = people.map(person => person.id);
    const rules = await repository.rulesForDate(personIds, date, client);
    const byId = new Map(rules.map(rule => [rule.therapistId, rule]));
    const userId = actor && !isStaff(actor) ? actor.id : null;
    const occupied = await repository.busy(date, personIds, userId, null, client);
    const now = new Date();
    let candidates = people, appliedFilters, filterOptions, minDuration;
    if (filtering) {
      const projects = await repository.filterProjects(client);
      const activeIds = new Set(projects.map(item => item.id));
      // Catalog and effective date configurations are read in the same transaction.
      for (const rule of rules) rule.serviceItemIds = rule.serviceItemIds.filter(id => activeIds.has(id));
      const selection = (ids, options) => {
        const found = ids.filter(id => options.some(item => item.id === id));
        return found.length === options.length ? [] : found;
      };
      appliedFilters = { ...requested, serviceItemIds: selection(requested.serviceItemIds, projects),
        therapistIds: selection(requested.therapistIds, people) };
      candidates = people.filter(person => (!appliedFilters.therapistIds.length || appliedFilters.therapistIds.includes(person.id))
        && (!appliedFilters.serviceItemIds.length || byId.get(person.id).serviceItemIds.some(id => appliedFilters.serviceItemIds.includes(id))));
      const eligible = candidates.map(person => byId.get(person.id)).filter(rule => rule.ranges.length && rule.serviceItemIds.length);
      minDuration = eligible.length ? Math.min(...eligible.map(rule => rule.minDuration)) : null;
      Object.assign(appliedFilters, expandFilterRange(appliedFilters.startTime, appliedFilters.endTime, minDuration));
      const enabled = appliedFilters.serviceItemIds.length || appliedFilters.therapistIds.length
        || appliedFilters.startTime !== "00:00" || appliedFilters.endTime !== "23:59";
      if (enabled) candidates = candidates.filter(person => availability(presentDay(person, byId.get(person.id), period, occupied), now, appliedFilters) === "available");
      filterOptions = { projects, therapists: people.map(person => ({ id: person.id, name: person.name,
        serviceItemIds: byId.get(person.id).serviceItemIds, minDuration: byId.get(person.id).minDuration,
        hasSchedule: !!byId.get(person.id).ranges.length })) };
    }
    return { ...period, ...(filtering ? { filterOptions, appliedFilters, minDuration } : {}), therapists: candidates.map(person => ({
      id: person.id, name: person.name, bio: person.bio || "", imageUrl: person.imageUrl || "",
      tags: Array.isArray(person.tags) ? person.tags : [],
      status: availability(presentDay(person, byId.get(person.id), period, occupied), now)
    })) };
  });
}

async function detail(input, user) {
  if (isStaff(user)) await noShows.markNoShows();
  return read(user, async (actor, client) => {
    if (assignedId(actor) && assignedId(actor) !== input.therapistId) {
      throw new AppError("THERAPIST_NOT_FOUND", "无法查看该排班", 404);
    }
    const userId = actor && !isStaff(actor) ? actor.id : null;
    const day = await dayFor({ ...input, userId }, client);
    if (isStaff(actor)) {
      const rows = await repository.staffAppointments(day.therapistId, day.date, client);
      day.appointments = actor.role === "admin" ? rows : rows.map(item => ({
        ...item, userPhone: item.userPhone ? maskPhone(item.userPhone) : null
      }));
      if (actor.role === "admin") day.serverNowMs = Date.now();
    }
    return day;
  });
}

function admin(context, handler) {
  return db.transaction(async client => {
    await actors.load(context, client, { admin: true });
    return handler(client);
  });
}

function audit(context, action, resourceId, before, after, client) {
  return audits.record({ adminUserId: context.user.id, action, resourceType: "schedule", resourceId,
    before, after, requestId: context.requestId, ip: context.ip }, client);
}

const getSettings = context => admin(context, client => repository.settings(client));
async function setSettings(input, context) {
  fields(input, ["daysVisible"]);
  if (!Number.isInteger(input.daysVisible) || input.daysVisible < 1 || input.daysVisible > 2147483647) invalid("可见天数须为正整数");
  return admin(context, async client => {
    const before = await repository.settings(client);
    const result = await repository.setSettings(input.daysVisible, client);
    await audit(context, "update_schedule_settings", null, before, result, client);
    return result;
  });
}

async function getWeekly(id, day, context) {
  if (!weekday(day)) invalid("请选择有效星期");
  return admin(context, async client => {
    await therapist(id, client);
    return repository.weekly(id, day, client);
  });
}

async function putWeekly(input, context) {
  fields(input, ["therapistIds", "weekdays", "schedule", "serviceItemIds"]);
  const selected = ids(input.therapistIds);
  if (!Array.isArray(input.weekdays) || !input.weekdays.length || !input.weekdays.every(weekday)) invalid("请选择有效星期");
  const days = [...new Set(input.weekdays)].sort();
  const rule = has(input, "schedule") ? normalizeSchedule(input.schedule) : null;
  if (!rule && !has(input, "serviceItemIds")) invalid("请选择本次修改的内容");
  return admin(context, async client => {
    if ((await repository.activeTherapists(selected, client, true)).length !== selected.length) {
      throw new AppError("THERAPIST_NOT_FOUND", "所选芳疗师已停用或不存在", 409);
    }
    const items = has(input, "serviceItemIds") ? await projects(input.serviceItemIds, client) : null;
    const deferredDates = [];
    for (const id of selected) {
      for (const day of days) {
        const previous = await repository.weekly(id, day, client);
        const nextSchedule = rule || normalizeSchedule(previous);
        const next = { ...nextSchedule, serviceItemIds: items ?? previous.serviceItemIds };
        await repository.saveWeekly(id, day, next, client);
        deferredDates.push(...await repository.applyWeeklyToDates(id, day, next, client, { schedule: !!rule, projects: items !== null }));
      }
    }
    const result = { updated: selected.length * days.length, deferredDates };
    await audit(context, "update_weekly_schedules", null, null, { therapistIds: selected, weekdays: days, rule, serviceItemIds: items }, client);
    return result;
  });
}

// A single therapist may submit different rules for several weekdays. Keep the
// existing bulk-replacement endpoint separate, and commit all changed days once.
async function putWeeklyDays(id, input, context) {
  fields(input, ["days"]);
  if (!uuid(id)) invalid("芳疗师标识无效");
  if (!Array.isArray(input.days) || !input.days.length || input.days.length > 7
    || input.days.some(day => !day || !weekday(day.weekday))
    || new Set(input.days.map(day => day.weekday)).size !== input.days.length) invalid("请选择不重复的有效星期");
  const days = input.days.map(day => {
    try {
      fields(day, ["weekday", "schedule", "serviceItemIds"]);
      fields(day.schedule, ["step", "minDuration", "ranges"]);
      return { weekday: day.weekday, schedule: normalizeSchedule(day.schedule), serviceItemIds: ids(day.serviceItemIds, true) };
    } catch (error) {
      if (error instanceof AppError) error.message = "周" + "一二三四五六日"[day.weekday - 1] + "：" + error.message;
      throw error;
    }
  }).sort((a, b) => a.weekday - b.weekday);
  return admin(context, async client => {
    await therapist(id, client, true);
    // Validate all project references under the same transaction before writing.
    const allItems = [...new Set(days.flatMap(day => day.serviceItemIds))].sort();
    const active = new Set(await repository.activeProjectIds(allItems, client));
    for (const day of days) {
      if (day.serviceItemIds.some(item => !active.has(item))) {
        throw new AppError("INVALID_SERVICE_ITEMS", "周" + "一二三四五六日"[day.weekday - 1] + "：项目已停用或不存在，请重新选择", 409);
      }
    }
    const before = [], deferredDates = [];
    for (const day of days) {
      before.push({ weekday: day.weekday, ...await repository.weekly(id, day.weekday, client) });
      await repository.saveWeekly(id, day.weekday, { ...day.schedule, serviceItemIds: day.serviceItemIds }, client);
      deferredDates.push(...await repository.applyWeeklyToDates(id, day.weekday,
        { ...day.schedule, serviceItemIds: day.serviceItemIds }, client));
    }
    await audit(context, "update_weekly_schedule_days", id, before, days, client);
    return { updated: days.length, days, deferredDates };
  });
}

function cellChanges(value) {
  if (!Array.isArray(value) || !value.every(assertTimeString)) invalid("时间格选择无效");
  return [...new Set(value)];
}

function checkBulkCells(day, grid, selected, opening, occupied, now) {
  const conflict = () => new AppError("SCHEDULE_DAY_CHANGED", "当天排班已变化，请核对后重新确认", 409);
  if (day.step !== grid.step || day.ranges.length !== grid.ranges.length || day.ranges.some((range, i) =>
    range.startTime !== grid.ranges[i].startTime || range.endTime !== grid.ranges[i].endTime)) throw conflict();

  // Check the whole set under the therapist lock: valid individual cells alone cannot detect omitted cells.
  const remaining = new Set(selected.map(minutes));
  const closed = new Set(day.closed.map(minutes));
  const busy = occupied.map(row => [minutes(row.startTime), minutes(row.endTime)]);
  const elapsed = (now - toShanghaiInstant(day.date, "00:00")) / 60000;
  for (const range of day.ranges) {
    const limit = minutes(range.endTime);
    for (let start = minutes(range.startTime); start < limit; start += day.step) {
      const end = start + day.step;
      if (end <= elapsed || closed.has(start) !== opening || busy.some(([from, to]) => from < end && to > start)) continue;
      if (!remaining.delete(start)) throw conflict();
    }
  }
  if (remaining.size) throw conflict();
}

async function patchDay(id, input, context) {
  fields(input, ["date", "open", "close", "serviceItemIds", "expectedGrid", "expectedStep"]);
  let expectedGrid;
  if (has(input, "expectedGrid")) {
    if (has(input, "open") === has(input, "close") || has(input, "serviceItemIds")) invalid("一键操作只能开启或关闭时段");
    fields(input.expectedGrid, ["step", "ranges"]);
    const { step, ranges } = input.expectedGrid;
    expectedGrid = normalizeSchedule({ step, ranges, minDuration: step });
  }
  const open = cellChanges(has(input, "open") ? input.open : []);
  const close = cellChanges(has(input, "close") ? input.close : []);
  if (open.some(time => close.includes(time))) invalid("同一格不能同时关闭和开放");
  if (!open.length && !close.length && !has(input, "serviceItemIds")) invalid("请选择本次修改的内容");
  return admin(context, async client => {
    const day = await dayFor({ therapistId: id, date: input.date }, client, true);
    if (!expectedGrid && (open.length || close.length) && input.expectedStep !== day.step) {
      throw new AppError("SCHEDULE_DAY_CHANGED", "时间精度已变化，请刷新后重新选择时段", 409);
    }
    const occupied = await repository.busy(day.date, [day.therapistId], null, null, client, true);
    const items = has(input, "serviceItemIds") ? await projects(input.serviceItemIds, client) : day.serviceItemIds;
    const now = new Date();
    if (expectedGrid) {
      const opening = has(input, "open");
      checkBulkCells(day, expectedGrid, opening ? open : close, opening, occupied, now);
    } else {
      for (const time of [...open, ...close]) {
        if (minutes(time) % day.step || !day.ranges.some(range => range.startTime <= time && range.endTime > time)) {
          invalid("只能调整原排班内的完整时间格");
        }
        const start = minutes(time), end = start + day.step;
        if (toShanghaiInstant(day.date, time).getTime() + day.step * 60000 <= now.getTime()
          || occupied.some(row => minutes(row.startTime) < end && minutes(row.endTime) > start)) {
          throw new AppError("SCHEDULE_CELL_UNAVAILABLE", "所选时间格已结束或已被预约，请刷新", 409);
        }
      }
    }
    const closed = [...new Set([...day.closed.filter(time => !open.includes(time)), ...close])].sort();
    const next = { ...day, closed, serviceItemIds: items };
    if (JSON.stringify(closed) !== JSON.stringify(day.closed)
      || [...items].sort().join() !== [...day.serviceItemIds].sort().join()) {
      await freezeDay(day, client);
      await repository.updateDay(next, client, { open, close });
      await audit(context, "update_daily_schedule", day.therapistId,
        { date: day.date, closed: day.closed, serviceItemIds: day.serviceItemIds },
        { date: day.date, closed, serviceItemIds: items }, client);
    }
    return next;
  });
}

module.exports = { list, detail, getSettings, setSettings, getWeekly, putWeekly, putWeeklyDays, patchDay, bookableDay, freezeDay };
