const db = require("../config/db");
const { sanitizeLogPayload } = require("../utils/privacy");

async function create(alert) {
  alert = sanitizeLogPayload(alert);
  const { rows } = await db.query(
    `
      INSERT INTO alerts (type, level, message, metadata)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    [alert.type, alert.level || "warning", alert.message, alert.metadata || null]
  );
  return rows[0];
}

async function recent(limit = 20) {
  const { rows } = await db.query(
    "SELECT * FROM alerts ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return rows;
}

module.exports = {
  create,
  recent
};

