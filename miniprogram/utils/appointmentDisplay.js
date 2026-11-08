function truncate(value, length) {
  const chars = Array.from(String(value || ""));
  return chars.length > length ? chars.slice(0, length).join("") + "…" : chars.join("");
}
function projects(appointment) {
  return appointment.serviceItems && appointment.serviceItems.length ? appointment.serviceItems
    : appointment.serviceItemId ? [{ id: appointment.serviceItemId, name: appointment.serviceItemName || "", imageUrl: "" }] : [];
}
function names(appointment) {
  return projects(appointment).map(item => item.name).join("、") || appointment.serviceItemName || "预约项目";
}
module.exports = { truncate, projects, names };
