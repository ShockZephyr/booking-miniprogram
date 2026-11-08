const db = require("../config/db");
const covers = require("../repositories/coverRepository");
const actor = require("./currentActorService");
const images = require("./therapistImageService");
const audits = require("./auditService");
const { AppError } = require("../utils/errors");

const managedImage = /^\/uploads\/therapists\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\.(?:jpg|png|webp)$/;
const changed = () => new AppError("COVER_CHANGED", "封面已变化，请刷新后重试", 409);

function mutate(context, work) {
  return db.transaction(async client => {
    // This identity lock also serializes catalog writes with orphan cleanup.
    await actor.load(context, client, { admin: true });
    return work(await covers.list(client), client);
  });
}

function audit(context, action, id, before, after, client) {
  return audits.record({ adminUserId: context.user.id, resourceType: "home_cover", resourceId: id,
    action, before, after, requestId: context.requestId, ip: context.ip }, client);
}

function current(items, id, previousImageUrl) {
  const row = items.find(item => item.id === id);
  if (!row || row.imageUrl !== previousImageUrl) throw changed();
  return row;
}

function save(id, input, context) {
  return mutate(context, async (items, client) => {
    const imageUrl = input?.imageUrl;
    if (typeof imageUrl !== "string" || !managedImage.test(imageUrl)) throw new AppError("INVALID_IMAGE", "请上传封面图片", 400);
    const key = input?.creationKey;
    if (!id && key !== undefined) {
      if (typeof key !== "string" || !/^[a-z0-9-]{8,80}$/.test(key)) throw new AppError("INVALID_CREATION_KEY", "新增操作标识无效", 400);
      const receipt = await covers.creation(context.user.id, key, client);
      if (receipt) {
        if (receipt.imageUrl !== imageUrl) throw changed();
        return { item: current(items, receipt.id, imageUrl) };
      }
    }
    if (!id && items.length >= 5) throw new AppError("COVER_LIMIT", "最多只能添加5张封面", 409);
    // A replacement whose successful response was lost may already have taken effect.
    if (id && typeof input.previousImageUrl === "string" && managedImage.test(input.previousImageUrl)
      && items.some(row => row.id === id && row.imageUrl === imageUrl)) {
      return { item: { id, imageUrl } };
    }
    const before = id ? current(items, id, input.previousImageUrl) : null;
    await images.assertExists(imageUrl, "COVER_UPLOAD_MISSING");
    await db.query("DELETE FROM image_cleanup_candidates WHERE image_url=$1", [imageUrl], client);
    if (id) await covers.replace(id, imageUrl, client);
    else id = await covers.insert(imageUrl, items.length + 1, client);
    const item = { id, imageUrl };
    if (!before && key !== undefined) await covers.rememberCreation(context.user.id, key, item, client);
    await audit(context, before ? "replace_cover" : "create_cover", id, before, item, client);
    return { item };
  });
}

function remove(id, previousImageUrl, context) {
  return mutate(context, async (items, client) => {
    const before = current(items, id, previousImageUrl);
    await covers.remove(id, client);
    await audit(context, "delete_cover", id, before, null, client);
    return { deleted: true };
  });
}

function reorder(input, context) {
  return mutate(context, async (items, client) => {
    const { ids, previousIds } = input || {};
    const original = items.map(item => item.id);
    if (!Array.isArray(previousIds) || original.length !== previousIds.length ||
      original.some((id, index) => id !== previousIds[index])) throw changed();
    if (!Array.isArray(ids) || ids.length !== original.length || new Set(ids).size !== ids.length ||
      ids.some(id => !original.includes(id))) throw new AppError("INVALID_ORDER", "封面顺序无效", 400);
    await covers.reorder(ids, client);
    await audit(context, "reorder_covers", null, { ids: original }, { ids }, client);
    return { items: await covers.list(client) };
  });
}

module.exports = { list: covers.list, save, remove, reorder };
