const service=require('../../../services/project');
Page({
  ...require('../../../utils/editorLifecycle'),
  data:{id:'',name:'',durationMinutes:'60',effect:'',price:'',description:'',imageUrl:'',imageSrc:'',allowed:false,loading:false,saving:false,uploading:false,error:'',imageError:false},
  onLoad(query){
    this.startEditor();
    const user=getApp().globalData.user;
    if(!user || user.role!=='admin'){this.setData({error:'无管理员权限'});return;}
    this.setData({id:query.id || '',allowed:true});
    wx.setNavigationBarTitle({title:query.id?'编辑项目':'新增项目'});
    if(query.id){this.setData({loading:true});service.detail(query.id).then(({item})=>this.setData(Object.assign({},item,{price:item.priceFen==null?'':(item.priceFen/100).toFixed(2)}))).catch(e=>this.setData({error:e.message || '加载失败'})).finally(()=>this.setData({loading:false}));}
  },
  input(e){this.setData({[e.currentTarget.dataset.field]:e.detail.value});},
  imageFailed(){this.setData({imageError:true});},
  chooseImage(){
    if(this.data.saving || this.data.uploading)return;
    wx.chooseMedia({count:1,mediaType:['image'],sizeType:['compressed'],success:result=>{
      const file=result.tempFiles[0];
      if(file.size>5*1024*1024){wx.showToast({title:'图片不能超过 5MB',icon:'none'});return;}
      this.setData({uploading:true});
      service.upload(file.tempFilePath).then(({imageUrl})=>this.setData({imageUrl,imageSrc:file.tempFilePath,imageError:false})).catch(e=>wx.showToast({title:e.message || '上传失败',icon:'none'})).finally(()=>this.setData({uploading:false}));
    }});
  },
  save(){
    const current=this.editorAction();
    if(!current())return;
    if(!this.data.allowed || this.data.loading || this.data.error || this.data.saving || this.data.uploading)return;
    const d=this.data;
    if(!d.imageUrl){wx.showToast({title:'请上传项目图片',icon:'none'});return;}
    if(!d.name.trim()){wx.showToast({title:'请填写项目名称',icon:'none'});return;}
    if(!/^\d+$/.test(String(d.durationMinutes)) || Number(d.durationMinutes)<1 || Number(d.durationMinutes)>1440){wx.showToast({title:'时长需在 1–1440 分钟之内',icon:'none'});return;}
    if(!/^\d+(\.\d{1,2})?$/.test(String(d.price))){wx.showToast({title:'请输入有效价格，最多两位小数',icon:'none'});return;}
    this.setData({saving:true});
    service.save(d.id,{name:d.name,durationMinutes:Number(d.durationMinutes),effect:d.effect,priceFen:Math.round(Number(d.price)*100),description:d.description,imageUrl:d.imageUrl})
      .then(({item})=>{
        if(!this.ownsEditor())return;
        const creating=!this.data.id;
        this.setData({id:item.id});
        this.editorSaved('已保存',creating?'编辑项目':'');
        if(current())wx.navigateBack();
      })
      .catch(e=>{if(current())wx.showToast({title:e.message || '保存失败',icon:'none'});})
      .finally(()=>{if(!this._editorGone)this.setData({saving:false});});
  },
  remove(){
    const current=this.editorAction();
    if(!current())return;
    if(!this.data.allowed || !this.data.id || this.data.saving || this.data.uploading)return;
    wx.showModal({title:'删除项目？',content:'将从项目列表中移除；只包含此项目的空闲时间段会自动关闭。',confirmText:'删除',confirmColor:'#8f434c',success:res=>{
      if(!res.confirm || !current())return;
      this.setData({saving:true});
      service.remove(this.data.id).then(()=>{if(current()){wx.showToast({title:'已删除'});wx.navigateBack();}})
        .catch(e=>{if(current())wx.showToast({title:e.message || '删除失败',icon:'none'});})
        .finally(()=>{if(!this._editorGone)this.setData({saving:false});});
    }});
  }
});
