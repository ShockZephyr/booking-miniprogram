process.env.NODE_TEST_CONTEXT = "1";
process.env.DATABASE_URL = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { createAuthService } = require("../src/services/authService");

function harness(options = {}) {
  const state = {
    byOpenid: options.byOpenid || null,
    byPhone: options.byPhone || null,
    current: options.byOpenid || options.byPhone || null,
    updates: [],
    created: [],
    rollbacks: 0,
    links: 0
  };
  const users = {
    findByOpenid: async () => state.byOpenid,
    findByPhone: async () => state.byPhone,
    updateWechatAccount: async (id, profile, updateOptions) => {
      if (options.updateError) throw options.updateError;
      const original = [state.byOpenid, state.byPhone].find((item) => item && item.id === id);
      const updated = {
        ...original,
        phone: profile.phone,
        openid: updateOptions.replaceOpenid ? profile.openid : original.openid,
        nickname: profile.nickname || original.nickname,
        sessionVersion: Number(original.sessionVersion || 0) + (updateOptions.bumpSessionVersion ? 1 : 0)
      };
      state.updates.push({ id, profile, options: updateOptions });
      state.current = updated;
      return updated;
    },
    createFromWechat: async (profile) => {
      const created = { id: "new-user", role: "user", sessionVersion: 0, ...profile };
      state.created.push(created);
      state.current = created;
      return created;
    },
    findById: async () => state.current,
    setRoleByPhone: async () => state.current
  };
  const database = {
    query: async () => ({ rows: [] }),
    transaction: async (handler) => {
      try { return await handler({}); }
      catch (error) { state.rollbacks += 1; throw error; }
    }
  };
  const service = createAuthService({
    db: database,
    userRepository: users,
    therapistService: {
      isUserBound: async () => !!options.therapistBound,
      isPhoneAssigned: async () => !!options.therapistPhoneAssigned,
      linkUserForPhone: async () => { state.links += 1; return {}; }
    },
    accessService: { enrichUser: async (user) => ({ ...user, effectiveRole: "member", therapistId: null }) },
    wechatService: {
      code2Session: async () => ({ openid: options.loginOpenid || "openid_X" }),
      getPhoneNumber: async () => options.loginPhone || "13800000002"
    },
    logService: { business: async () => {} },
    env: {
      jwtSecret: "auth-test-secret",
      jwtExpiresIn: "1h",
      isProduction: true,
      wechat: { mockLogin: false, mockAdmin: false }
    }
  });
  return { service, state };
}

test("new WeChat openid safely migrates an ordinary phone account without changing user id", async () => {
  const existing = {
    id: "100", openid: "openid_Y", phone: "13800000002", role: "user", sessionVersion: 4
  };
  const { service, state } = harness({ byPhone: existing });
  const result = await service.loginWithWechat({ loginCode: "code", phoneCode: "phone" });

  assert.equal(result.user.id, "100");
  assert.equal(result.user.openid, "openid_X");
  assert.equal(result.user.sessionVersion, 5);
  assert.equal(state.created.length, 0);
  assert.deepEqual(state.updates[0].options, { replaceOpenid: true, bumpSessionVersion: true });
  assert.equal(jwt.verify(result.token, "auth-test-secret").sv, 5);
});

test("different existing openid and phone owners are rejected without merging", async () => {
  const { service, state } = harness({
    byOpenid: { id: "101", openid: "openid_X", phone: "13800000001", role: "user" },
    byPhone: { id: "100", openid: "openid_Y", phone: "13800000002", role: "user" }
  });
  await assert.rejects(
    () => service.loginWithWechat({ loginCode: "code", phoneCode: "phone" }),
    { code: "ACCOUNT_IDENTITY_CONFLICT", status: 409, message: "当前登录身份与手机号分别属于不同账号，请联系门店处理" }
  );
  assert.equal(state.updates.length, 0);
  assert.equal(state.rollbacks, 1);
});

test("admin and therapist phone accounts cannot be automatically rebound", async () => {
  for (const account of [
    { id: "admin", openid: "old", phone: "13800000002", role: "admin" },
    { id: "therapist", openid: "old", phone: "13800000002", role: "user" }
  ]) {
    const { service, state } = harness({ byPhone: account, therapistBound: account.id === "therapist" });
    await assert.rejects(
      () => service.loginWithWechat({ loginCode: "code", phoneCode: "phone" }),
      { code: "ACCOUNT_IDENTITY_CONFLICT", status: 409 }
    );
    assert.equal(state.updates.length, 0);
    assert.equal(state.links, 0);
    assert.equal(state.rollbacks, 1);
  }
});

test("user identity unique violations are returned as explicit 409 conflicts", async () => {
  const error = Object.assign(new Error("duplicate"), {
    code: "23505", constraint: "users_openid_key", detail: "Key (openid) already exists"
  });
  const { service, state } = harness({
    byPhone: { id: "100", openid: "openid_Y", phone: "13800000002", role: "user" },
    updateError: error
  });
  await assert.rejects(
    () => service.loginWithWechat({ loginCode: "code", phoneCode: "phone" }),
    { code: "ACCOUNT_IDENTITY_CONFLICT", status: 409 }
  );
  assert.equal(state.rollbacks, 1);
});

test("real login refuses spoofed openid, phone and role before changing an account", async () => {
  for (const extra of [{ mockOpenid: "victim-openid" }, { mockPhone: "13800000000" }, { mockRole: "admin" }]) {
    const { service, state } = harness();
    await assert.rejects(service.loginWithWechat({ loginCode: "real-code", phoneCode: "phone-code", ...extra }), { code: "MOCK_LOGIN_DISABLED", status: 400 });
    assert.equal(state.created.length, 0);
    assert.equal(state.updates.length, 0);
  }
});
