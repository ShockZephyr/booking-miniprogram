const { AppError } = require("./errors");
const { encodeCursor, decodeCursor } = require("./cursor");

const DEFAULT_SORT = "service_desc";
const SORTS = new Set(["service_asc", "service_desc", "created_asc", "created_desc"]);

function parseAppointmentSort(value = DEFAULT_SORT) {
  if (typeof value !== "string" || !SORTS.has(value)) {
    throw new AppError("INVALID_SORT", "排序方式无效，请重新选择", 400);
  }
  return value;
}

function appointmentOrder(value, cursor) {
  const sort = parseAppointmentSort(value);
  // Preserve existing clients' default cursors; other orders have distinct scopes.
  const scope = sort === DEFAULT_SORT ? "" : sort;
  const position = decodeCursor(cursor, "appointments", scope);
  const service = sort.startsWith("service_");
  const direction = sort.endsWith("_asc") ? "ASC" : "DESC";
  const columns = service ? ["a.date", "a.start_time", "a.created_at", "a.id"] : ["a.created_at", "a.id"];
  const types = service ? ["date", "time", "timestamptz", "uuid"] : ["timestamptz", "uuid"];
  return {
    position,
    sql: columns.map(column => `${column} ${direction}`).join(", "),
    after(params) {
      if (!position) return "";
      const first = params.length + 1;
      params.push(...(service ? position : position.slice(2)));
      const placeholders = types.map((type, index) => `$${first + index}::${type}`).join(", ");
      return ` AND (${columns.join(", ")}) ${direction === "ASC" ? ">" : "<"} (${placeholders})`;
    },
    cursor(values) { return encodeCursor("appointments", values, scope); }
  };
}

module.exports = { DEFAULT_SORT, parseAppointmentSort, appointmentOrder };
