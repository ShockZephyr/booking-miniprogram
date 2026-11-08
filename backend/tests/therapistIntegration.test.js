const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

test("therapist lifecycle, real PostgreSQL constraints and concurrent booking", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  process.env.NODE_TEST_CONTEXT = "1";
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, "An explicit isolated TEST_DATABASE_URL is required");
  const target = new URL(connectionString);
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.port, "55483");
  assert.equal(target.pathname, "/booking_audit");
  process.env.DATABASE_URL = "";
  const imageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "booking-images-test-"));
  process.env.THERAPIST_UPLOAD_DIR = imageDirectory;
  process.env.BOOKING_ENV_FILE = path.join(imageDirectory, "empty.env");
  fs.writeFileSync(process.env.BOOKING_ENV_FILE, "");
  process.env.JWT_SECRET = "isolated-test-session-only";
  process.env.LOG_LEVEL = "silent";
  const { Pool } = require("pg");
  const schema = `booking_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^booking_test_[a-f0-9]{32}$/);
  const root = new Pool({ connectionString, connectionTimeoutMillis:5000 });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema},public`, connectionTimeoutMillis:5000 });
  const db = require("../src/config/db");
  const old = { query: db.query, transaction: db.transaction };
  const audits = require("../src/services/auditService");
  const oldAudit = audits.record;
  audits.record = async () => {};
  db.query = (sql, params = [], client) => (client || pool).query(sql, params);
  db.transaction = async (fn) => {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  };
  try {
    await root.query(`CREATE SCHEMA ${schema}`);
    const dir = path.join(__dirname, "../migrations");
    await db.transaction(async (client) => {
      for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
        await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
      }
    });
    const therapistService = require("../src/services/therapistService");
    const images = require("../src/services/therapistImageService");
    const schedules = require("../src/services/scheduleService");
    let checkInNow;
    const appointments = require("../src/services/appointmentService").createAppointmentService({
      transaction: db.transaction,
      logService: { business: async () => {} }, auditService: { record: async () => {} },
      now: () => checkInNow || new Date()
    });
    const { rows: [user] } = await pool.query("INSERT INTO users(openid,phone,role) VALUES ('test','13000000001','admin') RETURNING *");
    const context = { user };
    const { todayString } = require("../src/utils/date");
    const date = todayString(new Date(Date.now() + 86400000));
    const weekday = new Date(date).getUTCDay() || 7;
    const template = { step: 30, minDuration: 90, ranges: [{ startTime: "09:00", endTime: "17:00" }] };
    const booking = (person, project, startTime = "09:00", endTime = "10:30") => ({
      date, therapistId: person.id, serviceItemId: project, startTime, endTime
    });
    const { rows: [customer] } = await pool.query("INSERT INTO users(openid,phone,role) VALUES ('customer','13900000001','user') RETURNING *");
    await pool.query("INSERT INTO member_whitelist(phone,status) VALUES ('13900000001','active')");
    const customerContext = { user: customer };
    const { rows: projects } = await pool.query("SELECT id, name FROM service_items WHERE status='active' ORDER BY id LIMIT 2");
    assert.equal(projects.length, 2);
    const item = projects[0].id, other = projects[1].id;
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=";
    const uploaded = await images.upload(png);
    const payload = { name: "测试芳疗师甲", phone: "13000000001", bio: "测试简介", serviceItemIds: [item, other], ...uploaded };
    const payloadB = { ...payload, phone: "13100000001", name: "测试芳疗师乙" };
    const a = await therapistService.save(null, payload, context);
    const b = await therapistService.save(null, payloadB, context);
    assert.equal(a.userId, user.id);
    const relinked = await db.transaction((client) => therapistService.linkUserForPhone(payload.phone, {
      id: user.id, phone: user.phone, role: user.role
    }, client));
    assert.equal(relinked.therapist.id, a.id);
    assert.equal((await pool.query("SELECT role FROM users WHERE id=$1", [user.id])).rows[0].role, "admin");
    await assert.rejects(
      () => appointments.createAppointment(booking(a, item), context),
      { code: "BOOKING_NOT_ALLOWED" }
    );
    await therapistService.save(a.id, { ...payload, name: "甲更新" }, context);
    assert.equal((await therapistService.active(a.id)).name, "甲更新");
    const orphan = await images.upload(png);
    const cleanup = require("../src/services/imageCleanupService");
    const firstSeen = new Date("2026-01-01T00:00:00.000Z");
    assert.equal((await cleanup.cleanupOrphans({ now: firstSeen, retentionHours: 24 })).deleted, 0);
    assert.equal((await cleanup.cleanupOrphans({ now: new Date("2026-01-01T23:00:00.000Z"), retentionHours: 24 })).deleted, 0);
    assert.equal((await cleanup.cleanupOrphans({ now: new Date("2026-01-02T01:00:00.000Z"), retentionHours: 24 })).deleted, 1);
    await assert.rejects(() => fs.promises.access(path.join(imageDirectory, path.basename(orphan.imageUrl))));
    await schedules.putWeekly({ therapistIds: [a.id, b.id], weekdays: [weekday],
      schedule: template, serviceItemIds: [item, other] }, context);
    const { rows: [futureCustomer] } = await pool.query("INSERT INTO users(openid,phone,role) VALUES ('future-customer','13200000001','user') RETURNING *");
    await pool.query("INSERT INTO member_whitelist(phone,status) VALUES ('13200000001','active')");
    const binding = booking(b, item);
    const bindingAppointment = await appointments.createAppointment(binding, { user: futureCustomer });
    const c = await therapistService.save(null, { ...payload, phone: "13200000001", name: "测试芳疗师丙" }, context);
    assert.equal(c.userId, futureCustomer.id);
    assert.equal(c.cancelledAppointments, 1);
    assert.equal((await pool.query("SELECT status FROM appointments WHERE id=$1", [bindingAppointment.id])).rows[0].status, "cancelled");
    const accessService = require("../src/services/accessService");
    const linkedCustomer = await accessService.enrichUser({ id: futureCustomer.id, phone: futureCustomer.phone, role: "user" });
    assert.equal(linkedCustomer.therapistId, c.id);
    await assert.rejects(
      () => appointments.createAppointment(binding, { user: linkedCustomer }),
      { code: "BOOKING_NOT_ALLOWED" }
    );
    await therapistService.remove(c.id, context);
    assert.equal((await therapistService.recycleBin()).some((therapist) => therapist.id === c.id), true);
    const restoredTherapist = await therapistService.restore([c.id], context);
    assert.equal(restoredTherapist.restored, 1);
    assert.equal((await therapistService.list()).at(-1).id, c.id);
    await therapistService.remove(c.id, context);
    assert.equal((await therapistService.purge([c.id], context)).purged, 1);
    const purgedTherapist = (await pool.query('SELECT name,phone,user_id,image_url,purged_at FROM therapists WHERE id=$1',[c.id])).rows[0];
    assert.equal(purgedTherapist.name,'已永久删除芳疗师');
    assert.equal(purgedTherapist.phone,null);
    assert.equal(purgedTherapist.user_id,null);
    assert.equal(purgedTherapist.image_url,'');
    assert.ok(purgedTherapist.purged_at);

    // Two different therapists cannot be booked by the same member at the same time.
    const results = await Promise.allSettled([a, b].map(person => appointments.createAppointment(booking(person, item), customerContext)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.ok(["APPOINTMENT_CONFLICT"].includes(results.find((result) => result.status === "rejected").reason.code));
    const booked = results.find((result) => result.status === "fulfilled").value;
    assert.ok(booked.therapistName);
    // Portal reads now revalidate a real bound account, not a caller-supplied ID.
    const { rows: [therapistBUser] } = await pool.query(
      "INSERT INTO users(openid,phone,role) VALUES ('portal-therapist-b',$1,'user') RETURNING *", [payloadB.phone]);
    await db.transaction(client => therapistService.linkUserForPhone(payloadB.phone, therapistBUser, client));
    const portalUser = async (therapistId) => accessService.enrichUser(
      await require("../src/repositories/userRepository").findById(therapistId === a.id ? user.id : therapistBUser.id));
    const therapistPortal = require("../src/services/therapistPortalService").createTherapistPortalService({ appointmentService: appointments });
    const detail = await therapistPortal.appointment(booked.id, await portalUser(booked.therapistId));
    assert.equal(detail.appointment.id, booked.id);
    assert.equal(detail.appointment.userPhone, "139****0001");
    const otherTherapist = booked.therapistId === a.id ? b : a;
    await assert.rejects(
      async () => therapistPortal.appointment(booked.id, await portalUser(otherTherapist.id)),
      { code: "APPOINTMENT_NOT_FOUND" }
    );
    await assert.rejects(() => schedules.patchDay(booked.therapistId, { date, serviceItemIds: [other] }, context),
      { code: "SCHEDULE_PROJECT_IN_USE" });
    await schedules.patchDay(booked.therapistId, { date, serviceItemIds: [item] }, context);
    await assert.rejects(() => therapistService.remove(booked.therapistId, context), { code: "THERAPIST_HAS_APPOINTMENTS" });
    checkInNow = new Date(`${booked.date}T${booked.startTime}:00+08:00`);
    await appointments.checkInAppointment(booked.id, customerContext);
    await assert.rejects(() => schedules.patchDay(booked.therapistId, { date, expectedStep: 30, close: ["09:00"] }, context),
      { code: "SCHEDULE_CELL_UNAVAILABLE" });
    checkInNow = undefined;
    await appointments.uncheckInAppointment(booked.id, context, { admin: true });
    await appointments.cancelAppointment(booked.id, customerContext);
    await therapistService.remove(a.id, context);
    assert.equal((await therapistService.list()).some(person => person.id === a.id), false);
    assert.deepEqual((await pool.query("SELECT ranges FROM weekly_schedules WHERE therapist_id=$1", [a.id])).rows[0].ranges, []);
    assert.equal((await pool.query("SELECT status FROM appointments WHERE id=$1", [booked.id])).rows[0].status, "cancelled");

    const catalog = require('../src/services/projectService');
    const projectInput = {name:'新护理项目',durationMinutes:60,effect:'放松',priceFen:19850,description:'项目介绍',...uploaded};
    const project = await catalog.save(null,projectInput,context);
    assert.equal((await catalog.list()).at(-1).id,project.id);
    assert.equal(project.priceFen,19850);
    await assert.rejects(()=>catalog.save(null,{...projectInput,name:'无效价格',priceFen:1.5},context),{code:'INVALID_PROJECT'});
    await assert.rejects(()=>catalog.reorder([project.id],context),{code:'PROJECT_LIST_CHANGED'});
    const reverse=(await catalog.list()).map(i=>i.id).reverse();
    await catalog.reorder(reverse,context);
    assert.deepEqual((await catalog.list()).map(i=>i.id),reverse);
    await therapistService.save(b.id,{...payloadB,name:'乙',serviceItemIds:[project.id],specialtiesVersion:(await therapistService.adminDetail(b.id)).specialtiesVersion},context);
    await schedules.patchDay(b.id, {date, serviceItemIds:[project.id]}, context);
    const appt=await appointments.createAppointment(booking(b,project.id),customerContext);
    await assert.rejects(()=>catalog.remove(project.id,context),{code:'PROJECT_HAS_APPOINTMENTS'});
    checkInNow = new Date(`${appt.date}T${appt.startTime}:00+08:00`);
    await appointments.checkInAppointment(appt.id,customerContext);
    checkInNow = undefined;
    await assert.rejects(()=>catalog.remove(project.id,context),{code:'PROJECT_HAS_APPOINTMENTS'});
    await catalog.save(project.id,{...projectInput,name:'新名称'},context);
    assert.deepEqual((await therapistService.active(b.id)).tags,['新名称']);
    assert.equal((await pool.query('SELECT service_item_name FROM appointments WHERE id=$1',[appt.id])).rows[0].service_item_name,'新护理项目');
    // Ended check-ins preserve history but do not prevent either kind of deletion.
    await pool.query("UPDATE appointments SET date='2000-01-01' WHERE id=$1",[appt.id]);
    await schedules.putWeekly({therapistIds:[b.id],weekdays:[weekday],serviceItemIds:[project.id,item]},context);
    await catalog.remove(project.id,context);
    assert.equal((await catalog.list()).some(i=>i.id===project.id),false);
    assert.equal((await catalog.recycleBin()).some(i=>i.id===project.id),true);
    assert.deepEqual((await therapistService.active(b.id)).tags,[]);
    await therapistService.save(b.id, { ...payloadB, name:'乙', bio:'更新简介', serviceItemIds:[] }, context);
    assert.equal((await pool.query('SELECT $1::uuid=ANY(service_item_ids) AS linked FROM therapists WHERE id=$2', [project.id,b.id])).rows[0].linked, true);
    assert.deepEqual((await schedules.detail({therapistId:b.id,date}, null)).serviceItemIds,[]);
    assert.deepEqual((await schedules.getWeekly(b.id,weekday,context)).serviceItemIds,[item]);
    const restoredProject = await catalog.restore([project.id], context);
    assert.equal(restoredProject.restored, 1);
    assert.equal((await catalog.list()).at(-1).id, project.id);
    assert.deepEqual((await therapistService.active(b.id)).tags, ['新名称']);
    assert.deepEqual((await schedules.detail({therapistId:b.id,date}, null)).serviceItemIds,[]);
    assert.deepEqual((await schedules.getWeekly(b.id,weekday,context)).serviceItemIds,[item]);
    await catalog.remove(project.id, context);
    assert.equal((await catalog.purge([project.id], context)).purged, 1);
    const purgedProject=(await pool.query('SELECT name,image_url,purged_at FROM service_items WHERE id=$1',[project.id])).rows[0];
    assert.match(purgedProject.name,/^已永久删除项目-/);
    assert.equal(purgedProject.image_url,'');
    assert.ok(purgedProject.purged_at);
    assert.equal((await pool.query('SELECT $1::uuid=ANY(service_item_ids) AS linked FROM therapists WHERE id=$2',[project.id,b.id])).rows[0].linked,false);
    const appointmentRepository=require('../src/repositories/appointmentRepository');
    assert.equal((await appointmentRepository.findById(appt.id)).serviceItemName,'新护理项目');
    const customerFilterOptions=await appointmentRepository.listFilterOptions(customer);
    const historicalProjectOption=customerFilterOptions.serviceItems.find((option)=>option.id===project.id);
    assert.equal(historicalProjectOption.name,'新护理项目');
    assert.equal(historicalProjectOption.inactive,true);
    await therapistService.remove(b.id,context);
    const autoProject=await catalog.save(null,{...projectInput,name:'自动清理项目'},context);
    await catalog.remove(autoProject.id,context);
    await pool.query("UPDATE service_items SET updated_at='2026-08-01T00:00:00Z' WHERE id=$1",[autoProject.id]);
    await pool.query("UPDATE therapists SET updated_at='2026-08-01T00:00:00Z' WHERE id=$1",[b.id]);
    const recycleCleanup=require('../src/services/recycleBinCleanupService');
    const cleanupResult=await recycleCleanup.purgeExpired({now:new Date('2026-10-16T00:00:00Z'),retentionDays:30});
    assert.equal(cleanupResult.projects,1);
    assert.equal(cleanupResult.therapists,1);
    assert.ok((await pool.query('SELECT purged_at FROM service_items WHERE id=$1',[autoProject.id])).rows[0].purged_at);
    assert.ok((await pool.query('SELECT purged_at FROM therapists WHERE id=$1',[b.id])).rows[0].purged_at);
    assert.equal((await pool.query('SELECT status,service_item_name FROM appointments WHERE id=$1',[appt.id])).rows[0].status,'checked_in');
    const updatedFilterOptions=await appointmentRepository.listFilterOptions(customer);
    const historicalTherapistOption=updatedFilterOptions.therapists.find((option)=>option.id===b.id);
    assert.equal(historicalTherapistOption.name,'乙');
    assert.equal(historicalTherapistOption.inactive,true);

    // Simulate restoring an older counter that collides with a newer JWT.
    const { rows: [epochUser] } = await pool.query("INSERT INTO users(openid,phone) VALUES ('epoch-audit','13799990001') RETURNING *");
    const users = require('../src/repositories/userRepository');
    const auth = require('../src/services/authService');
    const { attachUser } = require('../src/middleware/auth');
    const backup = require('../src/services/backupService');
    const tokenUser = await users.incrementSessionVersion(epochUser.id);
    const oldToken = auth.createToken(tokenUser);
    await pool.query('UPDATE users SET session_version=0 WHERE id=$1', [epochUser.id]);
    await db.transaction(client => backup.invalidateRestoredSessions(client));
    const restoredUser = await users.findById(epochUser.id);
    assert.equal(restoredUser.sessionVersion, tokenUser.sessionVersion);
    assert.notEqual(restoredUser.sessionEpoch, tokenUser.sessionEpoch);
    let authError;
    await attachUser({ get: () => `Bearer ${oldToken}` }, {}, error => { authError = error; });
    assert.equal(authError.code, 'INVALID_SESSION');
    const request = { get: () => `Bearer ${auth.createToken(restoredUser)}` };
    await attachUser(request, {}, error => { if (error) throw error; });
    assert.equal(request.user.id, epochUser.id);

    const authController = require('../src/controllers/authController');
    const logoutToken = auth.createToken(restoredUser);
    await authController.logout({ user:restoredUser }, { json:body => assert.equal(body.data.loggedOut, true) });
    let logoutError;
    await attachUser({ get:() => `Bearer ${logoutToken}` }, {}, error => { logoutError = error; });
    assert.equal(logoutError.code, 'INVALID_SESSION');
    const afterLogout = await users.findById(restoredUser.id);
    assert.equal(afterLogout.sessionVersion, restoredUser.sessionVersion + 1);
    assert.equal(afterLogout.id, restoredUser.id);
    const newRequest = { get:() => `Bearer ${auth.createToken(afterLogout)}` };
    await attachUser(newRequest, {}, error => { if (error) throw error; });
    assert.equal(newRequest.user.id, afterLogout.id);

    const whitelist = require('../src/services/whitelistService');
    const member = await whitelist.add({ phone:'13799990002', remarkName:'原名称' }, context);
    const otherMember = await whitelist.add({ phone:'13799990003', remarkName:'另一会员' }, context);
    assert.equal((await whitelist.update(member.id, { remarkName:'' }, context)).remarkName, null);
    await whitelist.update(member.id, { remarkName:'新名称' }, context);
    assert.equal((await whitelist.update(member.id, { phone:member.phone }, context)).remarkName, '新名称');
    await assert.rejects(whitelist.update(member.id, { phone:otherMember.phone }, context), { code:'WHITELIST_PHONE_EXISTS', status:409 });
    const unchangedMember = (await whitelist.list({ keyword:member.phone }))[0];
    assert.equal(unchangedMember.remarkName, '新名称');
    assert.equal(unchangedMember.phone, member.phone);

    // Restoring specialties while the editor is open must not let a profile-only
    // save overwrite the associations, even when they exceed the former limit.
    const specialtyProjects = [];
    for (let index = 0; index < 13; index++) {
      specialtyProjects.push(await catalog.save(null, { ...projectInput, name: `标签恢复回归-${index}` }, context));
    }
    const specialtyIds = specialtyProjects.map((specialty) => specialty.id);
    const specialtyPayload = { ...payload, name: "标签回归芳疗师", phone: "13799990004", serviceItemIds: specialtyIds };
    const { serviceItemIds: ignoredIds, ...profileOnly } = specialtyPayload;
    const manyTags = await therapistService.save(null, specialtyPayload, context);
    assert.equal(manyTags.serviceItemIds.length, 13);
    await catalog.remove(specialtyIds[0], context);
    const editorSnapshot = await therapistService.adminDetail(manyTags.id);
    assert.equal(editorSnapshot.serviceItemIds.length, 12);
    await catalog.restore([specialtyIds[0]], context);
    await therapistService.save(manyTags.id, { ...profileOnly, bio: "只修改简介" }, context);
    const afterProfile = await therapistService.adminDetail(manyTags.id);
    assert.equal(afterProfile.bio, "只修改简介");
    assert.deepEqual([...afterProfile.serviceItemIds].sort(), [...specialtyIds].sort());
    assert.notEqual(afterProfile.specialtiesVersion, editorSnapshot.specialtiesVersion);
    assert.equal((await therapistService.detail(manyTags.id)).specialtiesVersion, undefined);

    for (const version of [undefined, editorSnapshot.specialtiesVersion]) {
      await assert.rejects(therapistService.save(manyTags.id, {
        ...profileOnly, bio: "不应保存", serviceItemIds: editorSnapshot.serviceItemIds, specialtiesVersion: version
      }, context), { code: "THERAPIST_SPECIALTIES_CHANGED", status: 409 });
    }
    assert.equal((await therapistService.adminDetail(manyTags.id)).bio, "只修改简介");
    const editedIds = afterProfile.serviceItemIds.slice(1);
    await therapistService.save(manyTags.id, {
      ...profileOnly, serviceItemIds: editedIds, specialtiesVersion: afterProfile.specialtiesVersion
    }, context);
    const concurrentSnapshot = await therapistService.adminDetail(manyTags.id);
    assert.equal(concurrentSnapshot.serviceItemIds.length, 12);
    const tagUpdates = await Promise.allSettled([
      concurrentSnapshot.serviceItemIds.slice(1), concurrentSnapshot.serviceItemIds.slice(0, -1)
    ].map((ids) => therapistService.save(manyTags.id, {
      ...profileOnly, serviceItemIds: ids, specialtiesVersion: concurrentSnapshot.specialtiesVersion
    }, context)));
    assert.equal(tagUpdates.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(tagUpdates.find((result) => result.status === "rejected").reason.code, "THERAPIST_SPECIALTIES_CHANGED");
    const finalSnapshot = await therapistService.adminDetail(manyTags.id);
    assert.equal(finalSnapshot.serviceItemIds.length, 11);
    await therapistService.save(manyTags.id, { ...profileOnly, serviceItemIds: [], specialtiesVersion: finalSnapshot.specialtiesVersion }, context);
    assert.equal((await therapistService.adminDetail(manyTags.id)).serviceItemIds.length, 0);
  } finally {
    db.query = old.query; db.transaction = old.transaction; audits.record = oldAudit;
    await pool.end();
    await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await root.end();
    assert.equal(path.dirname(imageDirectory), os.tmpdir());
    assert.ok(path.basename(imageDirectory).startsWith("booking-images-test-"));
    for (const file of fs.readdirSync(imageDirectory)) fs.unlinkSync(path.join(imageDirectory, file));
    fs.rmdirSync(imageDirectory);
  }
});
