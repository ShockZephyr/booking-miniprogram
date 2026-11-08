const display = require("../../utils/appointmentDisplay");
const imageFallback = require("../../utils/imageFallback");
const { imageUrl } = require("../../services/therapist");

function displayPatch(host, value) {
  const appointment = value || {}, items = display.projects(appointment), name = display.names(appointment);
  // A changed appointment is a new image lifecycle even if its URL is reused.
  const changed = host._imageAppointmentId !== appointment.id;
  host._imageAppointmentId = appointment.id;
  return {
    ...imageFallback.sourcePatch(host, imageUrl(items[0] && items[0].imageUrl), changed),
    summary: display.truncate(name, 14),
    detailSummary: display.truncate(name, 10),
    adminDetailSummary: display.truncate(name, 8),
    projectNames: name,
    noteSummary: display.truncate(appointment.note, 10)
  };
}

Component({
  data: { ...imageFallback.initialData(), summary: "", detailSummary: "", adminDetailSummary: "", projectNames: "", noteSummary: "", retryIconFailed: false },
  properties: {
    appointment: { type: Object, value: {} },
    showActions: { type: Boolean, value: true },
    actionMode: { type: String, value: "user" },
    showMemberInfo: { type: Boolean, value: false },
    selected: { type: Boolean, value: false },
    detail: { type: Boolean, value: false },
    busy: { type: Boolean, value: false }
  },
  observers: {
    appointment(value) {
      this.setData(displayPatch(this, value));
    }
  },
  methods: {
    imageError: imageFallback.imageError,
    retryImage: imageFallback.retryImage,
    retryIconError() { this.setData({ retryIconFailed: true }); },
    action(event) {
      if (this.properties.busy) return;
      this.triggerEvent("action", {
        type: event.currentTarget.dataset.type,
        appointment: this.properties.appointment
      });
    }
  }
});
