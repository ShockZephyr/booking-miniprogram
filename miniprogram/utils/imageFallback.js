// Display state only: never replace the catalog's saved image URL on download failure.
function initialData() {
  return { imageSource: "", imageFailed: false, imageAttempt: 0, imageRequests: [] };
}

function sourcePatch(host, source, restart = false) {
  const imageSource = typeof source === "string" ? source : "";
  if (!restart && imageSource === host.data.imageSource) return {};
  const imageAttempt = (host.data.imageAttempt || 0) + 1;
  return {
    imageSource,
    imageFailed: false,
    imageAttempt,
    // Restart on manual retry or node recreation, without changing saved/signed URLs.
    imageRequests: imageSource ? [{ key: imageAttempt, src: imageSource }] : []
  };
}

function imageError(event) {
  if (!this.data.imageSource || Number(event.currentTarget.dataset.attempt) !== this.data.imageAttempt) return;
  this.setData({ imageFailed: true });
}

function retryImage() {
  if (!this.data.imageFailed || !this.data.imageSource) return;
  this.setData(sourcePatch(this, this.data.imageSource, true));
}

module.exports = { initialData, sourcePatch, imageError, retryImage };
