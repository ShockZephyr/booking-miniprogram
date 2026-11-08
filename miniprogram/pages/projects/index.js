const service = require('../../services/project');
Page({
  data:{items:[],manage:false,loading:true,error:'',saving:false,dragging:false,dragId:'',scrollTop:0,sortMessage:''},
  onLoad(query) {
    this.manageRequested=query.manage==='1';
    this.applyIdentity(getApp().globalData.user);
  },
  onShow(){
    const app=getApp();
    const requestId=this.identityRequestId=(this.identityRequestId || 0)+1;
    if(app.globalData.token && app.refreshMe){
      this.setData({manage:false});
      app.refreshMe().then(user=>{
        if(requestId!==this.identityRequestId)return;
        this.applyIdentity(user);this.load();
      });
      return;
    }
    this.applyIdentity(app.globalData.user);this.load();
  },
  applyIdentity(user){
    const manage=!!(this.manageRequested && user && user.role==='admin');
    if(this.data.manage!==manage)this.cancelDrag();
    this.setData({manage});
    wx.setNavigationBarTitle({title:manage?'项目管理':'全部项目'});
  },
  onHide(){this.cancelDrag();},
  onUnload(){this.dragPending=false;this.dragRequestId=(this.dragRequestId || 0)+1;clearInterval(this.dragTimer);},
  onResize(){this.cancelDrag();},
  load(){
    if(this.data.saving || this.data.dragging) return;
    this.setData({loading:true,error:'',sortMessage:''});
    service.list().then(({items})=>this.setData({items})).catch(e=>this.setData({error:e.message || '加载失败'})).finally(()=>this.setData({loading:false}));
  },
  select(e){
    if(this.data.dragging || this.data.saving || Date.now()<(this.ignoreTapUntil || 0)) return;
    wx.navigateTo({url:`/pages/${this.data.manage?'admin/project-edit':'project-detail'}/index?id=${e.detail.project.id}`});
  },
  openRecycleBin(){if(this.data.manage && !this.data.saving && !this.data.dragging)wx.navigateTo({url:'/pages/admin/recycle-bin/index?type=project'});},
  add(){if(this.data.manage && !this.data.saving && !this.data.dragging) wx.navigateTo({url:'/pages/admin/project-edit/index'});},
  moveProject(e){
    if(!this.data.manage || this.data.saving || this.data.dragging || Date.now()<(this.ignoreTapUntil || 0)) return;
    const id=e.currentTarget.dataset.id, direction=Number(e.currentTarget.dataset.direction);
    const original=this.data.items.slice(), from=original.findIndex(item=>item.id===id), to=from+direction;
    if(from<0 || to<0 || to>=original.length) return;
    const items=original.slice(), moved=items[from];
    items.splice(to,0,items.splice(from,1)[0]);
    this.setData({items});
    this.persistOrder(original,`${moved.name || '项目'}已移动至第${to+1}位`);
  },
  onScroll(e){this.currentScroll=e.detail.scrollTop;},
  startDrag(e){
    if(!this.data.manage || this.data.saving || this.data.loading) return;
    const id=e.currentTarget.dataset.id;
    const requestId=this.dragRequestId=(this.dragRequestId || 0)+1;
    this.dragPending=true;
    const touch=e.touches && e.touches[0] || e.changedTouches && e.changedTouches[0];
    if(touch) this.pointerY=touch.clientY;
    this.createSelectorQuery().select('.list-scroll').boundingClientRect().selectAll('.project-row').boundingClientRect().select('.list-content').boundingClientRect().exec(rects=>{
      if(requestId!==this.dragRequestId) return;
      const rows=rects[1] || [];
      if(!this.dragPending || !rects[0] || rows.length!==this.data.items.length || !rows.length || !rects[2]
        || rows.some(row=>!row || !(row.height>0))) { this.dragPending=false; return; }
      this.original=this.data.items.slice();
      this.viewport=rects[0];
      this.rowHeights=new Map(this.original.map((item,index)=>[item.id,rows[index].height]));
      this.contentInset=rows[0].top-rects[2].top;
      this.maxScroll=Math.max(0,rects[2].height-rects[0].height);
      this.setData({dragging:true,dragId:id});
      clearInterval(this.dragTimer);
      this.dragTimer=setInterval(()=>{
        if(this.pointerY==null) return;
        const delta=this.pointerY<this.viewport.top+45?-12:this.pointerY>this.viewport.bottom-45?12:0;
        if(delta){this.currentScroll=Math.max(0,Math.min(this.maxScroll,(this.currentScroll || 0)+delta));this.setData({scrollTop:this.currentScroll});this.positionDrag();}
      },40);
    });
  },
  moveDrag(e){
    if(!this.dragPending && !this.data.dragging) return;
    if(e.touches && e.touches.length) this.pointerY=e.touches[0].clientY;
    if(this.data.dragging) this.positionDrag();
  },
  positionDrag(){
    if(!this.data.dragging || this.pointerY==null || !this.viewport || !this.rowHeights) return;
    const items=this.data.items.slice();
    const from=items.findIndex(i=>i.id===this.data.dragId);
    if(from<0 || items.some(item=>!(this.rowHeights.get(item.id)>0))) return;
    const pointer=this.pointerY-this.viewport.top+(this.currentScroll || 0)-this.contentInset;
    let top=0, to=from;
    for(let index=0;index<items.length;index+=1){
      const height=this.rowHeights.get(items[index].id), middle=top+height/2;
      if(index<from && pointer<middle && to===from) to=index;
      if(index>from && pointer>middle) to=index;
      top+=height;
    }
    if(from>=0 && from!==to){items.splice(to,0,items.splice(from,1)[0]);this.setData({items});}
  },
  endDrag(e){
    const touch=e && e.changedTouches && e.changedTouches[0];
    if(touch){this.pointerY=touch.clientY;this.positionDrag();}
    this.dragPending=false;
    this.dragRequestId=(this.dragRequestId || 0)+1;
    clearInterval(this.dragTimer);this.pointerY=null;
    if(!this.data.dragging) return;
    this.ignoreTapUntil=Date.now()+400;
    const dragId=this.data.dragId;
    this.setData({dragging:false,dragId:''});
    const ids=this.data.items.map(i=>i.id), original=this.original;
    if(ids.join()===original.map(i=>i.id).join()) return;
    const moved=this.data.items.find(item=>item.id===dragId);
    const position=this.data.items.findIndex(item=>item.id===dragId)+1;
    this.persistOrder(original,`${moved && moved.name || '项目'}已移动至第${position}位`);
  },
  persistOrder(original,message){
    const ids=this.data.items.map(item=>item.id);
    this.setData({saving:true,sortMessage:''});
    return service.reorder(ids).then(()=>{
      this.setData({sortMessage:message || '排序已保存'});
    }).catch(e=>{
      this.setData({items:original,sortMessage:e.message || '排序失败，已恢复原顺序'});
    }).finally(()=>this.setData({saving:false}));
  },
  cancelDrag(){this.dragRequestId=(this.dragRequestId || 0)+1;this.dragPending=false;clearInterval(this.dragTimer);this.pointerY=null;if(this.data.dragging)this.setData({items:this.original,dragging:false,dragId:''});}
});
