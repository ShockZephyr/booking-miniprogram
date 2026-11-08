const LEAD_TIME_MS = 60 * 60 * 1000;

function canCheckIn(appointment) {
  if (!appointment || !["booked", "no_show"].includes(appointment.status)) return false;
  const start = new Date(`${appointment.date}T${appointment.startTime}:00+08:00`).getTime();
  return Number.isFinite(start) && Date.now() >= start - LEAD_TIME_MS;
}

function stopWatching(page) {
  if (page._checkInTimer !== undefined) clearInterval(page._checkInTimer);
  page._checkInTimer = undefined;
}

function startWatching(page, refresh) {
  stopWatching(page);
  refresh.call(page);
  page._checkInTimer = setInterval(() => refresh.call(page), 1000);
}

module.exports = { canCheckIn, startWatching, stopWatching };
