const test = require('node:test');
const assert = require('node:assert/strict');
const { summaryFromRows, encodePosition, decodePosition, queryKey } = require('../src/utils/appointmentInbox');

test('inbox counts bookings once, groups no-shows, and routes created before changed', () => {
  const rows = [{ kind: 'created', status: 'booked', count: 2 }, { kind: 'created', status: 'no_show', count: 1 },
    { kind: 'modified', status: 'checked_in', count: 4 }, { kind: 'cancelled', status: 'cancelled', count: 5 }];
  const value = summaryFromRows(rows);
  assert.deepEqual(value, { created: 3, changed: 9, total: 12, target: 'pending',
    tabs: { pending: 3, checked_in: 4, cancelled: 5, all: 12 } });
});

test('home priority handles every type/status combination, including checked-in new appointments', () => {
  const row = (kind, status) => ({ kind, status, count: 1 });
  const cancelled = row('cancelled', 'cancelled');
  assert.equal(summaryFromRows([cancelled]).target, 'cancelled');
  assert.equal(summaryFromRows([cancelled, row('modified','checked_in')]).target, 'checked_in');
  assert.equal(summaryFromRows([cancelled, row('modified','checked_in'), row('modified','no_show')]).target, 'pending');
  assert.equal(summaryFromRows([row('created','checked_in'), row('modified','booked'), cancelled]).target, 'checked_in');
  assert.equal(summaryFromRows([row('created','checked_in'), row('created','booked')]).target, 'pending');
  assert.deepEqual(summaryFromRows([]).tabs, { pending: 0, checked_in: 0, cancelled: 0, all: 0 });
  assert.equal(summaryFromRows([]).target, null);
});

test('snapshot cursors validate shape; filter/sort changes bind a new list', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(decodePosition(encodePosition(id,20)), { kind:'appointment-inbox',viewId:id,position:20 });
  for (const cursor of ['not-json', encodePosition('bad', 1), encodePosition(id,-1), encodePosition(id,0.5)]) {
    assert.throws(() => decodePosition(cursor), { code:'INVALID_CURSOR' });
  }
  assert.equal(queryKey({ status:'all',sort:'created_desc',page:1 }), queryKey({ status:'all',sort:'created_desc',page:2,cursor:'abc' }));
  assert.notEqual(queryKey({ status:'all',sort:'created_desc' }), queryKey({ status:'all',sort:'created_asc' }));
  assert.notEqual(queryKey({ status:'all',sort:'created_desc' }), queryKey({ status:'pending',sort:'created_desc' }));
});

test('read receipt validation normalizes UUID identities before duplicate checks without changing the caller payload', async () => {
  const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
  const source=path.join(__dirname,'../src/services/appointmentInboxService.js');
  const { createRequire }=require('node:module');
  const localRequire=createRequire(source), module={exports:{}}, writes=[];
  const mocks={
    '../config/db':{transaction:async run=>run({})},
    './currentActorService':{load:async()=>({id:'staff',role:'admin'})},
    './noShowService':{},
    '../repositories/appointmentInboxRepository':{acknowledge:async (actor,viewId,entries)=>{
      writes.push({viewId,entries});return {acknowledged:entries.map(item=>item.id)};
    }}
  };
  vm.runInNewContext(fs.readFileSync(source,'utf8'),{module,require:name=>mocks[name]||localRequire(name)});
  const id='abcdefab-cdef-4abc-8def-abcdefabcdef', another='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  for (const entries of [
    [{id,version:'1'},{id:id.toUpperCase(),version:'1'}],
    [{id,version:'1'},{id:id.toUpperCase(),version:'2'}],
    [{id,version:'1'},{id,version:'1'}],
    [{id:[id],version:'1'}]
  ]) {
    await assert.rejects(module.exports.acknowledge({viewId:id,entries},{}),{code:'INVALID_READ_CONFIRMATION',status:400});
  }
  assert.equal(writes.length,0,'invalid input must not reach a database write');
  const body={viewId:id.toUpperCase(),entries:[{id:id.toUpperCase(),version:'9'},{id:another,version:'3'}]};
  const before=JSON.stringify(body);
  await module.exports.acknowledge(body,{});
  assert.equal(JSON.stringify(body),before);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)),[{viewId:id,entries:[{id,version:'9'},{id:another,version:'3'}]}]);
});
