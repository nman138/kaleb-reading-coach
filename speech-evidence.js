(function(root){
  'use strict';
  const C=typeof module==='object'&&module.exports?require('./core.js'):root.CoachCore;
  const VERSION=3;
  // Language models often reconstruct these words. Agreement is not proof of audio.
  const smallWords=new Set('a an the to of and or but in on at by for from with is am are was were be been he she it they we you i his her their our my your this that then than as so'.split(' '));
  function pairs(a,b){
    if(a.length>3600||b.length>3600)throw Error('Transcript is too long.');
    const stride=b.length+1,dp=new Uint16Array((a.length+1)*stride);
    for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)
      dp[i*stride+j]=a[i]===b[j]?1+dp[(i+1)*stride+j+1]:Math.max(dp[(i+1)*stride+j],dp[i*stride+j+1]);
    let i=0,j=0;const out=[];
    while(i<a.length&&j<b.length){
      if(a[i]===b[j])out.push([i++,j++]);
      else if(dp[(i+1)*stride+j]>=dp[i*stride+j+1])i++;else j++;
    }
    return out;
  }
  function confidenceWords(text,logprobs){
    // Map subword tokens back to complete words; never present logprobs as accuracy.
    const spans=[];let combined='';
    for(const item of logprobs||[]){
      if(typeof item.token!=='string')continue;
      const begin=combined.length;combined+=item.token;
      spans.push({begin,end:combined.length,p:item.logprob});
    }
    const fromTokens=[...combined.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu)].map(m=>{
      const overlaps=spans.filter(s=>s.begin<m.index+m[0].length&&s.end>m.index);
      return {word:C.normalize(m[0]),reliable:overlaps.length>0&&overlaps.every(s=>Number.isFinite(s.p)&&s.p>=-1)};
    });
    const result=C.words(text).map(word=>({word,reliable:false}));
    for(const [i,j] of pairs(result.map(w=>w.word),fromTokens.map(w=>w.word)))result[i].reliable=fromTokens[j].reliable;
    return result;
  }
  function combine(timed,verbatim){
    const words=(timed.words||[]).map(w=>({...w,value:C.normalize(w.word)})).filter(w=>w.value);
    const second=verbatim?confidenceWords(verbatim.text||'',verbatim.logprobs):[];
    const matches=pairs(words.map(w=>w.value),second.map(w=>w.word));
    const agreed=new Map(matches),differences=[];
    const bounds=[[-1,-1],...matches,[words.length,second.length]];
    for(let k=1;k<bounds.length;k++){
      const [a,b]=bounds[k-1],[x,y]=bounds[k];
      if(x>a+1||y>b+1)differences.push({
        timingWords:words.slice(a+1,x).map(w=>w.word).join(' '),
        verbatimWords:second.slice(b+1,y).map(w=>w.word).join(' '),
        start:words[a]?.end??words[x]?.start??0
      });
    }
    return {evidenceVersion:VERSION,text:verbatim?.text??timed.text??'',timingText:timed.text||'',
      verbatimText:verbatim?.text??null,dual:!!verbatim,duration:timed.duration,
      words:words.map((w,i)=>{
        const other=agreed.get(i),timing=Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.start>=0&&w.end>w.start;
        return {...w,agreed:other!==undefined,reliable:other!==undefined&&second[other].reliable&&timing};
      }),differences,
      note:'Two transcripts can make the same guess. Agreement does not confirm exact reading; small words stay unverified.'};
  }
  function compare(expectedText,heardText){
    const a=C.words(expectedText),b=C.words(heardText),matches=pairs(a,b),ai=new Set(matches.map(p=>p[0])),bi=new Set(matches.map(p=>p[1]));
    return {missing:a.filter((_,i)=>!ai.has(i)),added:b.filter((_,i)=>!bi.has(i)),matched:matches.length,total:a.length,exact:a.length===b.length&&matches.length===a.length};
  }
  function quality(samples,sampleRate){
    if(!samples.length||!Number.isFinite(sampleRate)||sampleRate<=0)return {status:'unknown',reason:'Sound quality could not be measured.'};
    const step=Math.max(1,Math.round(sampleRate*.02));let maxRms=0,loudFrames=0,clipped=0,frames=0;
    for(let i=0;i<samples.length;i+=step){
      let sum=0,hot=0,n=Math.min(step,samples.length-i);
      for(let j=i;j<i+n;j++){const v=samples[j];sum+=v*v;if(Math.abs(v)>=.985)hot++;}
      const rms=Math.sqrt(sum/n);maxRms=Math.max(maxRms,rms);if(rms>=.008)loudFrames++;if(hot>n*.01)clipped++;frames++;
    }
    const duration=samples.length/sampleRate;
    if(duration<.6||maxRms<.008||loudFrames<8)return {status:'quiet',reason:'Too little clear sound. Check mute, input selection and microphone position.',duration,maxRms};
    if(clipped>=3&&clipped/frames>.02)return {status:'clipped',reason:'Possible distortion. Lower the microphone input level and record again.',duration,maxRms};
    return {status:'ok',reason:'Sound level check passed. This does not verify the words.',duration,maxRms};
  }
  const api={VERSION,pairs,combine,compare,quality,smallWords};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.SpeechEvidence=api;
})(typeof window==='object'?window:globalThis);

