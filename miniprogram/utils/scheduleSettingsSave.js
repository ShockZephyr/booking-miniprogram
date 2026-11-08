// In-flight saves outlive a page instance, but never supply cached settings or drafts.
const pendingBySession = new Map();

function track(owner, task) {
  let pending = pendingBySession.get(owner);
  if (!pending) {
    pending = new Set();
    pendingBySession.set(owner, pending);
  }
  pending.add(task);
  const clear = () => {
    pending.delete(task);
    if (!pending.size && pendingBySession.get(owner) === pending) pendingBySession.delete(owner);
  };
  task.then(clear, clear);
  return task;
}

async function wait(owner) {
  while (pendingBySession.has(owner)) {
    const pending = [...pendingBySession.get(owner)];
    // A failed save must also release readers; the page handles its own failure UI.
    await Promise.all(pending.map(task => task.then(() => {}, () => {})));
  }
}

module.exports = { track, wait };
