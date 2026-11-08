const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const flush = () => new Promise(resolve => setImmediate(resolve));
const pending = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function harness() {
  const h = { reads: [], writes: [], toasts: [], sessions: [] };
  const app = { _loginSessionVersion: 1, globalData: { token: "", user: null },
    setSession(token,user) { this.globalData = { token,user }; this._loginSessionVersion++; h.sessions.push(user.id); },
    refreshMe: async () => app.globalData.user };
  let page;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../../miniprogram/pages/mine/index.js"),"utf8"), {
    Page: value => { page=value; }, getApp: () => app,
    wx: { showToast: x => h.toasts.push(x.title) },
    require: name => name.endsWith("/auth") ? {
      reviewOptions: () => { const p=pending(); h.reads.push(p); return p.promise; },
      reviewLogin: input => { const p=pending(); h.writes.push({ ...p,input }); return p.promise; }
    } : name.endsWith("/runtime") ? { canUseTestLogin: () => false } : { resume() {} }
  });
  page.setData = data => Object.assign(page.data, data);
  return { ...h, app, page };
}
async function enable(h) {
  h.page.onShow(); h.reads.at(-1).resolve({ testLoginEnabled: true }); await flush();
  h.page.inputReviewCode({ detail: { value: "private-review-code" } });
}
test("review entry defaults hidden and is refreshed without retaining a code across hide/show", async () => {
  const h=harness(), p=h.page;
  assert.equal(p.data.showReviewLogin,false);
  await enable(h); assert.equal(p.data.showReviewLogin,true);
  p.onHide(); assert.equal(p.data.reviewCode,""); assert.equal(p.data.showReviewLogin,false);
  p.onShow(); h.reads.at(-1).reject(new Error("offline")); await flush();
  assert.equal(p.data.showReviewLogin,false);
  p.onShow(); const stale=h.reads.at(-1); p.onHide(); p.onShow();
  h.reads.at(-1).resolve({testLoginEnabled:false}); stale.resolve({testLoginEnabled:true}); await flush();
  assert.equal(p.data.showReviewLogin,false);
});
test("ordinary/admin login needs a code, prevents duplicate submission, and clears it after success", async () => {
  const h=harness(), p=h.page;
  await enable(h); p.inputReviewCode({detail:{value:""}}); p.reviewAdminLogin(); assert.equal(h.writes.length,0);
  p.inputReviewCode({detail:{value:"private-review-code"}});
  const result=p.reviewAdminLogin(); p.reviewUserLogin(); p.reviewTherapistLogin();
  assert.equal(h.writes.length,1); assert.equal(h.writes[0].input.account,"admin");
  h.writes[0].resolve({token:"new",user:{id:"admin"}}); await result;
  assert.deepEqual(h.sessions,["admin"]); assert.equal(p.data.reviewCode,""); assert.equal(p.data.loggingIn,false);
});

test("therapist review login selects only the fixed therapist identity and shares login guards", async () => {
  const h=harness(), p=h.page;
  p.reviewTherapistLogin(); assert.equal(h.writes.length,0);
  await enable(h);
  p.inputReviewCode({detail:{value:""}}); p.reviewTherapistLogin(); assert.equal(h.writes.length,0);
  p.inputReviewCode({detail:{value:"private-review-code"}});
  const result=p.reviewTherapistLogin(); p.reviewAdminLogin(); p.reviewTherapistLogin();
  assert.equal(h.writes.length,1); assert.equal(h.writes[0].input.account,"therapist");
  h.writes[0].resolve({token:"staff",user:{id:"staff",role:"user",therapistId:"assigned"}});
  await result;
  assert.deepEqual(h.sessions,["staff"]); assert.equal(p.data.user.therapistId,"assigned");
  assert.equal(p.data.reviewCode,""); assert.equal(p.data.loggingIn,false);
});
test("late login results after hide or account switch cannot replace the current session", async () => {
  for (const mode of ["hide", "switch"]) {
    const h=harness(), p=h.page; await enable(h);
    const result=p.reviewTherapistLogin();
    if(mode==="hide") p.onHide(); else h.app.setSession("new-account-token",{id:"other"});
    h.writes[0].resolve({token:"old-test",user:{id:"review"}}); await result;
    assert.ok(!h.sessions.includes("review")); assert.equal(p.data.loggingIn,false);
  }
});
test("closed backend rejects a stale button and hides the entry; a bad code allows retry", async () => {
  const h=harness(), p=h.page; await enable(h);
  let result=p.reviewUserLogin(); h.writes[0].reject({code:"REVIEW_CODE_INVALID",message:"审核码不正确"}); await result;
  assert.equal(p.data.showReviewLogin,true); assert.equal(p.data.loggingIn,false);
  result=p.reviewUserLogin(); h.writes[1].reject({code:"REVIEW_LOGIN_DISABLED",message:"测试登录未开启或已结束"}); await result;
  assert.equal(p.data.showReviewLogin,false); assert.equal(p.data.reviewCode,"");
});

test("uploaded develop, trial and release packages all default to HTTPS; local debug is explicit", () => {
  const root=path.join(__dirname,"../../miniprogram");
  // Exercise uploaded-package behavior independently of the developer's local switch.
  // The actual public defaults are checked separately by opensource:check.
  const development={ENABLE_LOCAL_DEBUG:false,LOCAL_API_BASE_URL:"http://127.0.0.1:3000"};
  for(const envVersion of ["develop","trial","release"]) {
    const runtime={exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(root,"utils/runtime.js"),"utf8"),{
      module:runtime,require:()=>development,wx:{getDeviceInfo:()=>({platform:"devtools"}),getAccountInfoSync:()=>({miniProgram:{envVersion}})}
    });
    const module={exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(root,"config/env.js"),"utf8"),{
      module,require:name=>name.includes("runtime")?runtime.exports:development
    });
    assert.match(module.exports.API_BASE_URL,/^https:\/\//); assert.equal(runtime.exports.canUseTestLogin(),false);
  }
});
