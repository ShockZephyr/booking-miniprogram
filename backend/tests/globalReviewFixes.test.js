const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

test("global review fixes on isolated HTTP and PostgreSQL", { skip: process.env.RUN_DB_TESTS !== "1" }, async t => {
  const isolated = require("./audit-2026-10-20/isolated");
  try {
    await isolated.withDatabase(async f => {
      const { api, admin, staff, other, customer, therapistA: a, therapistB: b, pool, tomorrow } = f;
      const images = require("../src/services/therapistImageService");

      await t.test("profile-only and stale writes cannot transfer the binding or cancel the former therapist's booking", async () => {
        const url = "/api/admin/therapists/" + b.id;
        const edit = data => api(url, admin, "PATCH", data);
        const original = (await api(url, admin)).body.data.therapist;
        const image = await images.uploadBuffer(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));
        const beforeTransfer = await f.addAppointment(f.bookingTime({ date: tomorrow, therapist: a }), { user: other });
        const status = async id => (await pool.query("SELECT status FROM appointments WHERE id=$1", [id])).rows[0].status;
        assert.equal((await edit({ ...image, phone: other.phone, bindingVersion: original.bindingVersion })).status, 200);
        assert.equal(await status(beforeTransfer.id), "cancelled");
        const protectedBooking = await f.addAppointment(f.bookingTime({ date: tomorrow, therapist: a }), { user: staff });
        const staleFullForm = { name: original.name, bio: "旧资料", phone: staff.phone, ...image };
        for (const stale of [staleFullForm, { ...staleFullForm, bindingVersion: original.bindingVersion }]) {
          assert.equal((await edit(stale)).body.code, "THERAPIST_BINDING_CHANGED");
        }
        assert.equal((await edit({ bio: "仅改简介" })).status, 200);
        const current = (await api(url, admin)).body.data.therapist;
        assert.equal(current.userId, other.id);
        assert.equal(current.phone, other.phone);
        assert.equal(current.bio, "仅改简介");
        assert.equal(await status(protectedBooking.id), "booked");
      });

      await t.test("binding revisions survive an unregistered phone round trip and retirement; invalid and no-op patches do not write", async () => {
        const base = "/api/admin/therapists";
        const phoneA = "13999110001", phoneB = "13999110002";
        const { imageUrl } = await images.uploadBuffer(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));
        const created = await api(base, admin, "POST", { name: "版本测试", bio: "简介甲", phone: phoneA,
          imageUrl, serviceItemIds: [] });
        assert.equal(created.status, 200);
        const original = created.body.data.therapist, url = base + "/" + original.id;
        const edit = body => api(url, admin, "PATCH", body);
        const snapshot = async () => (await pool.query(`SELECT xmin::text AS row_version,
          (SELECT count(*) FROM audit_logs WHERE resource_id=t.id::text) AS audits
          FROM therapists t WHERE id=$1`, [original.id])).rows[0];
        const unchanged = await snapshot();
        for (const invalid of [[], { phnoe: phoneB }, { bio: null }, { bindingVersion: original.bindingVersion }]) {
          assert.equal((await edit(invalid)).status, 400);
        }
        for (const noop of [{}, { bio: " 简介甲 " }, { serviceItemIds: [] }]) {
          assert.equal((await edit(noop)).body.data.therapist.bindingVersion, original.bindingVersion);
        }
        assert.deepEqual(await snapshot(), unchanged);
        const fresh = async body => {
          const res = await edit(body);
          assert.equal(res.status, 200);
          return res.body.data.therapist;
        };
        assert.equal((await fresh({ bio: "简介乙" })).bindingVersion, original.bindingVersion);
        const middle = await fresh({ phone: phoneB, bindingVersion: original.bindingVersion });
        const back = await fresh({ phone: phoneA, bindingVersion: middle.bindingVersion });
        assert.notEqual(back.bindingVersion, original.bindingVersion);
        const guest = await f.addAppointment(f.bookingTime({ date: tomorrow, start: "13:00", end: "14:30" }), { user: customer });
        assert.equal((await edit({ phone: customer.phone, bindingVersion: original.bindingVersion })).body.code, "THERAPIST_BINDING_CHANGED");
        assert.equal((await pool.query("SELECT status FROM appointments WHERE id=$1", [guest.id])).rows[0].status, "booked");
        assert.equal((await api(url, admin)).body.data.therapist.userId, null);
        assert.equal((await api(url, admin, "DELETE")).status, 200);
        assert.equal((await api(base + "/restore", admin, "PATCH", { ids: [original.id] })).status, 200);
        assert.equal((await edit({ phone: customer.phone, bindingVersion: back.bindingVersion })).status, 409);
        const restored = (await api(url, admin)).body.data.therapist;
        assert.equal((await fresh({ phone: customer.phone, bindingVersion: restored.bindingVersion })).cancelledAppointments, 1);
        assert.equal((await pool.query("SELECT status FROM appointments WHERE id=$1", [guest.id])).rows[0].status, "cancelled");
        const publicResult = await api("/api/therapists/" + original.id, customer);
        assert.equal(publicResult.status, 200);
        assert.equal(Object.hasOwn(publicResult.body.data.therapist, "bindingVersion"), false);
      });

      await t.test("a therapist editor can undo its previous save after returning from the background", async () => {
        const vm = require("node:vm");
        const app = { globalData: { user: admin, token: "editor-session" } };
        const messages = [], writes = [], url = "/api/admin/therapists/" + b.id;
        let page, complete, saveTask;
        const read = async () => (await api(url, admin)).body.data;
        const svc = {
          adminDetail: read,
          save(id, body) {
            assert.equal(id, b.id);
            writes.push({ ...body });
            saveTask = (async () => {
              const res = await api(url, admin, "PATCH", body);
              assert.equal(res.status, 200);
              if (writes.length === 1) await new Promise(resolve => { complete = resolve; });
              return res.body.data;
            })();
            return saveTask;
          }
        };
        const host = { getApp: () => app, getCurrentPages: () => [page], setTimeout() {},
          wx: { setNavigationBarTitle() {}, showToast: options => messages.push(options.title) } };
        const root = path.join(__dirname, "../../miniprogram");
        const lifecycle = { exports: {} };
        vm.runInNewContext(await fs.readFile(path.join(root, "utils/editorLifecycle.js"), "utf8"), { ...host, module: lifecycle });
        vm.runInNewContext(await fs.readFile(path.join(root, "pages/admin/therapist-edit/index.js"), "utf8"), {
          ...host, Page: def => { page = def; }, require: name => name.endsWith("/editorLifecycle") ? lifecycle.exports :
            name.endsWith("/user") ? { serviceItems: async () => ({ items: f.projects }) } : svc
        });
        page.setData = patch => Object.assign(page.data, patch);
        async function waitFor(predicate) {
          for (let i = 0; i < 200 && !predicate(); i++) await delay(10);
          assert.ok(predicate());
        }
        page.onLoad({ id: b.id }); page.onShow();
        await waitFor(() => !page.data.loading);
        const originalBio = page.data.bio;
        page.data.bio = "暂存修改"; page.save(); page.onHide();
        await waitFor(() => !!complete);
        complete(); await saveTask; await waitFor(() => !page.data.saving);
        assert.equal(messages.length, 0);
        page.onShow();
        assert.deepEqual(messages, ["已保存"]);
        page.data.bio = originalBio; page.save(); await saveTask;
        assert.deepEqual(writes, [{ bio: "暂存修改" }, { bio: originalBio }]);
        assert.equal((await read()).therapist.bio, originalBio);
      });

      await t.test("manual cells keep their observed duration and do not freeze a stale day", async () => {
        const week = step => api("/api/admin/schedules/weekly", admin, "PUT", {
          therapistIds: [b.id], weekdays: [1,2,3,4,5,6,7], schedule: { step, minDuration: 90,
            ranges: [{ startTime: "09:00", endTime: "12:00" }] }, serviceItemIds: [f.projects[0].id] });
        const patch = data => api("/api/admin/schedules/day/" + b.id, admin, "PATCH", { date: tomorrow, ...data });
        assert.equal((await week(10)).status, 200);
        const observed = (await api("/api/schedules/" + b.id + "?date=" + tomorrow, admin)).body.data;
        assert.equal(observed.step, 10);
        assert.equal((await week(30)).status, 200);
        for (const action of ["open", "close"]) {
          for (const options of [{}, { expectedStep: observed.step }]) {
            assert.equal((await patch({ [action]: ["09:00"], ...options })).body.code, "SCHEDULE_DAY_CHANGED");
          }
        }
        assert.equal((await pool.query("SELECT 1 FROM schedule_days WHERE date=$1 AND therapist_id=$2", [tomorrow,b.id])).rowCount, 0);
        assert.equal((await patch({ expectedStep: 30, close: ["10:00"] })).status, 200);
        assert.deepEqual((await patch({ expectedStep: 30, close: ["09:00"] })).body.data.closed, ["09:00","10:00"]);
        assert.deepEqual((await patch({ expectedStep: 30, open: ["09:00"] })).body.data.closed, ["10:00"]);
      });

      await t.test("queued logout cannot revoke the next session", async () => {
        const guard = await pool.connect();
        const token = await f.tokenFor(customer);
        let pending;
        try {
          await guard.query("BEGIN");
          await guard.query("SELECT pg_advisory_xact_lock(582302)");
          pending = api("/api/auth/logout", customer, "POST", {}, token);
          let waiting = false;
          for (let i = 0; i < 150 && !waiting; i++) {
            waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'")).rowCount > 0;
            if (!waiting) await delay(10);
          }
          assert.ok(waiting);
          const next = await require("../src/repositories/userRepository").incrementSessionVersion(customer.id, guard);
          const freshToken = require("../src/services/authService").createToken(next);
          await guard.query("COMMIT");
          assert.equal((await pending).body.code, "INVALID_SESSION");
          assert.equal((await api("/api/auth/me", customer, "GET", null, freshToken)).status, 200);
          assert.equal((await api("/api/auth/logout", customer, "POST", {}, freshToken)).status, 200);
          assert.equal((await api("/api/auth/me", customer, "GET", null, freshToken)).status, 401);
        } finally { await guard.query("ROLLBACK"); guard.release(); if (pending) await pending; }
      });

      await t.test("metrics only permit a canonical direct local scrape and bound unrecognised paths", async () => {
        for (const alias of ["/MeTrIcS", "/metrics/"]) assert.equal((await fetch(f.origin + alias)).status, 404);
        for (const name of ["x-real-ip", "x-forwarded-for", "forwarded"]) {
          assert.equal((await fetch(f.origin + "/metrics", { headers: { [name]: "127.0.0.1" } })).status, 404);
        }
        for (let i = 0; i < 12; i++) await fetch(f.origin + "/never-a-route/" + i);
        const scrape = await fetch(f.origin + "/metrics");
        assert.equal(scrape.status, 200);
        const body = await scrape.text();
        assert.match(body, /route="unmatched"/);
        assert.doesNotMatch(body, /never-a-route/);
      });

      await t.test("a verified PostgreSQL and image backup completes while the identity lock is held", async () => {
        const backup = require("../src/services/backupService");
        const guard = await pool.connect();
        const url = new URL(process.env.TEST_DATABASE_URL);
        url.searchParams.set("options", "-c search_path=" + (await guard.query("SELECT current_schema() AS n")).rows[0].n + ",public");
        try {
          await guard.query("BEGIN");
          await guard.query("SELECT pg_advisory_xact_lock(582302)");
          const result = await backup.backup({ databaseUrl: url.href, uploadsDirectory: images.directory,
            backupDirectory: path.join(isolated.directory, "backups") });
          const manifest = await backup.verifyBackup(result.directory);
          assert.ok(manifest.database.bytes > 0);
          assert.ok(manifest.images.length > 0);
          const reference = (await guard.query("SELECT image_url FROM therapists WHERE id=$1", [b.id])).rows[0].image_url;
          await fs.access(path.join(result.directory, "images", path.basename(reference)));
        } finally { await guard.query("ROLLBACK"); guard.release(); }
      });

      await t.test("cleanup waits for image backups without blocking booking operations", async () => {
        const maintenanceLock = require("../src/utils/imageBackupLock");
        const cleanup = require("../src/services/imageCleanupService");
        const guard = await pool.connect();
        const file = await images.uploadBuffer(Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(20)]));
        const orphan = path.join(images.directory, path.basename(file.imageUrl));
        let task;
        try {
          await guard.query("BEGIN");
          await guard.query("SELECT pg_advisory_xact_lock_shared($1)", [maintenanceLock]);
          task = cleanup.cleanupOrphans({ retentionHours: 0 });
          let waiting = false;
          for (let i = 0; i < 150 && !waiting; i++) {
            const locks = await pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted", [maintenanceLock]);
            waiting = locks.rowCount > 0;
            if (!waiting) await delay(10);
          }
          assert.ok(waiting);
          await fs.access(orphan);
          assert.equal((await api("/api/admin/schedules/settings", admin)).status, 200);
          await guard.query("COMMIT");
          assert.equal((await task).deleted, 1);
          await assert.rejects(fs.access(orphan), { code: "ENOENT" });
        } finally {
          await guard.query("ROLLBACK");
          guard.release();
          if (task) await task;
        }
      });
    });
  } finally { isolated.cleanup(); }
});
