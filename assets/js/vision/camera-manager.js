
/* SPPG HGWC shared camera resource manager. One active owner at a time. */
class SPPGCameraManager {
  constructor(){ this.owner=null; this.stream=null; this.pending=null; }
  getState(){ return {owner:this.owner, active:!!this.stream}; }
  async acquire(owner, constraints={video:true,audio:false}){
    if(!owner) throw new Error("Camera owner wajib diisi.");
    if(!navigator.mediaDevices?.getUserMedia) throw new Error("Browser tidak mendukung akses kamera.");
    if(this.owner===owner && this.stream && this.stream.getTracks().some(t=>t.readyState==="live")) return this.stream;
    if(this.pending) await this.pending.catch(()=>{});
    if(this.owner && this.owner!==owner) this.release(this.owner);
    this.pending=(async()=>{
      const stream=await navigator.mediaDevices.getUserMedia(constraints);
      this.stream=stream; this.owner=owner;
      stream.getTracks().forEach(track=>track.addEventListener("ended",()=>{if(this.stream===stream){this.stream=null;this.owner=null;}}));
      return stream;
    })();
    try{return await this.pending;}finally{this.pending=null;}
  }
  release(owner){
    if(this.owner && owner && this.owner!==owner) return false;
    if(this.stream){this.stream.getTracks().forEach(t=>{try{t.stop();}catch(e){}});}
    this.stream=null; this.owner=null; return true;
  }
}
window.SPPGCameraManager=window.SPPGCameraManager||new SPPGCameraManager();
