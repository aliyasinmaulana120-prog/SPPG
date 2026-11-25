
import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
export class HandDetector {
  constructor(){this.landmarker=null;this.lastVideoTime=-1;}
  async initialize(){
    const vision=await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    const common={
      baseOptions:{modelAssetPath:"https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"},
      runningMode:"VIDEO",numHands:1,minHandDetectionConfidence:.45,minHandPresenceConfidence:.45,minTrackingConfidence:.40
    };
    try{
      this.landmarker=await HandLandmarker.createFromOptions(vision,{...common,baseOptions:{...common.baseOptions,delegate:"GPU"}});
    }catch(gpuError){
      console.warn("HGWC: GPU delegate tidak tersedia, menggunakan CPU.",gpuError);
      this.landmarker=await HandLandmarker.createFromOptions(vision,common);
    }
    return true;
  }
  detect(video,now){
    if(!this.landmarker||video.readyState<2||video.currentTime===this.lastVideoTime)return null;
    this.lastVideoTime=video.currentTime;
    return this.landmarker.detectForVideo(video,now);
  }
  close(){try{this.landmarker?.close();}catch(e){}this.landmarker=null;this.lastVideoTime=-1;}
}
