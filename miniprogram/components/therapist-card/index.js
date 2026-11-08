const imageFallback = require("../../utils/imageFallback");

Component({ data: Object.assign(imageFallback.initialData(), { retryIconFailed: false, bioPreview: "" }), properties: {
  therapist: Object,
  selected: Boolean,
  variant: { type: String, value: "catalog" },
  actionLabel: { type: String, value: "查看芳疗师" }
}, observers: {
  "therapist.imageSrc"(source) { this.setData(imageFallback.sourcePatch(this, source)); },
  "therapist.bio"(bio) {
    const characters = Array.from(typeof bio === "string" ? bio.replace(/\s+/g, " ").trim() : "");
    const bioPreview = characters.length > 30 ? characters.slice(0, 30).join("") + "......" : characters.join("");
    if (bioPreview !== this.data.bioPreview) this.setData({ bioPreview });
  }
}, methods: {
  imageError: imageFallback.imageError,
  retryImage: imageFallback.retryImage,
  retryIconError() { this.setData({ retryIconFailed: true }); },
  tap() { this.triggerEvent("select", { therapist: this.data.therapist }); }
} });
