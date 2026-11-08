function projectItems(appointment) {
  if (Array.isArray(appointment.serviceItems) && appointment.serviceItems.length) return appointment.serviceItems;
  return appointment.serviceItemId ? [{ id: appointment.serviceItemId, name: appointment.serviceItemName || "", imageUrl: "" }] : [];
}
function projectIds(appointment) {
  const ids = Array.isArray(appointment.serviceItemIds) ? appointment.serviceItemIds : projectItems(appointment).map(item => item.id);
  return ids.map(id => String(id).toLowerCase());
}
function publicRevision({ id, createdAt, before }) {
  const { date, startTime, endTime, note } = before;
  const serviceItems = projectItems(before).map(({ id, name }) => ({ id, name }));
  return { id, createdAt, before: { date, startTime, endTime, note, serviceItems,
    serviceItemName: serviceItems.map(item => item.name).join("、") } };
}
module.exports = { projectItems, projectIds, publicRevision };
