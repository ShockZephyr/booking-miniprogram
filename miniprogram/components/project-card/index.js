const imageFallback = require("../../utils/imageFallback");

Component({
  data: Object.assign(imageFallback.initialData(), { retryIconFailed: false }),
  properties: {
    project: Object,
    actionLabel: { type: String, value: "查看项目" }
  },
  observers: {
    "project.imageSrc"(source) { this.setData(imageFallback.sourcePatch(this, source)); }
  },
  methods: {
    imageError: imageFallback.imageError,
    retryImage: imageFallback.retryImage,
    retryIconError() { this.setData({ retryIconFailed: true }); },
    tap() { this.triggerEvent("select", { project: this.data.project }); }
  }
});
