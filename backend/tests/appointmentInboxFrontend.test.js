const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname,'../../miniprogram');
const flush = () => new Promise(resolve=>setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));

function harness(surface='list',role='admin',query={}) {
  const user={id:'account-a',role:role==='admin'?'admin':'user',therapistId:role==='therapist'?'therapist-a':null};
  const app={globalData:{user,token:'session-a'},_loginSessionVersion:1,refreshMe:async()=>app.globalData.user};
  const calls=[],nav=[],toasts=[],timers=new Map(),renders=[];
  let timerId=0,page;
  const request=options=>new Promise((resolve,reject)=>calls.push({...options,resolve,reject}));
  const modules={};
  function service(file) {
    if(modules[file]) return modules[file];
    const module={exports:{}};
    vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),{module,require:name=>{
      if(name.endsWith('/request'))return request;
      return {};
    }});
    return modules[file]=module.exports;
  }
  const deps={
    '../../services/admin':service('services/admin.js'),
    '../../services/appointment':service('services/appointment.js'),
    '../../services/therapistPortal':service('services/therapistPortal.js'),
    '../../services/appointmentInbox':service('services/appointmentInbox.js'),
    '../../services/user':{business:async()=>({}),serviceItems:async()=>({items:[]})},
    '../../services/therapist':{list:async()=>({therapists:[]})},
    '../../services/project':{list:async()=>({items:[]})},
    '../../services/cover':{list:async()=>[]},
    '../../utils/checkIn':{canCheckIn:()=>false,startWatching(){},stopWatching(){}},
    '../../utils/date':{today:()=> '2026-11-11',isExpired:()=>false},
    '../../utils/filterTime':require('../../miniprogram/utils/filterTime')
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,surface==='home'?'pages/home/index.js':'pages/my-appointments/index.js'),'utf8'),{
    Page:value=>{page=value;},getApp:()=>app,require:name=>deps[name]||{},
    setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},
    clearTimeout:id=>timers.delete(id),
    wx:{showToast:x=>toasts.push(x.title),setNavigationBarTitle(){},navigateTo:x=>nav.push(x),pageScrollTo(){}}
  });
  page.data=clone(page.data);
  page.setData=(patch,callback)=>{Object.assign(page.data,patch);if(callback)renders.push(callback);};
  if(surface==='list') {
    page.onLoad(query);
    page.loadFilterOptions=()=>{};
    page.showForUser(user);
  } else page.onShow();
  return {page,app,calls,nav,toasts,timers,renders,
    render:()=>{while(renders.length)renders.shift()();},
    tick:()=>{const entries=[...timers.entries()];timers.clear();for(const [,{fn}]of entries)fn();}
  };
}
function result(id='a',version='1',kind='created',hasMore=false) {
  return {appointments:[{id,status:'no_show',unreadKind:kind,unreadVersion:version}],
    inboxViewId:'view-a',unread:{created:1,changed:0,total:1,tabs:{pending:1,all:1}},
    pagination:{page:1,hasMore,nextCursor:hasMore?'snapshot-page-2':''}};
}
const readCalls=h=>h.calls.filter(c=>c.url==='/api/appointment-inbox/read');

for(const role of ['admin','therapist'])test(`${role}: only rendered pages acknowledge exact versions; indicators and order stay until refresh`,async()=>{
  const h=harness('list',role,{inbox:'1',status:'pending'});
  const url=new URL(h.calls[0].url,'http://localhost');
  assert.equal(url.searchParams.get('sort'),'created_desc');
  assert.equal(url.searchParams.get('unread'),'1');
  for(const key of ['serviceItemIds','therapistIds','fromDate','toDate']) assert.equal(url.searchParams.has(key),false);
  h.calls[0].resolve(result('a','7','modified',true));await flush();
  assert.equal(readCalls(h).length,0,'setData completion must precede acknowledgment');
  h.render();await flush();
  const ack=readCalls(h)[0];assert.deepEqual(clone(ack.data),{viewId:'view-a',entries:[{id:'a',version:'7'}]});
  ack.resolve({acknowledged:['a']});await flush();
  assert.equal(h.page.data.appointments[0].unreadKind,'modified');
  assert.equal(h.page.data.unreadTabs.pending,1);
  h.page.onReachBottom();
  const next=h.calls.at(-1);assert.match(next.url,/cursor=snapshot-page-2/);
  next.resolve({...result('b','2','created'),pagination:{page:2,hasMore:false}});await flush();h.render();await flush();
  assert.deepEqual(clone(readCalls(h)[1].data.entries),[{id:'b',version:'2'}]);
  assert.deepEqual(clone(h.page.data.appointments.map(a=>a.id)),['a','b']);
  h.page.onHide();
});

test('ordinary customers keep normal sorting and never acknowledge staff unread',async()=>{
  const h=harness('list','user');
  assert.doesNotMatch(h.calls[0].url,/unread=/);
  h.calls[0].resolve({appointments:[{id:'own',status:'booked'}]});await flush();h.render();await flush();
  assert.equal(readCalls(h).length,0);assert.deepEqual(clone(h.page.data.unreadTabs),{});
});

test('hidden response, stale render callback and switched account never acknowledge unseen records',async()=>{
  for(const stage of ['response','render','microtask','account']) {
    const h=harness();
    if(stage==='response')h.page.onHide();
    h.calls[0].resolve(result());await flush();
    if(stage==='render')h.page.onHide();
    if(stage==='account') {
      h.app.globalData.user={id:'account-b',role:'admin'};h.app.globalData.token='session-b';
      h.page.showForUser(h.app.globalData.user);
    }
    h.render();
    if(stage==='microtask')h.page.onHide();
    await flush();
    assert.equal(readCalls(h).length,0,stage);
    if(stage==='account')assert.deepEqual(clone(h.page.data.unreadTabs),{});
    h.page.onUnload();
  }
});

test('read failure retries only the same visible snapshot; hide cancels retry and leaves markers',async()=>{
  const h=harness();h.calls[0].resolve(result());await flush();h.render();await flush();
  readCalls(h)[0].reject(new Error('offline'));await flush();
  assert.equal(h.timers.size,1);assert.equal(h.page.data.appointments[0].unreadKind,'created');
  h.tick();await flush();
  assert.deepEqual(clone(readCalls(h)[1].data),clone(readCalls(h)[0].data));
  readCalls(h)[1].reject(new Error('offline'));await flush();
  h.page.onHide();assert.equal(h.timers.size,0);
  h.tick();assert.equal(readCalls(h).length,2);
});

test('an old-account read response cannot replace new markers or consume its queued page',async()=>{
  const h=harness();h.calls[0].resolve(result('old','3'));await flush();h.render();await flush();
  const oldRead=readCalls(h)[0];
  h.app.globalData.user={id:'account-b',role:'admin'};h.app.globalData.token='session-b';
  h.page.showForUser(h.app.globalData.user);
  const next=h.calls.at(-1);next.resolve({...result('new','8','modified'),inboxViewId:'view-b',unread:{tabs:{pending:2,all:2}}});
  await flush();h.render();await flush();
  oldRead.resolve({acknowledged:['old']});await flush();
  assert.deepEqual(clone(readCalls(h)[1].data),{viewId:'view-b',entries:[{id:'new',version:'8'}]});
  assert.equal(h.page.data.unreadTabs.pending,2);assert.equal(h.page.data.appointments[0].id,'new');
  readCalls(h)[1].resolve({acknowledged:['new']});await flush();h.page.onHide();
});

test('snapshot expiry restarts pagination with the same status, filters and sort',async()=>{
  const h=harness();
  h.calls[0].resolve(result('a','1','',true));await flush();h.render();
  Object.assign(h.page.data,{filterStartTime:'09:00',filterEndTime:'15:00'});
  h.page.onReachBottom();h.calls.at(-1).reject({code:'INBOX_VIEW_EXPIRED'});await flush();
  const params=new URL(h.calls.at(-1).url,'http://localhost').searchParams;
  assert.equal(params.get('page'),'1');assert.equal(params.has('cursor'),false);
  assert.equal(params.get('startTime'),'09:00');assert.equal(params.get('sort'),'service_desc');
  h.page.onHide();
});

test('lists covered by a drawer or sort menu wait for visibility before read confirmation',async()=>{
  for(const overlay of ['filterDrawerVisible','sortMenuVisible'])for(const stage of ['render','microtask']) {
    const h=harness();h.calls[0].resolve(result());await flush();
    if(stage==='render')h.page.data[overlay]=true;
    h.render();
    if(stage==='microtask')h.page.data[overlay]=true;
    await flush();assert.equal(readCalls(h).length,0,`${overlay}/${stage}`);
    const dataset=overlay==='filterDrawerVisible'?{filterVersion:h.page.data.filterVersion}:{sortVersion:h.page.data.sortVersion};
    h.page[overlay==='filterDrawerVisible'?'closeFilterDrawer':'closeSortMenu']({currentTarget:{dataset}});
    h.render();await flush();assert.equal(readCalls(h).length,1);
    readCalls(h)[0].resolve({acknowledged:['a']});await flush();h.page.onHide();
  }
});

test('read retries are bounded and expired receipts leave unread indicators intact',async()=>{
  const h=harness();h.calls[0].resolve(result());await flush();h.render();await flush();
  for(let i=0;i<3;i++) {
    readCalls(h)[i].reject(new Error('offline'));await flush();h.tick();await flush();
  }
  assert.equal(readCalls(h).length,3);assert.equal(h.timers.size,0);
  assert.equal(h.page.data.appointments[0].unreadKind,'created');
  const expired=harness();expired.calls[0].resolve(result());await flush();expired.render();await flush();
  readCalls(expired)[0].resolve({acknowledged:[]});await flush();
  assert.equal(expired.timers.size,0);assert.equal(expired.page.data.unreadTabs.pending,1);
  h.page.onHide();expired.page.onHide();
});

test('home shows only two totals and one click rechecks the destination; double clicks do not navigate twice',async()=>{
  const h=harness('home','therapist');await flush();
  h.calls[0].resolve({created:2,changed:3,total:5,target:'pending'});await flush();
  assert.equal(h.page.data.unread.created,2);assert.equal(h.timers.size,1);
  h.page.openUnread();h.page.openUnread();assert.equal(h.calls.length,2);
  h.calls[1].resolve({created:0,changed:1,total:1,target:'cancelled'});await flush();
  assert.equal(h.nav.length,1);assert.match(h.nav[0].url,/status=cancelled&inbox=1&therapist=1/);
  h.page.openUnread();assert.equal(h.calls.length,2);
  h.page.onHide();assert.equal(h.timers.size,0);
});

test('home polling pauses hidden, clears old-account counts, and never requests customer inbox',async()=>{
  const h=harness('home');await flush();
  const old=h.calls[0];h.app.globalData.user={id:'account-b',role:'user'};h.app.globalData.token='session-b';
  h.page.applyIdentity(h.app.globalData.user);old.resolve({created:9,changed:0,total:9,target:'pending'});await flush();
  assert.equal(h.page.data.unread.total,0);assert.equal(h.timers.size,0);
  const c=harness('home','user');await flush();assert.equal(c.calls.length,0);
  const staff=harness('home','therapist');await flush();staff.page.onHide();
  staff.calls[0].resolve({created:2,changed:0,total:2,target:'pending'});await flush();
  assert.equal(staff.page.data.unread.total,0);assert.equal(staff.timers.size,0);
});

test('home handles all-read race and navigation failure without stuck busy state',async()=>{
  const h=harness('home');await flush();h.calls[0].resolve({created:1,changed:0,total:1,target:'pending'});await flush();
  h.page.openUnread();h.calls[1].resolve({created:0,changed:0,total:0,target:null});await flush();
  assert.equal(h.nav.length,0);assert.equal(h.page.data.unreadOpening,false);assert.ok(h.toasts.includes('暂无未读消息'));
  h.page.openUnread();h.calls[2].resolve({created:0,changed:1,total:1,target:'checked_in'});await flush();
  assert.match(h.nav[0].url,/status=checked_in&inbox=1&admin=1/);
  h.nav[0].fail();assert.equal(h.page.data.unreadOpening,false);
  h.page.onHide();
});

test('a delayed homepage click response cannot navigate a different account',async()=>{
  const h=harness('home');await flush();h.calls[0].resolve({created:1,changed:0,total:1,target:'pending'});await flush();
  h.page.openUnread();
  h.app.globalData.user={id:'account-b',role:'user'};h.app.globalData.token='session-b';
  h.page.applyIdentity(h.app.globalData.user);
  h.calls[1].resolve({created:1,changed:0,total:1,target:'pending'});await flush();
  assert.equal(h.nav.length,0);assert.equal(h.page.data.unread.total,0);assert.equal(h.page.data.unreadOpening,false);
  h.page.onHide();
});

test('markup keeps a single home action, three card indicators and counts without extra explanatory copy',()=>{
  const home=fs.readFileSync(path.join(root,'pages/home/index.wxml'),'utf8');
  assert.equal((home.match(/bindtap="openUnread"/g)||[]).length,1);
  assert.match(home,/条未读新增/);assert.match(home,/条未读变更/);
  assert.doesNotMatch(home,/未读修改|未读取消/);
  const card=fs.readFileSync(path.join(root,'components/appointment-card/index.wxml'),'utf8');
  assert.match(card,/!detail && actionMode !== 'user' && appointment.unreadKind/);
  const css=fs.readFileSync(path.join(root,'components/appointment-card/index.wxss'),'utf8');
  for(const kind of ['created','modified','cancelled'])assert.match(css,new RegExp(`\\.unread-${kind} \\{`));
  const list=fs.readFileSync(path.join(root,'pages/my-appointments/index.wxml'),'utf8');
  assert.match(list,/unreadTabs\[item.key\]/);assert.doesNotMatch(list,/未读预约优先显示/);
});
