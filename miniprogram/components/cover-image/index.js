const fallback = require("../../utils/imageFallback");

Component({
  properties: { src: String, label: { type: String, value: "首页封面" } },
  data: fallback.initialData(),
  observers: { src(value) { this.setData(fallback.sourcePatch(this, value)); } },
  methods: { imageError: fallback.imageError, retry: fallback.retryImage }
});
