const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

test("private review login runs against isolated HTTP/PostgreSQL with production mock guards", {
  skip: process.env.RUN_DB_TESTS !== "1"
}, async t => {
  const { withDatabase, cleanup } = require("./audit-2026-10-20/isolated");
  try { await withDatabase(async h => {
    const env = require("../src/config/env");
    const saved = { review: env.reviewLogin, isProduction: env.isProduction, mockLogin: env.wechat.mockLogin };
    env.isProduction = true; env.wechat.mockLogin = false;
    env.reviewLogin = { enabled: true, code: crypto.randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 86400000).toISOString() };
    const call = async (route, method="GET", body, token) => {
      const r = await fetch(h.origin+route, { method, headers: { "content-type":"application/json", ...(token ? {authorization:`Bearer ${token}`} : {}) },
        body: body ? JSON.stringify(body) : undefined });
      return {status:r.status, body:await r.json(), cache:r.headers.get("cache-control")};
    };
    const login = account => call("/api/auth/review-login","POST",{account,reviewCode:env.reviewLogin.code});
    try {
      const options = await call("/api/auth/review-options");
      assert.deepEqual(options.body.data, {testLoginEnabled:true}); assert.equal(options.cache,"no-store");
      assert.equal((await call("/api/auth/review-login","POST",{account:"admin",reviewCode:"wrong"})).status,401);
      assert.equal((await call("/api/auth/wechat-login","POST",{mockRole:"admin"})).body.code,"MOCK_LOGIN_DISABLED");
      const [a,b] = await Promise.all([login("user"),login("user")]);
      assert.equal(a.status,200,JSON.stringify(a.body)); assert.equal(b.status,200,JSON.stringify(b.body));
      const ordinary=a.body.data, adminResult=await login("admin");
      assert.equal(adminResult.status,200,JSON.stringify(adminResult.body));
      const admin=adminResult.body.data;
      await t.test("failure after first therapist initialization rolls back the account, profile and week", async () => {
        const broken = require("../src/services/reviewLoginService").createReviewLoginService({
          logs: { business: async () => { throw new Error("test transaction rollback"); } }
        });
        const before = (await h.pool.query("SELECT count(*)::int AS n FROM weekly_schedules")).rows[0].n;
        await assert.rejects(broken.login({ account:"therapist",reviewCode:env.reviewLogin.code }), /test transaction rollback/);
        assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM users WHERE review_identity='therapist'")).rows[0].n,0);
        assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM therapists WHERE phone='review:therapist'")).rows[0].n,0);
        assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM weekly_schedules")).rows[0].n,before);
      });
      const [staffA, staffB] = await Promise.all([login("therapist"), login("therapist")]);
      assert.equal(staffA.status,200,JSON.stringify(staffA.body));
      assert.equal(staffB.status,200,JSON.stringify(staffB.body));
      const staff=staffA.body.data;
      assert.equal(staff.user.id,staffB.body.data.user.id);
      assert.equal(staff.user.therapistId,staffB.body.data.user.therapistId);
      assert.equal(staff.user.role,"user"); assert.ok(staff.user.therapistId);
      assert.equal(staff.user.capabilities.admin,false);
      assert.equal(staff.user.capabilities.bookAppointment,false);
      assert.equal(ordinary.user.id,b.body.data.user.id);
      assert.equal(ordinary.user.effectiveRole,"member"); assert.equal(admin.user.role,"admin");
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM users WHERE review_identity IS NOT NULL")).rows[0].n,3);

      await t.test("review therapist has one dedicated profile and seven default days without a membership grant",async()=>{
        const profiles=await h.pool.query("SELECT * FROM therapists WHERE phone='review:therapist'");
        assert.equal(profiles.rows.length,1); assert.equal(profiles.rows[0].user_id,staff.user.id);
        const days=await h.pool.query("SELECT * FROM weekly_schedules WHERE therapist_id=$1 ORDER BY weekday",[staff.user.therapistId]);
        assert.equal(days.rows.length,7);
        for (const day of days.rows) {
          assert.equal(day.step,30); assert.equal(day.min_duration,90); assert.deepEqual(day.service_item_ids,[]);
          assert.deepEqual(day.ranges,[{startTime:"09:00",endTime:"12:00"},{startTime:"12:30",endTime:"15:00"},{startTime:"15:30",endTime:"18:00"},{startTime:"18:30",endTime:"20:30"}]);
        }
        assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM member_whitelist WHERE phone='review:therapist'")).rows[0].n,0);
        const own=h.bookingTime({date:h.tomorrow,start:"09:00",end:"10:30",therapist:{id:staff.user.therapistId}});
        const booking=await h.addAppointment(own);
        const other=await h.addAppointment(h.bookingTime({date:h.tomorrow,start:"11:00",end:"12:30"}));
        const list=await call("/api/therapist/appointments","GET",undefined,staff.token);
        assert.equal(list.status,200,JSON.stringify(list.body));
        assert.ok(list.body.data.appointments.some(item=>item.id===booking.id));
        assert.ok(!list.body.data.appointments.some(item=>item.id===other.id));
        assert.equal((await call(`/api/therapist/appointments/${other.id}`,"GET",undefined,staff.token)).status,404);
        assert.equal((await call("/api/admin/appointments","GET",undefined,staff.token)).status,403);
        assert.equal((await call("/api/appointments","POST",own,staff.token)).status,403);
        assert.equal((await call(`/api/therapist/appointments/${booking.id}/check-in`,"PATCH",{},staff.token)).status,409);
        // Move only the isolated fixture into the check-in window, never change the system clock.
        await h.pool.query("UPDATE appointments SET date=(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date-1 WHERE id=$1",[booking.id]);
        assert.equal((await call(`/api/therapist/appointments/${booking.id}/check-in`,"PATCH",{},staff.token)).status,200);
        await h.pool.query("UPDATE appointments SET status='cancelled' WHERE id=$1",[other.id]);
      });

      await t.test("review profile edits retain its binding; delete and restore remain explicit",async()=>{
        const route=`/api/admin/therapists/${staff.user.therapistId}`;
        const profile=(await call(route,"GET",undefined,admin.token)).body.data.therapist;
        assert.equal(profile.isReviewTherapist,true);
        assert.equal((await call(route,"PATCH",{phone:"13900000006",bindingVersion:profile.bindingVersion},admin.token)).body.code,"REVIEW_THERAPIST_PHONE_LOCKED");
        const image=await require("../src/services/therapistImageService").upload("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=");
        const edited=await call(route,"PATCH",{bio:"测试简介修改",...image},admin.token);
        assert.equal(edited.status,200,JSON.stringify(edited.body));
        assert.equal(edited.body.data.therapist.userId,staff.user.id);
        const forged=await call("/api/admin/therapists","POST",{
          name:"不能自行伪造测试身份",bio:"",phone:"review:therapist",serviceItemIds:[],...image
        },admin.token);
        assert.equal(forged.body.code,"INVALID_PHONE");
        await h.pool.query("UPDATE weekly_schedules SET ranges='[]' WHERE therapist_id=$1 AND weekday=1",[staff.user.therapistId]);
        assert.equal((await login("therapist")).status,200);
        assert.deepEqual((await h.pool.query("SELECT ranges FROM weekly_schedules WHERE therapist_id=$1 AND weekday=1",[staff.user.therapistId])).rows[0].ranges,[]);
        assert.equal((await call(route,"DELETE",undefined,admin.token)).status,200);
        assert.equal((await call("/api/auth/me","GET",undefined,staff.token)).status,401);
        assert.equal((await login("therapist")).body.code,"REVIEW_ACCOUNT_CONFLICT");
        const restored=await call("/api/admin/therapists/restore","PATCH",{ids:[staff.user.therapistId]},admin.token);
        assert.equal(restored.status,200,JSON.stringify(restored.body));
        const fresh=await login("therapist"); assert.equal(fresh.status,200,JSON.stringify(fresh.body));
        assert.equal(fresh.body.data.user.therapistId,staff.user.therapistId);
        staff.token=fresh.body.data.token;
        assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM therapists WHERE phone='review:therapist'")).rows[0].n,1);
        assert.ok((await h.pool.query("SELECT ranges FROM weekly_schedules WHERE therapist_id=$1",[staff.user.therapistId])).rows.every(day=>day.ranges.length===0));
      });

      await t.test("real membership and role boundaries still govern review accounts",async()=>{
        const time=await h.configureWeek();
        const booking = await call("/api/appointments","POST",time,ordinary.token);
        assert.equal(booking.status,200,JSON.stringify(booking.body));
        assert.equal((await call("/api/admin/appointments","GET",undefined,ordinary.token)).status,403);
        assert.equal((await call("/api/admin/appointments","GET",undefined,admin.token)).status,200);
        assert.equal((await call("/api/appointments","POST",time,admin.token)).status,403);
        const member = await call("/api/admin/whitelist","POST",{phone:"13900000008",remarkName:"隔离审核会员"},admin.token);
        assert.equal(member.status,200,JSON.stringify(member.body));
        await h.pool.query("UPDATE member_whitelist SET status='inactive' WHERE phone='review:user'");
        const again=await login("user"); assert.equal(again.body.data.user.effectiveRole,"user");
        assert.equal((await call("/api/appointments","POST",time,again.body.data.token)).body.code,"NOT_MEMBER");
      });

      await t.test("review records cannot turn into real phone accounts or authenticate through an unmarked token", async()=>{
        const { createAuthService }=require("../src/services/authService");
        const service=createAuthService({wechatService:{code2Session:async()=>({openid:"review:user"}),getPhoneNumber:async()=>"13900000009"}});
        await assert.rejects(service.loginWithWechat({loginCode:"fake",phoneCode:"fake"}),{code:"ACCOUNT_IDENTITY_CONFLICT"});
        const stored=await require("../src/repositories/userRepository").findById(admin.user.id);
        const normalToken=service.createToken(stored);
        assert.equal((await call("/api/auth/me","GET",undefined,normalToken)).status,401);
        await assert.rejects(h.pool.query("UPDATE users SET phone='13900000009' WHERE id=$1",[admin.user.id]),{code:"23514"});
      });

      await t.test("test member remarks and explicit restore work without admitting fake phones or transferring membership", async()=>{
        const rows = await call("/api/admin/whitelist?includeInactiveReview=true", "GET", undefined, admin.token);
        const member = rows.body.data.items.find(row=>row.isReviewMember);
        assert.ok(member); assert.equal(member.status,"inactive");
        const activeOnly = await call("/api/admin/whitelist", "GET", undefined, admin.token);
        assert.ok(!activeOnly.body.data.items.some(row=>row.id===member.id));
        const path = `/api/admin/whitelist/${member.id}`;
        const edit = await call(path,"PATCH",{remarkName:"审核备注修改"},admin.token);
        assert.equal(edit.status,200); assert.equal(edit.body.data.item.phone,"review:user");
        assert.equal(edit.body.data.item.status,"inactive");
        assert.equal((await call(path,"PATCH",{phone:"13900000006"},admin.token)).body.code,"REVIEW_MEMBER_PHONE_LOCKED");
        assert.equal((await call("/api/admin/whitelist","POST",{phone:"review:user"},admin.token)).body.code,"INVALID_PHONE");
        assert.equal((await call(path,"PATCH",{status:"active"},ordinary.token)).status,403);
        assert.equal((await call(path,"PATCH",{status:"active"},admin.token)).status,200);
        assert.equal((await call("/api/auth/me","GET",undefined,ordinary.token)).body.data.user.effectiveRole,"member");
        await call(path,"DELETE",undefined,admin.token);
        assert.equal((await login("user")).body.data.user.effectiveRole,"user");
        const filtered = await call("/api/admin/whitelist?includeInactiveReview=true&keyword=no-match", "GET", undefined, admin.token);
        assert.equal(filtered.body.data.items.length,0);
        assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM member_whitelist WHERE phone='review:user'")).rows[0].n,1);
      });

      await t.test("signature domains cannot be switched with forged headers or payload markers", async()=>{
        const jwt=require("jsonwebtoken"), session=require("../src/services/reviewSession");
        const payload=jwt.decode(admin.token); delete payload.iat;
        for (const token of [
          jwt.sign(payload,env.jwtSecret),
          jwt.sign(payload,env.jwtSecret,{keyid:session.TOKEN_KEY_ID}),
          jwt.sign({...payload,review:undefined},session.signingKey(),{keyid:session.TOKEN_KEY_ID}),
          jwt.sign(payload,session.signingKey()),
          jwt.sign(payload,session.signingKey(),{keyid:"unknown"})
        ]) assert.equal((await call("/api/auth/me","GET",undefined,token)).status,401);
        assert.throws(()=>jwt.verify(admin.token,env.jwtSecret),{name:"JsonWebTokenError"});
      });

      await t.test("disabling and rotating review credentials revokes all three identities, not a real admin session",async()=>{
        const realToken=await h.tokenFor(h.admin);
        env.reviewLogin.enabled=false;
        assert.deepEqual((await call("/api/auth/review-options")).body.data,{testLoginEnabled:false});
        assert.equal((await login("admin")).status,403);
        for(const token of [ordinary.token,admin.token,staff.token]) assert.equal((await call("/api/auth/me","GET",undefined,token)).body.code,"INVALID_SESSION");
        assert.equal((await call("/api/auth/me","GET",undefined,realToken)).status,200);
        env.reviewLogin.enabled=true; env.reviewLogin.code=crypto.randomBytes(32).toString("hex");
        assert.equal((await call("/api/auth/me","GET",undefined,admin.token)).status,401);
        const fresh=await login("admin"); assert.equal(fresh.status,200);
        assert.equal((await call("/api/auth/logout","POST",{},fresh.body.data.token)).status,200);
        assert.equal((await call("/api/auth/me","GET",undefined,fresh.body.data.token)).status,401);
      });

      await t.test("expiry after waiting for the transaction identity lock cannot write with an old review session",async()=>{
        const fresh=await login("admin"); assert.equal(fresh.status,200);
        const conn=await h.pool.connect();
        try {
          await conn.query("BEGIN"); await conn.query("SELECT pg_advisory_xact_lock(582302)");
          const write=call("/api/admin/whitelist","POST",{phone:"13900000007"},fresh.body.data.token);
          // Wait until the actual service transaction is blocked on our lock.
          let waiting=false;
          for(let i=0;i<100;i++) {
            const result=await conn.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=582302 AND NOT granted");
            if(result.rows[0].n) {waiting=true;break;}
            await new Promise(resolve=>setTimeout(resolve,10));
          }
          assert.ok(waiting,"protected request must reach the identity lock");
          env.reviewLogin.expiresAt=new Date(Date.now()-1000).toISOString();
          await conn.query("COMMIT");
          assert.equal((await write).body.code,"INVALID_SESSION");
          assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM member_whitelist WHERE phone='13900000007'")).rows[0].n,0);
        } finally {await conn.query("ROLLBACK");conn.release();}
      });
    } finally { env.reviewLogin=saved.review;env.isProduction=saved.isProduction;env.wechat.mockLogin=saved.mockLogin; }
  }); } finally {cleanup();}
});
