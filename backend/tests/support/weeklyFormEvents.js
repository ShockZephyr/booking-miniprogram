const handlers = ["pickWeekday", "retry", "allPeople", "selectPeople", "allDays", "pickDays",
  "setStep", "setMinimum", "setTime", "removeRange", "addRange", "selectProjects", "allProjects", "save"];

// Native events carry the dataset from their rendered control. Ordinary test
// calls model a fresh event; explicit versions are retained for delayed replays.
function formEvent(page, event = {}) {
  return { ...event, currentTarget: { ...event.currentTarget,
    dataset: { formVersion: page.data.formVersion, ...(event.currentTarget && event.currentTarget.dataset) } } };
}

function install(page) {
  const raw = {};
  for (const name of handlers) {
    raw[name] = page[name].bind(page);
    page[name] = event => raw[name](formEvent(page, event));
  }
  return raw;
}

module.exports = { handlers, formEvent, install };
