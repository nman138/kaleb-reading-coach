(function(){
  'use strict';
  let url;
  window.runHeadsetTest=async function(result,meter,audio,heard){
    const phrase='This is a little robot. His name is Rocket.';
    let mic,context,raf,rec,speech,permissionTimer,expired=false,peak=0,clipped=0,frames=0,transcript='',speechError='';
    const chunks=[];
    audio.hidden=true;heard.textContent='Read: '+phrase;result.textContent='Opening microphone…';
    try {
      const request=navigator.mediaDevices.getUserMedia({audio:true});
      request.then(s=>{if(expired)s.getTracks().forEach(t=>t.stop());},()=>{});
      mic=await Promise.race([request,new Promise((_,reject)=>{permissionTimer=setTimeout(()=>{expired=true;reject(new Error('Microphone permission timed out.'));},20000);})]);
      clearTimeout(permissionTimer);
      const name=mic.getAudioTracks()[0]?.label||'browser default';
      const Context=window.AudioContext||window.webkitAudioContext;
      if(Context){
        context=new Context();await context.resume();const analyser=context.createAnalyser();analyser.fftSize=1024;
        context.createMediaStreamSource(mic).connect(analyser);const samples=new Float32Array(1024);
        const draw=()=>{
          analyser.getFloatTimeDomainData(samples);let sum=0,max=0;
          for(const v of samples){sum+=v*v;max=Math.max(max,Math.abs(v));}
          const rms=Math.sqrt(sum/samples.length);peak=Math.max(peak,rms);frames++;if(max>=.98)clipped++;
          meter.value=Math.min(100,rms*500);raf=requestAnimationFrame(draw);
        };draw();
      }
      const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(x=>MediaRecorder.isTypeSupported(x));
      rec=new MediaRecorder(mic,mime?{mimeType:mime}:undefined);
      rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      const Rec=window.SpeechRecognition||window.webkitSpeechRecognition;
      if(Rec){
        speech=new Rec();speech.lang='en-CA';speech.continuous=true;speech.interimResults=true;
        speech.onresult=e=>{transcript=Array.from(e.results).map(r=>r[0].transcript).join(' ');heard.textContent='Chrome heard: '+transcript;};
        speech.onerror=e=>{speechError=e.error;};
        try{speech.start();}catch{speechError='unavailable';}
      }
      const stopped=new Promise((resolve,reject)=>{rec.onstop=resolve;rec.onerror=()=>reject(new Error('The test recording failed.'));});
      rec.start();result.textContent=`Speak now: “${phrase}” Recording 10 seconds through ${name}.`;
      await new Promise(r=>setTimeout(r,10000));rec.stop();await stopped;
      if(speech){await new Promise(resolve=>{speech.onend=resolve;try{speech.stop();}catch{resolve();}setTimeout(resolve,1200);});}
      if(!chunks.length)throw new Error('No audio was saved.');
      if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(new Blob(chunks,{type:rec.mimeType}));
      audio.src=url;audio.hidden=false;
      const C=window.CoachCore,states=C.align(C.tokens(phrase),C.words(transcript)),matched=states.filter(s=>s==='correct').length;
      heard.textContent=transcript?`Chrome heard: ${transcript} — ${matched} of ${states.length} test words matched. This checks recognition, not pronunciation.`:
        'Chrome returned no words'+(speechError?' ('+speechError+')':'')+'. Listen to the recording to check the sound.';
      result.textContent=`${name}. `+(!context?'Sound meter unavailable.':peak<.003?'Input was very quiet. Check mute and input selection.':clipped>2?'Possible distortion detected. Lower the headset input level in Windows and repeat.':'Sound detected; no repeated near-maximum peaks detected.')+' Press play to listen. This test clip is kept only in this tab.';
    }catch(e){result.textContent=e.message||'Headset check failed. Check permission and connection.';}
    finally{
      clearTimeout(permissionTimer);expired=true;
      try{speech?.abort();}catch{}
      if(rec?.state==='recording')rec.stop();
      if(raf)cancelAnimationFrame(raf);context?.close().catch(()=>{});mic?.getTracks().forEach(t=>t.stop());meter.value=0;
    }
  };
})();

