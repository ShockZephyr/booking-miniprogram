const db = require("../config/db");
const { mapUser } = require("./userRepository");
const therapists = require("./therapistRepository");
const schedules = require("./scheduleRepository");
const { AppError } = require("../utils/errors");

async function findOrCreate(identity, client) {
  const name = { admin: "审核测试管理员", user: "审核测试会员", therapist: "审核测试芳疗师" }[identity];
  if (!name) throw new AppError("INVALID_REQUEST", "请选择有效的测试身份", 400);
  const role = identity === "admin" ? "admin" : "user";
  const { rows } = await db.query(`INSERT INTO users(openid, phone, role, nickname, review_identity)
    VALUES($1, $1, $2::text::user_role, $3, $4)
    ON CONFLICT (review_identity) DO NOTHING RETURNING *`, [`review:${identity}`, role, name, identity], client);
  if (rows.length && identity === "user") {
    await db.query(`INSERT INTO member_whitelist(phone, remark_name, status)
      VALUES($1, $2, 'active') ON CONFLICT(phone) DO NOTHING`, [`review:${identity}`, name], client);
  }
  if (rows.length && identity === "therapist") {
    // Initialize only once. A later login must never restore deleted staff or
    // overwrite their projects, schedule, profile, or account binding.
    const therapist = await therapists.save(null, {
      name, bio: "用于审核测试的芳疗师", phone: "review:therapist", userId: rows[0].id,
      serviceItemIds: [], imageUrl: ""
    }, client);
    for (let weekday = 1; weekday <= 7; weekday++) {
      await schedules.saveWeekly(therapist.id, weekday, {
        step: 30, minDuration: 90, serviceItemIds: [], ranges: [
          { startTime: "09:00", endTime: "12:00" },
          { startTime: "14:00", endTime: "17:00" },
          { startTime: "19:00", endTime: "21:00" }
        ]
      }, client);
    }
  }
  const result = await db.query("SELECT * FROM users WHERE review_identity = $1 FOR UPDATE", [identity], client);
  if (identity === "therapist") {
    const therapist = await therapists.findActiveByUserId(result.rows[0].id, client, true);
    if (!therapist || therapist.phone !== "review:therapist") {
      throw new AppError("REVIEW_ACCOUNT_CONFLICT", "测试芳疗师已停用或绑定异常，请联系管理员处理", 409);
    }
  }
  return mapUser(result.rows[0]);
}

module.exports = { findOrCreate };
