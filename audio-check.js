(() => {
  'use strict';
  window.checkRecording=async function(blob){
    let context;
    try{
      const Context=window.AudioContext||window.webkitAudioContext;if(!Context)throw Error();
      context=new Context();const buffer=await context.decodeAudioData(await blob.arrayBuffer());
      // Use the loudest channel so silent second channels cannot hide the voice.
      const results=Array.from({length:buffer.numberOfChannels},(_,i)=>window.SpeechEvidence.quality(buffer.getChannelData(i),buffer.sampleRate));
      return results.sort((a,b)=>b.maxRms-a.maxRms)[0];
    }catch{return {status:'unknown',reason:'Sound quality could not be checked. Listen before sending.'};}
    finally{if(context)await context.close().catch(()=>{});}
  };
})();

