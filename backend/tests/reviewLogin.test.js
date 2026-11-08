process.env.NODE_TEST_CONTEXT = "1";
process.env.DATABASE_URL = "";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createReviewLoginService } = require("../src/services/reviewLoginService");
const session = require("../src/services/reviewSession");
const { sanitizeLogPayload } = require("../src/utils/privacy");

function harness() {
  const state = { count: 0, log: [], rollback: 0, clock: Date.now(), onLock: () => {} };
  const config = { jwtSecret: crypto.randomBytes(32).toString("hex"), reviewLogin: {
    enabled: true, code: crypto.randomBytes(32).toString("hex"), expiresAt: new Date(state.clock + 3600000).toISOString()
  } };
  const users = {};
  const service = createReviewLoginService({ env: config, now: () => state.clock,
    lockIdentity: async () => state.onLock(),
    db: { transaction: async run => { try { return await run({}); } catch (error) { state.rollback++; throw error; } } },
    accounts: { findOrCreate: async identity => {
      state.count++;
      return users[identity] ||= { id: identity, openid: `review:${identity}`, phone: `review:${identity}`,
        role: identity === "admin" ? "admin" : "user", reviewIdentity: identity, sessionEpoch: "epoch", sessionVersion: 0 };
    } },
    access: { enrichUser: async user => ({ ...user, effectiveRole: user.role === "admin" ? "admin" : "member",
      therapistId: state.badBinding ? null : user.reviewIdentity === "therapist" ? "review-therapist-id" : null }) },
    logs: { business: async entry => state.log.push(entry) }
  });
  const login = (account = "user", more = {}) => service.login({ account, reviewCode: config.reviewLogin.code, ...more });
  return { state, config, users, service, login };
}

test("review login only grants the selected fixed account; no phone, id or mock role input", async () => {
  const h = harness();
  for (const account of ["user", "admin", "therapist"]) {
    const result = await h.login(account);
    assert.equal(result.user.role, account === "admin" ? "admin" : "user");
    assert.equal(result.user.phone, `review:${account}`);
    const decoded = jwt.verify(result.token, session.signingKey(h.config));
    session.assertSession(result.user, decoded.review, h.config, h.state.clock);
    assert.ok(decoded.exp * 1000 <= Date.parse(h.config.reviewLogin.expiresAt));
    assert.equal((await h.login(account)).user.id, result.user.id);
  }
  for (const extra of [{ phone: "13900000001" }, { userId: "someone" }, { mockRole: "admin" }]) {
    await assert.rejects(h.login("user", extra), { code: "INVALID_REQUEST" });
  }
  await assert.rejects(h.login("unknown"), { code: "INVALID_REQUEST" });
  assert.equal(h.state.count, 6);
  assert.ok(!JSON.stringify(h.state.log).includes(h.config.reviewLogin.code));
  assert.deepEqual(h.service.availability(), { testLoginEnabled: true });
});

test("review therapist requires a live binding and never acquires the admin role", async () => {
  const h = harness();
  const { user, token } = await h.login("therapist");
  assert.equal(user.role, "user"); assert.ok(user.therapistId);
  const decoded = jwt.verify(token, session.signingKey(h.config));
  assert.equal(decoded.role, "user");
  session.assertSession(user, decoded.review, h.config, h.state.clock);
  assert.throws(() => session.assertSession({ ...user, role: "admin" }, decoded.review, h.config, h.state.clock), { code: "INVALID_SESSION" });
  h.state.badBinding = true;
  await assert.rejects(h.login("therapist"), { code: "REVIEW_ACCOUNT_CONFLICT" });
  h.config.reviewLogin.enabled = false;
  assert.throws(() => session.assertSession(user, decoded.review, h.config, h.state.clock), { code: "INVALID_SESSION" });
});

test("disabled, expired and incorrect code never reach account creation", async () => {
  const h = harness();
  await assert.rejects(h.login("admin", { reviewCode: "wrong" }), { code: "REVIEW_CODE_INVALID" });
  h.config.reviewLogin.enabled = false;
  assert.deepEqual(h.service.availability(), { testLoginEnabled: false });
  await assert.rejects(h.login(), { code: "REVIEW_LOGIN_DISABLED" });
  h.config.reviewLogin.enabled = true;
  h.state.clock = Date.parse(h.config.reviewLogin.expiresAt);
  await assert.rejects(h.login(), { code: "REVIEW_LOGIN_DISABLED" });
  assert.equal(h.state.count, 0);
});

test("a legacy normal-token verifier cannot accept a review admin token after rollback", async () => {
  const h = harness();
  const { token } = await h.login("admin");
  const header = jwt.decode(token, { complete: true }).header;
  assert.equal(header.kid, session.TOKEN_KEY_ID);
  assert.equal(header.alg, "HS256");
  // This is the exact key/verification contract used by the backend before review login.
  assert.throws(() => jwt.verify(token, h.config.jwtSecret), { name: "JsonWebTokenError", message: "invalid signature" });
  h.config.reviewLogin.enabled = false;
  assert.throws(() => jwt.verify(token, h.config.jwtSecret), { name: "JsonWebTokenError" });
  const normal = jwt.sign({ sub: "real-admin" }, h.config.jwtSecret);
  assert.equal(jwt.verify(normal, h.config.jwtSecret).sub, "real-admin");
});

test("expiry while waiting for the identity lock aborts the login transaction", async () => {
  const h = harness();
  h.state.onLock = () => { h.state.clock = Date.parse(h.config.reviewLogin.expiresAt); };
  await assert.rejects(h.login(), { code: "REVIEW_LOGIN_DISABLED" });
  assert.equal(h.state.rollback, 1);
  assert.equal(h.state.count, 0);
});

test("review JWT is capped at eight hours and disabling or rotating revokes it only for review identities", async () => {
  const h = harness();
  h.config.reviewLogin.expiresAt = new Date(h.state.clock + 48 * 3600000).toISOString();
  const { token, user } = await h.login("admin");
  const decoded = jwt.verify(token, session.signingKey(h.config));
  assert.ok(decoded.exp * 1000 <= h.state.clock + 8 * 3600000);
  assert.throws(() => session.assertSession(user, undefined, h.config), { code: "INVALID_SESSION" });
  assert.throws(() => session.assertSession({ ...user, reviewIdentity: null }, decoded.review, h.config), { code: "INVALID_SESSION" });
  h.config.reviewLogin.enabled = false;
  assert.throws(() => session.assertSession(user, decoded.review, h.config), { code: "INVALID_SESSION" });
  session.assertSession({ id: "real", role: "admin" }, undefined, h.config);
  h.config.reviewLogin.enabled = true;
  h.config.reviewLogin.code = crypto.randomBytes(32).toString("hex");
  assert.throws(() => session.assertSession(user, decoded.review, h.config), { code: "INVALID_SESSION" });
});

test("review code is redacted from structured logs and embedded error strings", () => {
  const secret = crypto.randomBytes(32).toString("hex");
  const result = sanitizeLogPayload({ reviewCode: secret, nested: { REVIEW_LOGIN_CODE: secret }, message: `reviewCode=${secret}` });
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("only review-account constraint conflicts become 409; unrelated database failures remain server errors", async () => {
  for (const error of [
    { code: "23505", table: "users" },
    { code: "23505", table: "business_activity_logs" },
    { code: "08006" }
  ]) {
    const h=harness();
    h.state.onLock=()=>{throw error;};
    await assert.rejects(h.login(), actual => error.table === "users"
      ? actual.code === "REVIEW_ACCOUNT_CONFLICT" && actual.status === 409 : actual === error);
  }
});
