const db = require('../config/db');
const currentActor = require('./currentActorService');
const repository = require('../repositories/serviceItemRepository');
const schedules = require('../repositories/scheduleRepository');
const images = require('./therapistImageService');
const audits = require('./auditService');
const { AppError } = require('../utils/errors');
const uuid = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || '');
function restoreIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !uuid(id))) {
    throw new AppError('INVALID_PROJECT_RESTORE', '请选择要恢复的项目', 400);
  }
  return [...new Set(ids)];
}
async function active(id, client) {
  if (!uuid(id)) throw new AppError('PROJECT_NOT_FOUND', '项目不存在', 404);
  const item = await repository.findById(id, client);
  if (!item || item.status !== 'active') throw new AppError('PROJECT_NOT_FOUND', '项目不存在或已删除', 404);
  return item;
}
async function audit(action, id, before, after, context, client) {
  await audits.record({ adminUserId: context.user.id, action, resourceType:'service_item', resourceId:id,
    before, after, requestId:context.requestId, ip:context.ip }, client);
}
async function save(id, input, context) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const effect = typeof input.effect === 'string' ? input.effect.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!name || name.length > 60 || effect.length > 120 || description.length > 5000 ||
      !Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 1440 ||
      !Number.isInteger(input.priceFen) || input.priceFen < 0 || input.priceFen > 100000000) {
    throw new AppError('INVALID_PROJECT', '项目信息格式有误，请检查后重试', 400);
  }
  if (!/^\/uploads\/therapists\/[0-9a-f-]+\.(jpg|png|webp)$/.test(input.imageUrl || '')) throw new AppError('INVALID_IMAGE', '请先上传项目图片', 400);
  return db.transaction(async client => {
    await currentActor.load(context, client, { admin: true });
    await images.assertExists(input.imageUrl);
    const before = id ? await active(id, client) : null;
    const duplicate = await db.query('SELECT id FROM service_items WHERE name=$1 AND ($2::uuid IS NULL OR id<>$2)', [name,id || null], client);
    if (duplicate.rows.length) throw new AppError('PROJECT_NAME_EXISTS', '项目名称已存在，请更换', 409);
    const values = [name, input.durationMinutes, effect, input.priceFen, description, input.imageUrl];
    const { rows } = id
      ? await db.query('UPDATE service_items SET name=$1,duration_minutes=$2,effect=$3,price_fen=$4,description=$5,image_url=$6,updated_at=now() WHERE id=$7 RETURNING *', [...values,id], client)
      : await db.query("INSERT INTO service_items(name,duration_minutes,effect,price_fen,description,image_url,sort_order) SELECT $1,$2,$3,$4,$5,$6,COALESCE(MAX(sort_order),0)+1 FROM service_items RETURNING *", values, client);
    const after = repository.mapServiceItem(rows[0]);
    await audit(id ? 'update_project':'create_project', after.id, before, after, context, client);
    return after;
  });
}
async function reorder(ids, context) {
  if (!Array.isArray(ids) || ids.some(id=>!uuid(id)) || new Set(ids).size!==ids.length) throw new AppError('INVALID_ORDER','项目顺序无效',400);
  return db.transaction(async client => {
    await currentActor.load(context, client, { admin: true });
    const current = await repository.listActive(client);
    if (current.length!==ids.length || current.some(item=>!ids.includes(item.id))) throw new AppError('PROJECT_LIST_CHANGED','项目列表已变化，请刷新后重试',409);
    await db.query('UPDATE service_items s SET sort_order=o.rank::int,updated_at=now() FROM unnest($1::uuid[]) WITH ORDINALITY o(id,rank) WHERE s.id=o.id', [ids], client);
    await audit('reorder_projects', null, {ids:current.map(i=>i.id)}, {ids}, context, client);
    return {items:await repository.listActive(client)};
  });
}
async function remove(id, context) {
  return db.transaction(async client => {
    await currentActor.load(context, client, { admin: true });
    const before = await active(id, client);
    const {rows} = await db.query("SELECT id FROM appointments a WHERE EXISTS (SELECT 1 FROM appointment_service_items ap WHERE ap.appointment_id=a.id AND ap.service_item_id=$1) AND status IN ('booked','checked_in') AND (date+end_time) AT TIME ZONE 'Asia/Shanghai'>clock_timestamp() LIMIT 1", [id], client);
    if (rows.length) throw new AppError('PROJECT_HAS_APPOINTMENTS','项目有未结束预约，暂不能删除',409);
    await db.query("UPDATE service_items SET status='inactive',updated_at=now() WHERE id=$1", [id], client);
    await schedules.removeProject(id, client);
    await audit('delete_project',id,before,{...before,status:'inactive'},context,client);
    return {deleted:true};
  });
}
async function recycleBin() {
  return repository.listInactive();
}
async function restore(ids, context) {
  const selectedIds = restoreIds(ids);
  return db.transaction(async client => {
    await currentActor.load(context, client, { admin: true });
    const locked = await repository.listInactiveByIdsForUpdate(selectedIds, client);
    if (locked.length !== selectedIds.length) {
      throw new AppError('PROJECT_RECYCLE_BIN_CHANGED', '项目状态已变化，请刷新后重试', 409);
    }
    const byId = new Map(locked.map(item => [item.id, item]));
    let sortOrder = await repository.maxActiveSortOrder(client);
    const restored = [];
    for (const id of selectedIds) {
      const before = byId.get(id);
      const after = await repository.restore(id, ++sortOrder, client);
      if (!after) throw new AppError('PROJECT_RECYCLE_BIN_CHANGED', '项目状态已变化，请刷新后重试', 409);
      await audit('restore_project', id, before, after, context, client);
      restored.push(after);
    }
    return { restored: restored.length, items: restored };
  });
}
async function purge(ids, context) {
  const selectedIds = restoreIds(ids);
  return db.transaction(async client => {
    await currentActor.load(context, client, { admin: true });
    const locked = await repository.listInactiveByIdsForUpdate(selectedIds, client);
    if (locked.length !== selectedIds.length) {
      throw new AppError('PROJECT_RECYCLE_BIN_CHANGED', '项目状态已变化，请刷新后重试', 409);
    }
    const byId = new Map(locked.map(item => [item.id, item]));
    for (const id of selectedIds) {
      const before = byId.get(id);
      const after = await repository.purge(id, client);
      if (!after) throw new AppError('PROJECT_RECYCLE_BIN_CHANGED', '项目状态已变化，请刷新后重试', 409);
      await audit('purge_project', id, before, after, context, client);
    }
    return { purged: selectedIds.length };
  });
}
module.exports = { list:repository.listActive, recycleBin, active, save, reorder, remove, restore, purge };
