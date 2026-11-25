
import "./camera-manager.js";
import { HandDetector } from "./hand-detector.js";

/* ==========================================================================
   SPPG HGWC V1.3 — Free Motion
   - Pointer: One-Euro filter (halus saat pelan, responsif saat cepat), anchor klik
   - Scroll : target = wadah scroll di bawah pointer (modal, panel, iframe), inertia
   - Zoom   : relatif (tanpa lompatan), 50%–200%, di simulasi 3D diteruskan sebagai wheel
   - Klik/drag/hover diteruskan ke dalam iframe simulasi (srcdoc same-origin)
   ========================================================================== */

const $=id=>document.getElementById(id);
const SETTINGS_KEY="sppg_hgwc_settings_v1";
const ZOOM_MIN=.5, ZOOM_MAX=2;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const INTERACTIVE="button,a,input,select,textarea,label,summary,[role=button],[onclick],.card,.asset-card";

const state={
  active:false,paused:false,hand:false,gesture:"—",raf:0,detector:null,stream:null,lastFrame:0,toastTimer:null,
  activeInput:null,keyboardShift:false,keyboardCaps:false,autoKeyboard:true,autoStart:false,
  sensitivity:5,scrollSensitivity:8,handRange:78,inertia:true,
  aspect:16/9,lostSince:0,
  // pointer
  fx:0,fy:0,px:0,py:0,hist:[],hoverEl:null,
  // mode (point | palm | scroll | zoom) dengan debounce
  mode:"point",modeCand:"point",modeCount:0,
  // pinch / drag
  pinchRaw:false,pinching:false,dragging:false,pinchStart:0,pinchMoved:false,pinchSuppressed:false,
  anchor:null,pinchCtx:null,dragCtx:null,dragRange:null,lastClick:0,suppressClickUntil:0,
  // scroll
  scroll:{base:null,fy:null,fx:null,t:0,lastMove:0,vy:0,vx:0,cx:0,cy:0,inertiaRaf:0,inertiaLast:0},
  // zoom
  zoomScale:1,
  zoom:{armed:false,active:false,base:1,last:1,fs:1,acc:0,target:"app",ctx:null}
};
const video=$("hgwc-video"), pointer=$("hgwc-pointer"), panel=$("hgwc-panel"), keyboard=$("hgwc-keyboard");

/* ---------- UI helper ---------- */
function toast(msg){const el=$("hgwc-toast");el.textContent=msg;el.classList.add("show");clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.remove("show"),2300);}
function status(text){$("hgwc-status").textContent=text;}
function setGesture(text){if(state.gesture===text)return;state.gesture=text;$("hgwc-gesture").textContent=text;}
function setOwner(text){$("hgwc-camera-owner").textContent=text;}
function updateButtons(){ $("hgwc-start").disabled=state.active; $("hgwc-pause").disabled=!state.active; $("hgwc-stop").disabled=!state.active; $("hgwc-pause").textContent=state.paused?"Resume":"Pause"; $("hgwc-launcher").classList.toggle("is-active",state.active&&!state.paused); }

/* ---------- Zoom website ---------- */
function zoomMax(){
  // .app dibatasi max-width 860px; pada layar lebar zoom dibatasi agar konten tidak terpotong.
  if(document.body.classList.contains("ccr-wide")||innerWidth<=860)return ZOOM_MAX;
  return clamp(innerWidth/860,1.25,ZOOM_MAX);
}
function applyZoom(value, announce=false, keepView=false){
  const old=state.zoomScale;
  const next=clamp(Math.round(value*1000)/1000,ZOOM_MIN,zoomMax());
  state.zoomScale=next;
  const appRoot=document.querySelector("body > .app")||document.querySelector(".app");
  if(appRoot)appRoot.style.zoom=Math.abs(next-1)<.001?"":(next*100)+"%";
  if(keepView&&old>0&&next!==old){
    const r=next/old;
    try{window.scrollTo({top:(scrollY+innerHeight/2)*r-innerHeight/2,left:(scrollX+innerWidth/2)*r-innerWidth/2,behavior:"instant"});}catch(e){}
  }
  const readout=$("hgwc-zoom-value");if(readout)readout.textContent=Math.round(next*100)+"%";
  if(announce)toast("Zoom website: "+Math.round(next*100)+"%");
}
function changeZoom(delta){applyZoom(state.zoomScale+delta,true,true);}
function resetZoom(){applyZoom(1,true,true);}

/* ---------- Pengaturan ---------- */
function applyFilterParams(){
  const s=state.sensitivity;
  for(const f of [filterX,filterY]){f.minCutoff=.6+s*.24;f.beta=.008+s*.0025;}
}
function loadSettings(){
  try{
    const s=JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}");
    state.autoStart=!!s.autoStart;state.sensitivity=Number(s.sensitivity)||5;state.scrollSensitivity=Number(s.scrollSensitivity)||8;
    state.handRange=Number(s.handRange)||78;state.autoKeyboard=s.autoKeyboard!==false;state.inertia=s.inertia!==false;
  }catch(e){}
  $("hgwc-auto").checked=state.autoStart;$("hgwc-sensitivity").value=state.sensitivity;$("hgwc-scroll-sensitivity").value=state.scrollSensitivity;
  $("hgwc-hand-range").value=state.handRange;$("hgwc-auto-keyboard").checked=state.autoKeyboard;
  const inertiaEl=$("hgwc-inertia");if(inertiaEl)inertiaEl.checked=state.inertia;
}
function saveSettings(){try{localStorage.setItem(SETTINGS_KEY,JSON.stringify({autoStart:state.autoStart,sensitivity:state.sensitivity,scrollSensitivity:state.scrollSensitivity,handRange:state.handRange,autoKeyboard:state.autoKeyboard,inertia:state.inertia}));}catch(e){}}

/* ---------- One-Euro filter ---------- */
class LowPass{constructor(){this.y=null;}filter(x,a){this.y=this.y===null?x:a*x+(1-a)*this.y;return this.y;}}
class OneEuro{
  constructor(minCutoff=1.8,beta=.02,dCutoff=1){this.minCutoff=minCutoff;this.beta=beta;this.dCutoff=dCutoff;this.reset();}
  reset(){this.xf=new LowPass();this.dxf=new LowPass();this.t=null;}
  alpha(cut,dt){const tau=1/(2*Math.PI*cut);return 1/(1+tau/dt);}
  filter(v,tms){
    if(this.t===null){this.t=tms;this.xf.filter(v,1);this.dxf.filter(0,1);return v;}
    const dt=Math.max(.001,(tms-this.t)/1000);this.t=tms;
    const d=(v-this.xf.y)/dt;
    const ed=this.dxf.filter(d,this.alpha(this.dCutoff,dt));
    return this.xf.filter(v,this.alpha(this.minCutoff+this.beta*Math.abs(ed),dt));
  }
}
const filterX=new OneEuro(), filterY=new OneEuro();
function resetPointerFilters(){filterX.reset();filterY.reset();state.hist.length=0;}

/* ---------- Resolver elemen (menembus iframe simulasi) ---------- */
function localize(frames,x,y){
  let lx=x,ly=y;
  for(const f of frames){
    const r=f.getBoundingClientRect(),w=f.contentWindow;
    const sx=(w&&w.innerWidth)?r.width/w.innerWidth:1, sy=(w&&w.innerHeight)?r.height/w.innerHeight:1;
    lx=(lx-r.left)/(sx||1);ly=(ly-r.top)/(sy||1);
  }
  return {x:lx,y:ly};
}
function resolveAt(x,y){
  let doc=document,lx=x,ly=y;const frames=[];
  let el=doc.elementFromPoint(lx,ly);
  for(let i=0;i<4&&el&&el.tagName==="IFRAME";i++){
    let cd=null;try{cd=el.contentDocument;}catch(e){}
    if(!cd)break;
    const p=localize([el],lx,ly);
    const inner=cd.elementFromPoint(p.x,p.y);
    if(!inner)break;
    frames.push(el);lx=p.x;ly=p.y;doc=cd;el=inner;
  }
  return {el,doc,lx,ly,frames};
}
function fire(el,type,x,y,extra){
  const W=(el.ownerDocument&&el.ownerDocument.defaultView)||window;
  const init=Object.assign({bubbles:true,cancelable:true,composed:true,view:W,clientX:x,clientY:y,screenX:x,screenY:y,button:0,buttons:0,detail:type==="click"?1:0},extra||{});
  let ev;
  try{
    ev=(type.indexOf("pointer")===0&&W.PointerEvent)
      ?new W.PointerEvent(type,Object.assign({pointerId:1,pointerType:"mouse",isPrimary:true,width:1,height:1,pressure:init.buttons?.5:0},init))
      :new W.MouseEvent(type,init);
  }catch(e){return true;}
  try{return el.dispatchEvent(ev);}catch(e){return true;}
}

/* ---------- Scroll: cari wadah yang benar-benar bisa digulir ---------- */
function canScrollNode(n,dx,dy){
  const W=n.ownerDocument.defaultView||window;let cs;
  try{cs=W.getComputedStyle(n);}catch(e){return false;}
  if(dy&&/(auto|scroll|overlay)/.test(cs.overflowY)&&n.scrollHeight>n.clientHeight+1){
    if(dy>0?n.scrollTop+n.clientHeight<n.scrollHeight-1:n.scrollTop>0)return true;
  }
  if(dx&&/(auto|scroll|overlay)/.test(cs.overflowX)&&n.scrollWidth>n.clientWidth+1){
    if(dx>0?n.scrollLeft+n.clientWidth<n.scrollWidth-1:n.scrollLeft>0)return true;
  }
  return false;
}
function canScrollRoot(root,dx,dy){
  if(!root)return false;
  if(dy&&root.scrollHeight>root.clientHeight+1){if(dy>0?root.scrollTop+root.clientHeight<root.scrollHeight-1:root.scrollTop>0)return true;}
  if(dx&&root.scrollWidth>root.clientWidth+1){if(dx>0?root.scrollLeft+root.clientWidth<root.scrollWidth-1:root.scrollLeft>0)return true;}
  return false;
}
function scrollTargetFor(el,dx,dy){
  let n=el;
  for(let hop=0;hop<6&&n;hop++){
    const doc=n.ownerDocument;
    while(n&&n.nodeType===1&&n!==doc.documentElement&&n!==doc.body){
      if(canScrollNode(n,dx,dy))return n;
      n=n.parentElement||(n.parentNode&&n.parentNode.host)||null;
    }
    const root=doc.scrollingElement||doc.documentElement;
    if(canScrollRoot(root,dx,dy))return root;
    const fe=doc.defaultView&&doc.defaultView.frameElement;
    if(!fe)break;
    n=fe;
  }
  return null;
}
function scrollNode(t,dx,dy){
  const doc=t.ownerDocument,root=doc.scrollingElement||doc.documentElement;
  const target=(t===root)?(doc.defaultView||window):t;
  try{target.scrollBy({top:dy,left:dx,behavior:"instant"});}catch(e){t.scrollTop+=dy;t.scrollLeft+=dx;}
}
function applyScroll(base,dx,dy){
  const s=state.scroll;let moved=false;
  if(!base)return false;
  s.cy+=dy;s.cx+=dx;
  const wy=s.cy>0?Math.floor(s.cy):Math.ceil(s.cy), wx=s.cx>0?Math.floor(s.cx):Math.ceil(s.cx);
  if(wy!==0){
    const t=scrollTargetFor(base,0,wy);
    if(t){const b=t.scrollTop;scrollNode(t,0,wy);if(t.scrollTop!==b)moved=true;}
    s.cy-=wy;
  }
  if(wx!==0){
    const t=scrollTargetFor(base,wx,0);
    if(t){const b=t.scrollLeft;scrollNode(t,wx,0);if(t.scrollLeft!==b)moved=true;}
    s.cx-=wx;
  }
  return moved;
}
function cancelInertia(){const s=state.scroll;if(s.inertiaRaf){cancelAnimationFrame(s.inertiaRaf);s.inertiaRaf=0;}s.vx=0;s.vy=0;}
function startInertia(){
  const s=state.scroll;
  if(Math.abs(s.vy)<.04&&Math.abs(s.vx)<.04){s.vx=0;s.vy=0;return;}
  if(s.inertiaRaf)cancelAnimationFrame(s.inertiaRaf);
  s.inertiaLast=performance.now();
  const step=t=>{
    const dt=Math.min(40,Math.max(1,t-s.inertiaLast));s.inertiaLast=t;
    const decay=Math.pow(.945,dt/16.7);s.vy*=decay;s.vx*=decay;
    if(Math.abs(s.vy)<.02&&Math.abs(s.vx)<.02){s.inertiaRaf=0;s.vx=0;s.vy=0;return;}
    if(!applyScroll(s.base,s.vx*dt,s.vy*dt)){s.inertiaRaf=0;s.vx=0;s.vy=0;return;}
    s.inertiaRaf=requestAnimationFrame(step);
  };
  s.inertiaRaf=requestAnimationFrame(step);
}
function doScroll(lm,m,now){
  const s=state.scroll;
  const rawY=(lm[8].y+lm[12].y)/2, rawX=(lm[8].x+lm[12].x)/2;
  if(s.fy===null){s.fy=rawY;s.fx=rawX;s.t=now;s.lastMove=now;s.vx=0;s.vy=0;s.cx=0;s.cy=0;setGesture("Scroll siap");return;}
  const dt=clamp(now-s.t,8,80);s.t=now;
  const py=s.fy,px=s.fx;
  s.fy+=(rawY-s.fy)*.45;s.fx+=(rawX-s.fx)*.45;
  const dz=.0032, soft=v=>Math.abs(v)<=dz?0:v-Math.sign(v)*dz;
  const ny=soft((s.fy-py)/m.hs), nx=soft(-(s.fx-px)/m.hs);   // satuan: ukuran tangan per frame
  if(!ny&&!nx){s.vy*=.8;s.vx*=.8;setGesture("Scroll");return;}
  s.lastMove=now;
  const gain=state.scrollSensitivity*2, accel=v=>1+Math.min(1.5,Math.abs(v)*55);
  let dy=ny*.2*innerHeight*gain*accel(ny), dx=nx*.2*innerHeight*gain*accel(nx);
  if(Math.abs(dx)>Math.abs(dy)*1.5)dy=0;else dx=0;
  dy=clamp(dy,-70,70);dx=clamp(dx,-70,70);
  s.vy=s.vy*.55+(dy/dt)*.45;s.vx=s.vx*.55+(dx/dt)*.45;
  applyScroll(s.base,dx,dy);
  setGesture("Scroll "+(dy?(dy>0?"↓":"↑"):(dx>0?"→":"←")));
}
function endScroll(now){
  const s=state.scroll;
  if(s.fy!==null&&state.inertia&&now-s.lastMove<110)startInertia();else{s.vx=0;s.vy=0;}
  s.fy=null;s.fx=null;
}

/* ---------- Zoom gestur (relatif) ---------- */
function wheelAt(ctx,dir){
  const el=ctx.el,W=(el.ownerDocument&&el.ownerDocument.defaultView)||window;
  const p=localize(ctx.frames,state.px,state.py);
  try{
    const ev=new W.WheelEvent("wheel",{bubbles:true,cancelable:true,composed:true,view:W,clientX:p.x,clientY:p.y,deltaY:dir>0?-100:100,deltaMode:0});
    return el.dispatchEvent(ev)===false;   // true = dikonsumsi simulasi (preventDefault)
  }catch(e){return false;}
}
function doZoom(m,now){
  const z=state.zoom,span=Math.max(.05,m.pr);
  if(!z.armed){z.armed=true;z.active=false;z.base=span;z.last=span;z.fs=span;z.acc=0;setGesture("Zoom siap");return;}
  if(!z.active){
    if(Math.abs(Math.log(span/z.base))<.14){setGesture("Zoom siap · rentangkan/rapatkan");return;}
    z.active=true;z.base=span;z.last=span;z.fs=span;z.acc=0;
    const ctx=resolveAt(state.px,state.py);z.ctx=ctx;
    z.target=(ctx.el&&(ctx.doc!==document||ctx.el.closest("canvas")))?"probe":"app";
    return;
  }
  z.fs+=(span-z.fs)*.5;
  const d=Math.log(z.fs/z.last);z.last=z.fs;
  if(z.target==="app"){
    applyZoom(state.zoomScale*Math.exp(d*1.6),false,true);
    setGesture((d>=0?"Zoom In · ":"Zoom Out · ")+Math.round(state.zoomScale*100)+"%");
    return;
  }
  // target 3D / canvas: teruskan sebagai wheel; jika tidak dikonsumsi, jatuh ke zoom website
  z.acc+=d*700;let steps=0;
  while(Math.abs(z.acc)>=60&&steps<4){
    const dir=z.acc>0?1:-1;
    const consumed=wheelAt(z.ctx,dir);
    if(consumed)z.target="wheel";
    else if(z.target==="probe"){z.target="app";applyZoom(state.zoomScale*Math.exp(d*1.6),false,true);break;}
    z.acc-=dir*60;steps++;
  }
  setGesture((d>=0?"Zoom In 3D":"Zoom Out 3D"));
}

/* ---------- Input teks / keyboard virtual ---------- */
function isEditable(el){return el&&el.matches&&el.matches("input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]),textarea,[contenteditable=true]");}
function focusInput(el){if(!isEditable(el))return;state.activeInput=el;if(state.autoKeyboard)openKeyboard();}

/* ---------- Pointer ---------- */
function setPointer(x,y){
  state.px=x;state.py=y;
  pointer.style.left=x+"px";pointer.style.top=y+"px";pointer.style.display="block";
}
function pushHist(t,x,y){const h=state.hist;h.push({t,x,y});while(h.length&&t-h[0].t>500)h.shift();}
function histAt(t){const h=state.hist;for(let i=h.length-1;i>=0;i--)if(h[i].t<=t)return h[i];return h[0]||null;}
function updatePointer(tip,now){
  // Area gerak tangan (handRange) dipetakan ke seluruh layar; tepi/sudut layar mudah dijangkau.
  const span=clamp(state.handRange/100,.35,1),min=(1-span)/2,max=1-min;
  const mx=clamp(((1-tip.x)-min)/(max-min),0,1), my=clamp((tip.y-min)/(max-min),0,1);
  const rx=clamp(mx*innerWidth,2,innerWidth-2), ry=clamp(my*innerHeight,2,innerHeight-2);
  state.fx=filterX.filter(rx,now);state.fy=filterY.filter(ry,now);
  pushHist(now,state.fx,state.fy);
  if(!(state.pinching&&state.anchor))setPointer(state.fx,state.fy);
}
function hover(){
  if(state.pinching)return;
  const ctx=resolveAt(state.px,state.py),el=ctx.el;
  if(!el)return;
  if(state.hoverEl&&state.hoverEl!==el&&state.hoverEl.isConnected){fire(state.hoverEl,"pointerout",ctx.lx,ctx.ly);fire(state.hoverEl,"mouseout",ctx.lx,ctx.ly);}
  if(state.hoverEl!==el){fire(el,"pointerover",ctx.lx,ctx.ly);fire(el,"mouseover",ctx.lx,ctx.ly);}
  state.hoverEl=el;
  fire(el,"pointermove",ctx.lx,ctx.ly);fire(el,"mousemove",ctx.lx,ctx.ly);
}

/* ---------- Klik ---------- */
function setRange(el,lx){
  const r=el.getBoundingClientRect();if(!r.width)return;
  const ratio=clamp((lx-r.left)/r.width,0,1);
  const min=el.min===""?0:Number(el.min),max=el.max===""?100:Number(el.max),step=Number(el.step)||1;
  let v=Math.round((min+ratio*(max-min)-min)/step)*step+min;v=clamp(v,min,max);
  if(String(v)===el.value)return;
  el.value=v;
  const W=el.ownerDocument.defaultView||window;
  el.dispatchEvent(new W.Event("input",{bubbles:true}));
}
function clickAt(x,y){
  cancelInertia();
  const ctx=resolveAt(x,y),el=ctx.el;if(!el)return;
  const hit=el.closest(INTERACTIVE);
  if(hit&&(hit.disabled||hit.getAttribute("aria-disabled")==="true"||hit.closest("[inert]")))return;
  const W=el.ownerDocument.defaultView||window;
  if(hit&&hit.matches("input[type=range]")){setRange(hit,ctx.lx);hit.dispatchEvent(new W.Event("change",{bubbles:true}));return;}
  if(hit&&hit.matches("input,textarea,select")){
    hit.focus({preventScroll:true});focusInput(hit);
    if(hit.type==="checkbox"||hit.type==="radio")hit.click();
    return;
  }
  fire(el,"pointerdown",ctx.lx,ctx.ly,{buttons:1});fire(el,"mousedown",ctx.lx,ctx.ly,{buttons:1});
  fire(el,"pointerup",ctx.lx,ctx.ly);fire(el,"mouseup",ctx.lx,ctx.ly);
  fire(el,"click",ctx.lx,ctx.ly);
  pointer.classList.add("is-click");setTimeout(()=>pointer.classList.remove("is-click"),180);
}

/* ---------- Drag (pinch tahan / pinch lalu geser) ---------- */
function dragEligible(ctx){
  const el=ctx&&ctx.el;if(!el)return false;
  if(el.closest("input[type=range]"))return true;
  if(ctx.doc!==document)return true;   // simulasi 3D/2D di dalam iframe
  return !!el.closest("canvas,svg,[draggable=true],.sortable,.drag-handle,[data-vision-drag]");
}
function startDrag(ctx,x,y){
  state.dragging=true;state.dragCtx=ctx;state.dragRange=null;
  pointer.classList.add("is-dragging");
  const p=localize(ctx.frames,x,y),rng=ctx.el.closest("input[type=range]");
  if(rng){state.dragRange=rng;setRange(rng,p.x);setGesture("Slider");return;}
  fire(ctx.el,"pointerdown",p.x,p.y,{buttons:1});fire(ctx.el,"mousedown",p.x,p.y,{buttons:1});
  setGesture("Drag");
}
function dragTo(x,y){
  const ctx=state.dragCtx;if(!ctx)return;
  const p=localize(ctx.frames,x,y);
  if(state.dragRange){setRange(state.dragRange,p.x);return;}
  fire(ctx.el,"pointermove",p.x,p.y,{buttons:1});fire(ctx.el,"mousemove",p.x,p.y,{buttons:1});
}
function endDrag(x,y){
  const ctx=state.dragCtx;
  if(ctx){
    const p=localize(ctx.frames,x,y);
    if(state.dragRange){const W=state.dragRange.ownerDocument.defaultView||window;state.dragRange.dispatchEvent(new W.Event("change",{bubbles:true}));}
    else{fire(ctx.el,"pointerup",p.x,p.y);fire(ctx.el,"mouseup",p.x,p.y);}
  }
  state.dragging=false;state.dragCtx=null;state.dragRange=null;pointer.classList.remove("is-dragging");
}
function resetPinch(clickAllowed,now){
  if(state.dragging)endDrag(state.px,state.py);
  state.pinching=false;state.anchor=null;state.pinchMoved=false;state.pinchCtx=null;
  pointer.classList.remove("is-pinching","is-dragging");
}
function pinchMachine(raw,now){
  if(raw&&!state.pinching){
    state.pinching=true;state.dragging=false;state.pinchStart=now;state.pinchMoved=false;
    state.pinchSuppressed=now<state.suppressClickUntil;
    // Posisi ~160 ms sebelum pinch dipakai sebagai titik klik, agar jari yang bergeser saat menjepit tidak meleset.
    const a=histAt(now-160)||{x:state.px,y:state.py};
    state.anchor={x:a.x,y:a.y};state.pinchCtx=resolveAt(a.x,a.y);
    setPointer(a.x,a.y);pointer.classList.add("is-pinching");
    return;
  }
  if(raw&&state.pinching){
    if(!state.dragging){
      const a=state.anchor;
      if(a){
        const moved=Math.hypot(state.fx-a.x,state.fy-a.y),held=now-state.pinchStart;
        if(moved>30||held>600){
          if(dragEligible(state.pinchCtx)){startDrag(state.pinchCtx,a.x,a.y);state.anchor=null;}
          else if(moved>30){state.pinchMoved=true;state.anchor=null;}
        }
      }
    }
    if(state.dragging){setPointer(state.fx,state.fy);dragTo(state.fx,state.fy);}
    else if(!state.anchor)setPointer(state.fx,state.fy);
    return;
  }
  if(!raw&&state.pinching){
    if(state.dragging){endDrag(state.px,state.py);}
    else if(!state.pinchMoved&&!state.pinchSuppressed&&now-state.pinchStart<800&&now-state.lastClick>260){
      const a=state.anchor||{x:state.px,y:state.py};
      clickAt(a.x,a.y);state.lastClick=now;
    }
    state.pinching=false;state.anchor=null;state.pinchMoved=false;state.pinchCtx=null;
    pointer.classList.remove("is-pinching");
  }
}

/* ---------- Klasifikasi gestur (tidak bergantung jarak ke kamera) ---------- */
function measure(lm){
  const A=state.aspect,d=(a,b)=>Math.hypot((lm[a].x-lm[b].x)*A,lm[a].y-lm[b].y);
  const hs=Math.max(.04,d(0,9));
  const ext=(tip,pip)=>d(tip,0)>d(pip,0)*1.12;
  const index=ext(8,6),middle=ext(12,10),ring=ext(16,14),pinky=ext(20,18);
  const thumbOut=d(4,2)/hs>.45, pr=d(4,8)/hs;
  return {hs,pr,index,middle,ring,pinky,
    palm:index&&middle&&ring&&pinky,
    scrollPose:index&&middle&&!ring&&!pinky,
    zoomPose:thumbOut&&index&&!middle&&!ring&&!pinky&&pr>.5};
}
function setPointerMode(mode){
  pointer.classList.toggle("is-scrolling",mode==="scroll");
  pointer.classList.toggle("is-zooming",mode==="zoom");
}
function leaveMode(mode,now){
  if(mode==="scroll"){endScroll(now);state.suppressClickUntil=now+450;}
  if(mode==="zoom"){const z=state.zoom;z.armed=false;z.active=false;z.acc=0;state.suppressClickUntil=now+450;}
}
function enterMode(mode,now){
  setPointerMode(mode);
  if(mode==="scroll"){
    cancelInertia();
    const ctx=resolveAt(state.px,state.py);
    state.scroll.base=ctx.el||document.body;state.scroll.fy=null;
    resetPinch(false,now);state.suppressClickUntil=now+450;
  }
  if(mode==="zoom"){state.zoom.armed=false;state.zoom.active=false;resetPinch(false,now);}
}
function setMode(cand,now){
  if(cand===state.mode){state.modeCand=cand;state.modeCount=0;return;}
  if(cand!==state.modeCand){state.modeCand=cand;state.modeCount=1;}else state.modeCount++;
  const need=state.mode==="point"||state.mode==="palm"?3:2;
  if(state.modeCount>=need){
    leaveMode(state.mode,now);state.mode=cand;state.modeCount=0;
    if(cand!=="scroll"&&cand!=="zoom")setPointerMode(cand);
    enterMode(cand,now);
  }
}
function processGesture(lm,now){
  state.aspect=(video.videoWidth&&video.videoHeight)?video.videoWidth/video.videoHeight:16/9;
  const m=measure(lm);
  $("hgwc-detection").textContent="1 tangan terdeteksi";$("hgwc-hand-lost").style.display="none";
  updatePointer(lm[8],now);
  state.pinchRaw=m.pr<(state.pinchRaw?.42:.30);   // hysteresis: sulit lepas sendiri saat menjepit
  let cand="point";
  if(state.pinchRaw)cand="point";
  else if(m.zoomPose)cand="zoom";
  else if(m.scrollPose)cand="scroll";
  else if(m.palm)cand="palm";
  setMode(cand,now);
  if(state.mode==="scroll"){doScroll(lm,m,now);return;}
  if(state.mode==="zoom"){doZoom(m,now);hover();return;}
  if(!state.pinching)hover();
  pinchMachine(state.pinchRaw,now);
  setGesture(state.dragging?(state.dragRange?"Slider":"Drag"):state.pinching?"Pinch":state.mode==="palm"?"Telapak terbuka":"Pointer");
}
function handLost(now){
  if(!state.lostSince)state.lostSince=now;
  if(now-state.lostSince<220)return;   // toleransi kehilangan tangan sesaat
  if(state.hand){
    state.hand=false;
    leaveMode(state.mode,now);state.mode="point";state.modeCand="point";state.modeCount=0;setPointerMode("point");
    resetPinch(false,now);resetPointerFilters();state.scroll.fy=null;
  }
  $("hgwc-detection").textContent="Tangan tidak terdeteksi";$("hgwc-hand-lost").style.display="grid";
  setGesture("Menunggu tangan");
}
function frame(now){
  if(!state.active||state.paused)return;
  if(now-state.lastFrame>=14){
    state.lastFrame=now;
    try{
      const result=state.detector.detect(video,now);
      if(result!==null&&result!==undefined){            // null = belum ada frame kamera baru, bukan "tangan hilang"
        const lm=result.landmarks&&result.landmarks[0];
        if(lm){state.lostSince=0;state.hand=true;processGesture(lm,now);}
        else handLost(now);
      }
    }catch(err){console.error("HGWC frame error",err);toast("Terjadi kesalahan deteksi. Sistem dijeda.");pause();return;}
  }
  if(state.active&&!state.paused)state.raf=requestAnimationFrame(frame);
}

/* ---------- Siklus kamera ---------- */
async function start(){
  if(state.active)return;
  const scannerOverlay=document.getElementById("scanOverlay");
  if(scannerOverlay?.classList.contains("active")){toast("Tutup scanner QR terlebih dahulu, lalu aktifkan Vision Control.");return;}
  if(!window.isSecureContext&&location.hostname!=="localhost"){toast("Kamera membutuhkan HTTPS atau localhost.");return;}
  try{
    status("Meminta izin kamera…");setOwner("Meminta kamera");
    state.stream=await window.SPPGCameraManager.acquire("hgwc",{video:{facingMode:"user",width:{ideal:1280,min:640},height:{ideal:720,min:360},aspectRatio:{ideal:1.777},frameRate:{ideal:30,max:30}},audio:false});
    video.srcObject=state.stream;await video.play();
    status("Memuat model deteksi…");
    state.detector=new HandDetector();await state.detector.initialize();
    state.active=true;state.paused=false;setOwner("HGWC");$("hgwc-camera-badge").textContent="KAMERA AKTIF";
    resetPointerFilters();state.lostSince=0;
    $("hgwc-launcher").classList.add("is-active");updateButtons();toast("HGWC aktif. Arahkan telunjuk ke layar.");
    state.lastFrame=0;state.raf=requestAnimationFrame(frame);
  }catch(err){
    console.error("HGWC start error",err);cleanup();status("Gagal diaktifkan");setOwner("Tidak digunakan");
    toast(err?.name==="NotAllowedError"?"Izin kamera ditolak.":("Gagal memulai kamera: "+(err.message||"periksa koneksi dan izin kamera.")));
  }
}
function cleanup(){
  cancelAnimationFrame(state.raf);state.raf=0;cancelInertia();
  try{state.detector?.close();}catch(e){}state.detector=null;
  resetPinch(false,0);state.mode="point";state.modeCand="point";state.modeCount=0;setPointerMode("point");
  state.zoom.armed=false;state.zoom.active=false;state.scroll.fy=null;
  if(state.stream){window.SPPGCameraManager.release("hgwc");state.stream=null;}
  video.pause();video.srcObject=null;state.active=false;state.paused=false;state.hand=false;
  pointer.style.display="none";$("hgwc-camera-badge").textContent="KAMERA NONAKTIF";
  $("hgwc-hand-lost").style.display="grid";$("hgwc-hand-lost").textContent="Tunjukkan satu tangan ke kamera";
  updateButtons();
}
function stop(){cleanup();status("Nonaktif");setOwner("Tidak digunakan");setGesture("—");}
function pause(){if(!state.active)return;state.paused=true;cancelAnimationFrame(state.raf);state.raf=0;cancelInertia();resetPinch(false,0);status("Dijeda");setGesture("Pause");updateButtons();}
function resume(){if(!state.active||!state.paused)return;state.paused=false;resetPointerFilters();state.lostSince=0;status("Aktif");updateButtons();state.raf=requestAnimationFrame(frame);}
function togglePause(){state.paused?resume():pause();}
function resetMotionCalibration(){
  cancelInertia();state.scroll.fy=null;state.zoom.armed=false;state.zoom.active=false;
  resetPinch(false,0);resetPointerFilters();
  toast("Kalibrasi kendali direset. Gerakkan tangan perlahan untuk menyesuaikan.");
}

/* ---------- Keyboard virtual (tidak berubah) ---------- */
const rows=[
 ["Q","W","E","R","T","Y","U","I","O","P"],
 ["A","S","D","F","G","H","J","K","L","⌫"],
 ["⇧","Z","X","C","V","B","N","M",",","."],
 ["123","@","#","SPACE","-","_","'","ENTER","TAB","CLOSE"]
];
function openKeyboard(){keyboard.hidden=false;renderKeyboard();}
function closeKeyboard(){keyboard.hidden=true;}
function renderKeyboard(){
 const wrap=$("hgwc-keyboard-keys");wrap.innerHTML="";
 rows.flat().forEach(key=>{
   const b=document.createElement("button");b.type="button";b.className="hgwc-key";
   if(["SPACE"].includes(key))b.classList.add("space");
   if(["⌫","⇧","123","ENTER","TAB","CLOSE"].includes(key))b.classList.add("wide");
   let label=key;
   if(state.keyboardCaps||state.keyboardShift)label=key.length===1?key.toUpperCase():key;
   b.textContent=label;b.addEventListener("click",()=>pressKey(key));wrap.appendChild(b);
 });
}
function pressKey(key){
 const el=state.activeInput||document.activeElement;
 if(key==="CLOSE"){closeKeyboard();return;}
 if(key==="⇧"){state.keyboardShift=!state.keyboardShift;renderKeyboard();return;}
 if(key==="123"){toast("Layout angka/simbol dasar tersedia melalui tombol simbol.");return;}
 if(!isEditable(el)){toast("Pilih kolom input terlebih dahulu.");return;}
 el.focus();
 const start=typeof el.selectionStart==="number"?el.selectionStart:el.value.length;
 const end=typeof el.selectionEnd==="number"?el.selectionEnd:el.value.length;
 let value=el.value??"",insert="";
 if(key==="SPACE")insert=" ";
 else if(key==="⌫"){if(start===end&&start>0){el.setRangeText("",start-1,start,"end");}else el.setRangeText("",start,end,"end");}
 else if(key==="ENTER"){
   if(el.tagName==="TEXTAREA")insert="\n";
   else {el.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));el.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",bubbles:true}));}
 }else if(key==="TAB"){const fields=[...document.querySelectorAll("input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])")].filter(x=>!x.closest("#hgwc-root"));const i=fields.indexOf(el);fields[(i+1)%fields.length]?.focus();state.activeInput=document.activeElement;return;}
 else insert=(state.keyboardShift?key.toUpperCase():key.toLowerCase());
 if(insert){
   if(typeof el.setRangeText==="function" && typeof el.selectionStart==="number")el.setRangeText(insert,start,end,"end");
   else el.value=String(el.value||"")+insert;
 }
 el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:insert||null}));
 el.dispatchEvent(new Event("change",{bubbles:true}));
 if(state.keyboardShift){state.keyboardShift=false;renderKeyboard();}
}
function bind(){
 $("hgwc-launcher").addEventListener("click",()=>{panel.hidden=!panel.hidden;});
 $("hgwc-close").addEventListener("click",()=>panel.hidden=true);
 $("hgwc-start").addEventListener("click",start);
 $("hgwc-stop").addEventListener("click",()=>stop());
 $("hgwc-pause").addEventListener("click",togglePause);
 $("hgwc-keyboard-toggle").addEventListener("click",()=>keyboard.hidden?openKeyboard():closeKeyboard());
 $("hgwc-keyboard-close").addEventListener("click",closeKeyboard);
 $("hgwc-auto").addEventListener("change",e=>{state.autoStart=e.target.checked;saveSettings();});
 $("hgwc-sensitivity").addEventListener("input",e=>{state.sensitivity=Number(e.target.value);applyFilterParams();saveSettings();});
 $("hgwc-scroll-sensitivity").addEventListener("input",e=>{state.scrollSensitivity=Number(e.target.value);state.scroll.fy=null;saveSettings();});
 $("hgwc-hand-range").addEventListener("input",e=>{state.handRange=Number(e.target.value);saveSettings();});
 const inertiaEl=$("hgwc-inertia");if(inertiaEl)inertiaEl.addEventListener("change",e=>{state.inertia=e.target.checked;if(!state.inertia)cancelInertia();saveSettings();});
 $("hgwc-calibrate").addEventListener("click",resetMotionCalibration);
 $("hgwc-auto-keyboard").addEventListener("change",e=>{state.autoKeyboard=e.target.checked;saveSettings();});
 document.addEventListener("focusin",e=>{if(isEditable(e.target)&&!e.target.closest("#hgwc-root"))focusInput(e.target);});
 document.addEventListener("focusout",e=>{if(isEditable(e.target)){setTimeout(()=>{if(!isEditable(document.activeElement))state.activeInput=null;},100);}});
 document.addEventListener("visibilitychange",()=>{if(document.hidden&&state.active)pause();});
 window.addEventListener("pagehide",()=>{if(state.active)stop();});
 window.addEventListener("resize",()=>applyZoom(state.zoomScale,false,false));
 $("hgwc-zoom-in").addEventListener("click",()=>changeZoom(.1));
 $("hgwc-zoom-out").addEventListener("click",()=>changeZoom(-.1));
 $("hgwc-zoom-reset").addEventListener("click",resetZoom);
}
window.SPPGHGWC={isActive:()=>state.active,stop:()=>stop(),getZoom:()=>state.zoomScale};
async function maybeAutoStart(){
 if(!state.autoStart)return;
 try{
   const p=await navigator.permissions?.query?.({name:"camera"});
   if(p?.state==="granted")start();
 }catch(e){}
}
loadSettings();applyFilterParams();bind();updateButtons();applyZoom(1,false);maybeAutoStart();
