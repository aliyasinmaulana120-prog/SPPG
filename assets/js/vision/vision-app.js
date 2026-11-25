
import "./camera-manager.js";
import { HandDetector } from "./hand-detector.js";

const $=id=>document.getElementById(id);
const SETTINGS_KEY="sppg_hgwc_settings_v1";
const state={active:false,paused:false,hand:false,gesture:"—",lastGesture:"",pinchStart:0,pinching:false,dragging:false,lastClick:0,lastScrollY:null,palmStart:0,fistStart:0,raf:0,detector:null,stream:null,lastFrame:0,toastTimer:null,activeInput:null,keyboardShift:false,keyboardCaps:false,autoKeyboard:true,sensitivity:5,autoStart:false};
const video=$("hgwc-video"), pointer=$("hgwc-pointer"), panel=$("hgwc-panel"), keyboard=$("hgwc-keyboard");
function toast(msg){const el=$("hgwc-toast");el.textContent=msg;el.classList.add("show");clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.remove("show"),2300);}
function status(text){$("hgwc-status").textContent=text;}
function setGesture(text){state.gesture=text;$("hgwc-gesture").textContent=text;}
function setOwner(text){$("hgwc-camera-owner").textContent=text;}
function updateButtons(){ $("hgwc-start").disabled=state.active; $("hgwc-pause").disabled=!state.active; $("hgwc-stop").disabled=!state.active; $("hgwc-pause").textContent=state.paused?"Resume":"Pause"; $("hgwc-launcher").classList.toggle("is-active",state.active&&!state.paused); }
function loadSettings(){try{const s=JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}");state.autoStart=!!s.autoStart;state.sensitivity=Number(s.sensitivity)||5;state.autoKeyboard=s.autoKeyboard!==false;}catch(e){}$("hgwc-auto").checked=state.autoStart;$("hgwc-sensitivity").value=state.sensitivity;$("hgwc-auto-keyboard").checked=state.autoKeyboard;}
function saveSettings(){localStorage.setItem(SETTINGS_KEY,JSON.stringify({autoStart:state.autoStart,sensitivity:state.sensitivity,autoKeyboard:state.autoKeyboard}));}
function isEditable(el){return el&&el.matches&&el.matches("input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]");}
function focusInput(el){if(!isEditable(el))return;state.activeInput=el;if(state.autoKeyboard)openKeyboard();}
function findTarget(x,y){return document.elementFromPoint(x,y);}
function clickTarget(x,y){
  const target=findTarget(x,y);if(!target)return;
  if(target.closest("#hgwc-root"))return;
  const el=target.closest("button,a,input,select,textarea,[role=button],[tabindex],summary,[onclick],.card,.asset-card");
  if(!el)return;
  if(el.disabled||el.getAttribute("aria-disabled")==="true")return;
  if(el.closest("[inert]"))return;
  if(el.matches("input,textarea,select")){el.focus({preventScroll:true});focusInput(el);if(el.type==="checkbox"||el.type==="radio")el.click();return;}
  if(el.matches("a")&&el.href){el.click();return;}
  el.click();
}
function pointerMove(nx,ny){
  const sens=state.sensitivity/5;
  const x=Math.max(4,Math.min(innerWidth-4,(1-nx)*innerWidth));
  const y=Math.max(4,Math.min(innerHeight-4,ny*innerHeight));
  const oldX=parseFloat(pointer.dataset.x||x),oldY=parseFloat(pointer.dataset.y||y);
  const alpha=Math.min(.95,.38+sens*.045);
  const sx=oldX+(x-oldX)*alpha,sy=oldY+(y-oldY)*alpha;
  pointer.dataset.x=sx;pointer.dataset.y=sy;pointer.style.left=sx+"px";pointer.style.top=sy+"px";pointer.style.display="block";
}
function fingerExtended(lm,tip,pip){return lm[tip].y<lm[pip].y-.015;}
function classify(lm){
  const index=fingerExtended(lm,8,6),middle=fingerExtended(lm,12,10),ring=fingerExtended(lm,16,14),pinky=fingerExtended(lm,20,18);
  const thumb=Math.hypot(lm[4].x-lm[2].x,lm[4].y-lm[2].y)>.07;
  const pinch=Math.hypot(lm[4].x-lm[8].x,lm[4].y-lm[8].y)<.055;
  const palm=index&&middle&&ring&&pinky;
  const scroll=index&&middle&&!ring&&!pinky;
  const fist=!index&&!middle&&!ring&&!pinky;
  return {index,middle,ring,pinky,thumb,pinch,palm,scroll,fist};
}
function onPinchStart(now,x,y){state.pinchStart=now;state.pinching=true;state.dragging=false;state.dragTarget=findTarget(x,y);pointer.classList.add("is-pinching");}
function processPinch(g,now,x,y){
  if(g.pinch&&!state.pinching){onPinchStart(now,x,y);return;}
  if(g.pinch&&state.pinching&&!state.dragging&&now-state.pinchStart>520){
    const target=state.dragTarget;
    if(target&&!target.closest("#hgwc-root")&&target.closest("[draggable=true],.sortable,.drag-handle,[data-vision-drag]")){
      state.dragging=true;
      try{target.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,clientX:x,clientY:y,pointerId:1,pointerType:"mouse",isPrimary:true}));}catch(e){}
      setGesture("Drag");
    }
  }
  if(!g.pinch&&state.pinching){
    const duration=now-state.pinchStart;state.pinching=false;pointer.classList.remove("is-pinching");
    if(state.dragging){document.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,clientX:x,clientY:y,pointerId:1,pointerType:"mouse",isPrimary:true}));state.dragging=false;}
    else if(duration<520&&now-state.lastClick>330){clickTarget(x,y);state.lastClick=now;}
  }
  if(state.dragging){document.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,clientX:x,clientY:y,pointerId:1,pointerType:"mouse",isPrimary:true}));}
}
function processGesture(lm,now){
  const g=classify(lm),tip=lm[8];pointerMove(tip.x,tip.y);
  const px=parseFloat(pointer.dataset.x),py=parseFloat(pointer.dataset.y);
  $("hgwc-detection").textContent="1 tangan terdeteksi";
  $("hgwc-hand-lost").style.display="none";
  if(g.palm){
    state.palmStart=state.palmStart||now;
    if(now-state.palmStart>2000){emergencyStop("Emergency Stop: telapak terbuka");return;}
    setGesture("Telapak terbuka");
    return;
  }else state.palmStart=0;
  if(g.scroll&&!g.pinch){
    state.pinching=false;pointer.classList.remove("is-pinching");
    const midY=(lm[8].y+lm[12].y)/2;
    if(state.lastScrollY!==null){const delta=(midY-state.lastScrollY)*innerHeight*2.3;window.scrollBy({top:delta,behavior:"auto"});}
    state.lastScrollY=midY;setGesture("Scroll");return;
  }else state.lastScrollY=null;
  processPinch(g,now,px,py);
  setGesture(g.pinch?"Pinch":g.fist?"Pointer siap":"Pointer");
}
function frame(now){
  if(!state.active||state.paused)return;
  if(now-state.lastFrame<24){state.raf=requestAnimationFrame(frame);return;}
  state.lastFrame=now;
  try{
    const result=state.detector.detect(video,now);
    const landmarks=result?.landmarks?.[0];
    if(landmarks){state.hand=true;processGesture(landmarks,now);}
    else{
      state.hand=false;$("hgwc-detection").textContent="Tangan tidak terdeteksi";$("hgwc-hand-lost").style.display="grid";
      state.pinching=false;if(state.dragging){try{document.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,pointerId:1,pointerType:"mouse",isPrimary:true}));}catch(e){}}state.dragging=false;state.palmStart=0;state.lastScrollY=null;pointer.classList.remove("is-pinching");
      setGesture("Menunggu tangan");
    }
  }catch(err){console.error("HGWC frame error",err);toast("Terjadi kesalahan deteksi. Sistem dijeda.");pause();}
  if(state.active&&!state.paused)state.raf=requestAnimationFrame(frame);
}
async function start(){
  if(state.active)return;
  if(!window.isSecureContext&&location.hostname!=="localhost"){toast("Kamera membutuhkan HTTPS atau localhost.");return;}
  try{
    status("Meminta izin kamera…");setOwner("Meminta kamera");
    state.stream=await window.SPPGCameraManager.acquire("hgwc",{video:{facingMode:"user",width:{ideal:640},height:{ideal:480},frameRate:{ideal:30,max:30}},audio:false});
    video.srcObject=state.stream;await video.play();
    status("Memuat model deteksi…");
    state.detector=new HandDetector();await state.detector.initialize();
    state.active=true;state.paused=false;setOwner("HGWC");$("hgwc-camera-badge").textContent="KAMERA AKTIF";
    $("hgwc-launcher").classList.add("is-active");updateButtons();toast("HGWC aktif. Arahkan telunjuk ke layar.");
    state.lastFrame=0;state.raf=requestAnimationFrame(frame);
  }catch(err){
    console.error("HGWC start error",err);cleanup();status("Gagal diaktifkan");setOwner("Tidak digunakan");
    toast(err?.name==="NotAllowedError"?"Izin kamera ditolak.":("Gagal memulai kamera: "+(err.message||"periksa koneksi dan izin kamera.")));
  }
}
function cleanup(){
  cancelAnimationFrame(state.raf);state.raf=0;
  try{state.detector?.close();}catch(e){}state.detector=null;
  if(state.stream){window.SPPGCameraManager.release("hgwc");state.stream=null;}
  video.pause();video.srcObject=null;state.active=false;state.paused=false;state.hand=false;state.pinching=false;state.dragging=false;
  pointer.style.display="none";pointer.classList.remove("is-pinching");$("hgwc-camera-badge").textContent="KAMERA NONAKTIF";
  $("hgwc-hand-lost").style.display="grid";$("hgwc-hand-lost").textContent="Tunjukkan satu tangan ke kamera";
  updateButtons();
}
function emergencyStop(message="Kontrol kamera dihentikan."){cleanup();status("Emergency Stop");setOwner("Tidak digunakan");setGesture("Berhenti");toast(message);}
function stop(){cleanup();status("Nonaktif");setOwner("Tidak digunakan");setGesture("—");}
function pause(){if(!state.active)return;state.paused=true;cancelAnimationFrame(state.raf);state.raf=0;status("Dijeda");setGesture("Pause");updateButtons();}
function resume(){if(!state.active||!state.paused)return;state.paused=false;status("Aktif");updateButtons();state.raf=requestAnimationFrame(frame);}
function togglePause(){state.paused?resume():pause();}
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
 $("hgwc-stop").addEventListener("click",()=>emergencyStop());
 $("hgwc-pause").addEventListener("click",togglePause);
 $("hgwc-keyboard-toggle").addEventListener("click",()=>keyboard.hidden?openKeyboard():closeKeyboard());
 $("hgwc-keyboard-close").addEventListener("click",closeKeyboard);
 $("hgwc-auto").addEventListener("change",e=>{state.autoStart=e.target.checked;saveSettings();});
 $("hgwc-sensitivity").addEventListener("input",e=>{state.sensitivity=Number(e.target.value);saveSettings();});
 $("hgwc-auto-keyboard").addEventListener("change",e=>{state.autoKeyboard=e.target.checked;saveSettings();});
 document.addEventListener("focusin",e=>{if(isEditable(e.target)&&!e.target.closest("#hgwc-root"))focusInput(e.target);});
 document.addEventListener("focusout",e=>{if(isEditable(e.target)){setTimeout(()=>{if(!isEditable(document.activeElement))state.activeInput=null;},100);}});
 document.addEventListener("visibilitychange",()=>{if(document.hidden&&state.active)pause();});
 window.addEventListener("pagehide",()=>{if(state.active)stop();});
 // When scanner takes the shared camera, HGWC is stopped cleanly. It is not auto-resumed.
 const originalAcquire=window.SPPGCameraManager.acquire.bind(window.SPPGCameraManager);
 window.SPPGCameraManager.acquire=async(owner,constraints)=>{
   if(owner==="scanner"&&state.active){stop();status("Dihentikan untuk scanner QR");setOwner("Scanner QR");}
   return originalAcquire(owner,constraints);
 };
}
async function maybeAutoStart(){
 if(!state.autoStart)return;
 try{
   const p=await navigator.permissions?.query?.({name:"camera"});
   if(p?.state==="granted")start();
 }catch(e){}
}
loadSettings();bind();updateButtons();maybeAutoStart();
