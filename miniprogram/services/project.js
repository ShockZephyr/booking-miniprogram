const request = require('../utils/request');
const portraits = require('./therapist');
const cache = require('../utils/resourceCache');
function decorate(item) {
  return Object.assign({}, item, {imageSrc:portraits.imageUrl(item.imageUrl), priceText:item.priceFen == null ? '价格待定' : `¥${(item.priceFen/100).toFixed(2)}`});
}
module.exports = {
  list: (options = {}) => cache.get(cache.KEYS.projects,
    () => request({url:'/api/projects',anonymous:true}).then(data=>({items:data.items.map(decorate)})),
    {force:options.force,ttl:30 * 1000}),
  detail: id => request({url:`/api/projects/${id}`,anonymous:true}).then(data=>({item:decorate(data.item)})),
  recycleBin: () => request({url:'/api/admin/projects/recycle-bin'}).then(data=>({items:data.items.map(decorate),retentionDays:data.retentionDays})),
  save: (id,data) => request({url:`/api/admin/projects${id ? '/'+id : ''}`,method:id?'PATCH':'POST',data}).then(invalidate),
  remove: id => request({url:`/api/admin/projects/${id}`,method:'DELETE'}).then(invalidate),
  restore: ids => request({url:'/api/admin/projects/restore',method:'PATCH',data:{ids}}).then(invalidate),
  purge: ids => request({url:'/api/admin/projects/purge',method:'POST',data:{ids}}).then(invalidate),
  reorder: ids => request({url:'/api/admin/projects/order',method:'PATCH',data:{ids}}).then(invalidate),
  upload: portraits.upload
};

function invalidate(result) {
  cache.invalidate([cache.KEYS.projects, cache.KEYS.serviceItems, cache.KEYS.therapists]);
  return result;
}
