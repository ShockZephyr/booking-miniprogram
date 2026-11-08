const userRepository = require("../repositories/userRepository");
const db = require("../config/db");
const { logger } = require("../config/logger");

async function seedAdmin() {
  const phone = process.argv[2] || process.env.ADMIN_PHONE;
  if (!phone) {
    throw new Error("Usage: npm run seed:admin -- 13800000000");
  }
  const user = await userRepository.setRoleByPhone(phone, "admin");
  if (!user) {
    throw new Error("User not found. Log in once with this phone before promoting to admin.");
  }
  logger.info({ userId: user.id, phone }, "admin_seeded");
  await db.close();
}

seedAdmin().catch(async (error) => {
  logger.error({ error: error.message }, "seed_admin_failed");
  await db.close();
  process.exit(1);
});

