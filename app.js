(() => {
  'use strict';
  const C=window.CoachCore,story=window.COACH_STORY,$=id=>document.getElementById(id);
  const expected=story.sections.map(s=>C.tokens(s.text));
  const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  let session,part=0,reviewPart=0,selected=null,active=false,starting=false,finishing=false,run=0;
  let recorder=null,stream=null,recognition=null,ctx=null,frame=null,timer=null,watchdog=null;
  let segment=null,startedAt=0,sectionBaseSeconds=0,speechFinish=null,stopTask=null;
  let sound=false,lastSound=0,gapStart=null,heardAny=false;
  let storageError='',db=null,pendingWrites=[],speechRetries=0,notice='',testing=false;
  const memoryAudio=new Map(),audioUrls=new Map();
  const labels={correct:'Read correctly',hesitation:'Long hesitation',skipped:'Skipped',pronunciation:'Mispronounced',unsure:'Not sure'};
  const uid=()=>Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9);
  function makeSession(){return {id:uid(),storyId:story.id,version:'2.0',created:new Date().toISOString(),savedAt:Date.now(),index:0,completed:false,sections:expected.map(w=>({transcript:'',states:w.map(()=> 'unread'),seconds:0,marks:{},visited:false,finished:false})),segments:[],gaps:[]};}
  function readSessions(){try{const a=JSON.parse(localStorage.getItem('kaleb-coach-sessions-v2')||'[]');return Array.isArray(a)?a.filter(s=>s.storyId===story.id&&s.sections?.length===6):[];}catch{return [];}}
  function save(){
    if(!session)return;session.savedAt=Date.now();session.index=part;
    try{const all=readSessions().filter(s=>s.id!==session.id);all.unshift(session);localStorage.setItem('kaleb-coach-sessions-v2',JSON.stringify(all.slice(0,20)));}catch{storageError='Browser summary storage is full or unavailable. Download your report before closing.';}
    $('saveStatus').textContent=storageError||'Session saved in this browser. Audio clips are saved locally as they arrive.';
  }
  const dbReady=new Promise(resolve=>{
    if(!window.indexedDB){storageError='Audio can be played now, but browser audio storage is unavailable. Download the ZIP before closing.';resolve(null);return;}
    const req=indexedDB.open('kaleb-reading-audio-v2',1);
    req.onupgradeneeded=()=>{const s=req.result.createObjectStore('chunks',{keyPath:'id'});s.createIndex('sessionId','sessionId');};
    req.onsuccess=()=>{db=req.result;resolve(db);};
    req.onerror=()=>{storageError='Browser audio storage is unavailable. Download the ZIP before closing.';resolve(null);};
    req.onblocked=()=>{storageError='Audio storage is busy in another tab. Keep this tab open and download the ZIP.';resolve(null);};
  });
  async function putChunk(row){
    await dbReady;if(!db)throw new Error('Audio storage unavailable');
    return new Promise((resolve,reject)=>{const tx=db.transaction('chunks','readwrite');tx.objectStore('chunks').put(row);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
  }
  async function clipBlob(seg){
    const inMemory=memoryAudio.get(seg.id);
    if(inMemory?.length)return new Blob(inMemory,{type:seg.mime});
    await dbReady;if(!db)return null;
    const rows=await new Promise((resolve,reject)=>{const req=db.transaction('chunks').objectStore('chunks').index('sessionId').getAll(session.id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    const chunks=rows.filter(x=>x.segmentId===seg.id).sort((a,b)=>a.index-b.index);
    return chunks.length?new Blob(chunks.map(x=>x.blob),{type:seg.mime}):null;
  }
  function childHint(text){$('readingHint').textContent=text;}
  function showHelp(text){$('helpBox').textContent=text;$('helpBox').hidden=!text;}
  function updateButtons(){
    const busy=starting||finishing||testing;
    $('startBtn').disabled=active||busy||session.completed;
    $('startBtn').textContent=session.sections[part].visited?'Continue reading':'Start reading';
    $('pauseBtn').disabled=(!active&&!starting)||finishing;
    $('nextBtn').disabled=busy||session.completed;
    $('nextBtn').textContent=part===5?'Finish story ★':'Next part →';
    $('micTestBtn').disabled=active||busy;
    ['newSessionBtn','loadSessionBtn','sessionSelect'].forEach(id=>$(id).disabled=active||busy);
    $('recordDot').classList.toggle('live',active);
    $('childStatus').textContent=starting?'Getting your headset ready…':finishing?'Saving your voice…':active?'Recording · read when ready':session.completed?'Story finished!':'Ready when you are';
  }
  function makePassage(container,text,states,parent=false){
    container.replaceChildren();let index=0;
    for(const paragraph of text.split(/\n\s*\n/)){
      const p=document.createElement('p');
      for(const w of C.tokens(paragraph)){
        const i=index++,span=document.createElement(parent?'button':'span');
        const state=states[i]||'unread';span.textContent=w.display;span.className='word '+(parent?state:(['correct','pending'].includes(state)?state:''));span.dataset.word=String(i);
        if(parent){const mark=session.sections[reviewPart].marks[i];span.type='button';span.classList.toggle('parent-mark',!!mark);span.setAttribute('aria-label',`Word ${i+1}: ${w.display}. ${mark?labels[mark]:'No parent mark'}. Automatic: ${state}`);}
        p.append(span,document.createTextNode(' '));
      }
      container.append(p);
    }
  }
  function renderReader(rebuild=false){
    $('chapterLabel').textContent=`PART ${part+1} OF 6`;$('chapterTitle').textContent=story.sections[part].title;
    $('steps').replaceChildren();session.sections.forEach((s,i)=>{const step=document.createElement('span');step.className='step'+(s.finished?' done':'')+(i===part?' current':'');step.setAttribute('aria-label',`Part ${i+1}${s.finished?', visited through next button':''}`);$('steps').append(step);});
    if(rebuild)makePassage($('passage'),story.sections[part].text,session.sections[part].states);
    else $('passage').querySelectorAll('[data-word]').forEach(el=>{const st=session.sections[part].states[Number(el.dataset.word)];el.className='word '+(['correct','pending'].includes(st)?st:'');});
    $('finishCard').hidden=!session.completed;$('passage').hidden=session.completed;updateButtons();
  }
  function tick(){if(active){session.sections[part].seconds=sectionBaseSeconds+(performance.now()-startedAt)/1000;save();}}
  function closeGap(now){if(gapStart!==null&&now-gapStart>=3&&segment)session.gaps.push({section:part,segment:segment.id,start:gapStart,duration:now-gapStart});gapStart=null;}
  function monitor(mic){
    const Context=window.AudioContext||window.webkitAudioContext;
    $('inputStatus').textContent='Microphone: '+(mic.getAudioTracks()[0]?.label||'browser default');
    if(!Context)return;
    ctx=new Context();const analyser=ctx.createAnalyser();analyser.fftSize=1024;
    ctx.createMediaStreamSource(mic).connect(analyser);ctx.resume().catch(()=>{});
    const samples=new Float32Array(analyser.fftSize);
    const draw=()=>{
      if(!active)return;analyser.getFloatTimeDomainData(samples);
      const rms=Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length),now=(performance.now()-startedAt)/1000;
      $('inputLevel').value=Math.min(100,rms*500);
      if(rms>.003){sound=true;if(heardAny)closeGap(now);heardAny=true;lastSound=now;}
      else if(heardAny&&gapStart===null&&now-lastSound>.3)gapStart=lastSound;
      frame=requestAnimationFrame(draw);
    };draw();
  }
  function release(){if(frame!==null)cancelAnimationFrame(frame);frame=null;if(ctx){ctx.close().catch(()=>{});ctx=null;}if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}$('inputLevel').value=0;}
  function refreshAlignment(s,final,interim=''){
    const heard=C.words([final,interim].filter(Boolean).join(' ')),limit=expected[part].length*6;
    if(heard.length>limit){$('speechStatus').textContent='Long repeated passage: alignment paused for this part. Recording continues.';return;}
    s.states=C.align(expected[part],heard,C.words(final).length);renderReader();
  }
  function startSpeech(token){
    if(!Recognition){$('speechStatus').textContent='Live tracking unavailable in this browser. Audio is still recording.';showHelp('Your voice is recording. A grown-up can listen later. For live word colours, use Chrome or Edge.');return;}
    const instance=new Recognition(),s=session.sections[part],base=s.transcript;let finals='',interim='';
    recognition=instance;instance.lang='en-CA';instance.continuous=true;instance.interimResults=true;instance.maxAlternatives=1;
    const valid=()=>token===run&&recognition===instance;
    instance.onstart=()=>{if(valid())$('speechStatus').textContent='Speech service started.';};
    instance.onresult=e=>{
      if(!valid())return;speechRetries=0;const f=[],p=[];for(let i=0;i<e.results.length;i++)(e.results[i].isFinal?f:p).push(e.results[i][0].transcript);
      finals=f.join(' ');interim=p.join(' ');s.transcript=[base,finals].filter(Boolean).join(' ');
      $('speechStatus').textContent='Receiving words. Speech matches still need parent review.';showHelp('');refreshAlignment(s,s.transcript,interim);save();
    };
    instance.onerror=e=>{
      if(!valid()||e.error==='aborted'||e.error==='no-speech')return;
      $('speechStatus').textContent='Speech service: '+e.error+'. Audio recording continues.';
      showHelp('Your voice is still recording. The word colours have paused. Keep reading, or ask a grown-up to check the connection.');
      if(['not-allowed','service-not-allowed','language-not-supported'].includes(e.error))speechRetries=4;
    };
    instance.onend=()=>{
      if(!valid())return;refreshAlignment(s,s.transcript);save();recognition=null;
      if(speechFinish){const resolve=speechFinish;speechFinish=null;resolve();}
      if(active&&token===run&&speechRetries<4){speechRetries++;setTimeout(()=>{if(active&&token===run)try{startSpeech(token);}catch{ $('speechStatus').textContent='Speech service stopped. Recording continues.';}},500);}
    };
    instance.start();
  }
  async function start(){
    if(active||starting||finishing||testing||session.completed)return;
    starting=true;const token=++run;updateButtons();showHelp('');childHint('Getting your headset ready. If Chrome asks, choose Allow.');
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){starting=false;showHelp('Recording needs a secure HTTPS page and a supported browser. Ask a grown-up to open this site in Chrome or Edge.');updateButtons();return;}
    let mic;
    try{
      let expired=false,permissionTimer;
      const request=navigator.mediaDevices.getUserMedia({audio:true});
      request.then(late=>{if(expired||token!==run)late.getTracks().forEach(t=>t.stop());},()=>{});
      try{mic=await Promise.race([request,new Promise((resolve,reject)=>{permissionTimer=setTimeout(()=>{expired=true;reject(Object.assign(new Error('Microphone permission did not finish'),{name:'TimeoutError'}));},20000);})]);}
      finally{clearTimeout(permissionTimer);}
      if(token!==run){mic.getTracks().forEach(t=>t.stop());return;}
      stream=mic;const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
      const rec=new MediaRecorder(mic,mime?{mimeType:mime}:undefined),owner=session,section=part;
      segment={id:uid(),section,created:new Date().toISOString(),mime:rec.mimeType||'audio/webm',seconds:0,chunks:0,finished:false};
      const seg=segment,blobs=[];memoryAudio.set(seg.id,blobs);owner.segments.push(seg);pendingWrites=[];
      rec.ondataavailable=e=>{if(!e.data.size)return;const index=blobs.length;blobs.push(e.data);seg.chunks=blobs.length;
        const write=putChunk({id:seg.id+':'+index,sessionId:owner.id,segmentId:seg.id,index,blob:e.data}).catch(()=>{storageError='Audio storage failed. Keep this page open and download the ZIP before closing.';save();});pendingWrites.push(write);save();};
      rec.onerror=()=>{showHelp('The recording stopped unexpectedly. Please ask a grown-up for help.');$('speechStatus').textContent='Recorder error. Existing clips are kept.';stop().catch(()=>{});};
      recorder=rec;active=true;starting=false;startedAt=performance.now();sectionBaseSeconds=owner.sections[section].seconds;sound=false;heardAny=false;gapStart=null;lastSound=0;speechRetries=0;
      owner.sections[section].visited=true;rec.start(5000);
      try{monitor(mic);}catch{$('inputStatus').textContent='Microphone open. Sound meter unavailable.';}
      document.body.classList.add('reading');$('recordingNote').textContent='Recording your voice · saved on this device';childHint('Read smoothly, one phrase at a time. Take a breath at a full stop.');
      timer=setInterval(tick,1000);updateButtons();save();
      try{startSpeech(token);}catch{$('speechStatus').textContent='Speech tracking unavailable. Recording continues.';showHelp('Your voice is recording. A grown-up can listen later even if the word colours do not move.');}
      watchdog=setTimeout(()=>{if(!active||token!==run)return;if(!sound)showHelp('We cannot hear you yet. Check the headset mute switch and speak near the mic. If the bar stays flat, ask a grown-up.');else if(!owner.sections[section].transcript)showHelp('We can hear sound. The speech service has not sent words yet. Your voice is still recording.');},12000);
    }catch(err){if(mic)mic.getTracks().forEach(t=>t.stop());release();if(token!==run)return;active=false;starting=false;$('recordingNote').textContent='Recording has not started.';showHelp(err.name==='NotAllowedError'?'Chrome could not use the microphone. Choose Allow in the site microphone settings, then press Start again. Ask a grown-up if you need help.':'The headset could not start. Connect it, check its mute switch, and press Start again. ('+(err.name||'recording error')+')');childHint('No rush. Get a grown-up to help with the headset.');updateButtons();}
  }
  async function stop(){
    if(stopTask)return stopTask;
    if(starting&&!active){run++;starting=false;childHint('Paused. Press Start when your headset is ready.');updateButtons();return;}
    if(!active)return;
    stopTask=(async()=>{
      tick();const secs=(performance.now()-startedAt)/1000;closeGap(secs);active=false;finishing=true;clearInterval(timer);clearTimeout(watchdog);updateButtons();
      if(segment)segment.seconds=secs;
      const rec=recorder;
      const audioDone=new Promise(resolve=>{if(!rec||rec.state==='inactive'){resolve();return;}rec.onstop=resolve;try{rec.stop();}catch{resolve();}});
      const speechDone=new Promise(resolve=>{if(!recognition){resolve();return;}speechFinish=resolve;try{recognition.stop();}catch{resolve();}setTimeout(resolve,1100);});
      await Promise.all([audioDone,speechDone]);run++;recognition=null;speechFinish=null;release();
      await Promise.allSettled(pendingWrites);if(segment)segment.finished=true;segment=null;recorder=null;finishing=false;
      $('recordingNote').textContent='Voice saved · microphone off';childHint('Good work. Continue when ready, or move to the next part.');save();renderReader();
    })();
    try{await stopTask;}finally{stopTask=null;}
  }
  async function next(){
    if(starting||finishing||testing||session.completed)return;const wasActive=active;await stop();session.sections[part].finished=true;
    if(part===5){session.completed=true;childHint('You reached the end. Well done, Kaleb!');document.body.classList.add('reading');save();renderReader(true);$('chapterTitle').focus();return;}
    part++;reviewPart=part;selected=null;save();renderReader(true);$('chapterTitle').scrollIntoView({block:'start'});$('chapterTitle').focus();
    childHint('A new clue! Press Start when you are ready.');if(wasActive)await start();
  }
  function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  const fileBase=()=> 'kaleb-reading-'+session.created.slice(0,10)+'-'+session.id;
  function report(){return {...session,summary:C.summary(session,story),story:{id:story.id,title:story.title,sections:story.sections},notes:'Automatic speech matches and audio gaps are unverified. No pronunciation grade.'};}
  function sentenceAt(section,index){const t=expected[section];let a=index,b=index;while(a>0&&!/[.!?]["”']?$/.test(t[a-1].display))a--;while(b<t.length-1&&!/[.!?]["”']?$/.test(t[b].display))b++;return t.slice(a,b+1).map(w=>w.display).join(' ');}
  function renderSuggestions(){
    const div=$('suggestions');div.replaceChildren();const picks=[];
    session.sections.forEach((s,i)=>Object.entries(s.marks).forEach(([j,mark])=>{if(['hesitation','skipped','pronunciation'].includes(mark))picks.push({section:i,word:Number(j),reason:'Parent checked: '+labels[mark]});}));
    if(!picks.length)session.sections.forEach((s,i)=>{const j=s.states.findIndex(x=>x==='possible'||x==='check');if(j>=0)picks.push({section:i,word:j,reason:'Automatic flag only — listen before choosing'});});
    const seen=new Set();for(const pick of picks){const text=sentenceAt(pick.section,pick.word);if(seen.has(text))continue;seen.add(text);if(seen.size>3)break;
      const box=document.createElement('div');box.className='practice';const label=document.createElement('small');label.textContent=`Part ${pick.section+1} · ${pick.reason}`;const quote=document.createElement('blockquote');quote.textContent=text;const row=document.createElement('div');row.className='button-row';const model=document.createElement('button');model.textContent='Hear a smooth example';model.disabled=!window.speechSynthesis;model.onclick=()=>{speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='en-CA';utterance.rate=.85;speechSynthesis.speak(utterance);};row.append(model);box.append(label,quote,row);div.append(box);
    }
    if(!seen.size)div.textContent='After reading, listen to a clip and mark two or three words or phrases that need practice. Try a smooth reread, then use the phrase in a new sentence.';
  }
  function renderReview(){
    const s=session.sections[reviewPart];$('reviewSection').value=String(reviewPart);makePassage($('reviewPassage'),story.sections[reviewPart].text,s.states,true);
    $('sectionStats').textContent=`${C.secondsText(s.seconds)} active reading · ${s.states.filter(x=>x==='correct').length} of ${expected[reviewPart].length} words speech-matched · ${s.finished?'Next/Finish was pressed':'Not marked finished'}`;
    $('transcript').textContent=s.transcript||'No transcript yet. Listen to audio if the speech service missed words.';
    const gaps=session.gaps.filter(g=>g.section===reviewPart);$('gapList').replaceChildren();
    gaps.forEach(g=>{const p=document.createElement('p');p.textContent=`Clip ${session.segments.findIndex(s=>s.id===g.segment)+1}: around ${C.secondsText(g.start)}, ${Math.round(g.duration)} seconds quiet.`;$('gapList').append(p);});if(!gaps.length)$('gapList').textContent='No long audio gaps logged.';
    $('markPanel').hidden=selected===null;if(selected!==null)$('selectedWord').textContent=`Word ${selected+1}: ${expected[reviewPart][selected].display} — ${labels[s.marks[selected]]||'Not reviewed'}`;
  }
  async function renderClips(){
    const owner=session.id,div=$('recordings');div.replaceChildren();
    if(!session.segments.length){div.textContent='No recordings yet. Every Start reading makes a recorded clip.';return;}
    for(const [index,seg] of session.segments.entries()){
      const box=document.createElement('div');box.className='clip';const title=document.createElement('strong');title.textContent=`Clip ${index+1} · Part ${seg.section+1}: ${story.sections[seg.section].title}`;const small=document.createElement('small');small.textContent=`${C.secondsText(seg.seconds)} · ${seg.finished?'Saved clip':'Recovered partial clip; last few seconds may be missing'}`;box.append(title,small);div.append(box);
      try{const blob=await clipBlob(seg);if(owner!==session.id)return;if(!blob){small.textContent+=' · Audio unavailable in browser storage';continue;}
        let url=audioUrls.get(seg.id);if(!url){url=URL.createObjectURL(blob);audioUrls.set(seg.id,url);}const audio=document.createElement('audio');audio.controls=true;audio.preload='metadata';audio.src=url;audio.setAttribute('aria-label',`Play clip ${index+1}, part ${seg.section+1}`);const button=document.createElement('button');button.textContent='Download clip '+(index+1);button.onclick=()=>download(blob,`${fileBase()}-part-${seg.section+1}-clip-${index+1}.${seg.mime.includes('mp4')?'m4a':'webm'}`);box.append(audio,button);
      }catch{small.textContent+=' · Could not load audio. Keep the page open and try download again.';}
    }
  }
  function renderParent(){
    const r=C.summary(session,story);$('stats').replaceChildren();
    for(const [value,label] of [[C.secondsText(r.seconds),'Active reading time'],[r.spokenWpm??'—','Speech words/min · estimate'],[`${r.matched}/${r.total}`,'Unique speech matches'],[r.errors,'Parent-confirmed practice items']]){const div=document.createElement('div');div.className='stat';const strong=document.createElement('strong'),span=document.createElement('span');strong.textContent=value;span.textContent=label;div.append(strong,span);$('stats').append(div);}
    $('rateNote').textContent=`${r.visited} of 6 parts attempted. ${r.flagged} automatic flags; ${r.reviewed} words parent checked. Rate includes natural pauses within a reading segment and repeated spoken words; button pauses are excluded. It is not a standard fluency score or pronunciation accuracy.`;
    $('reviewSection').replaceChildren();story.sections.forEach((s,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=`${i+1}. ${s.title}`;$('reviewSection').append(option);});
    renderReview();renderSuggestions();renderClips();$('sessionSelect').replaceChildren();readSessions().forEach(s=>{const option=document.createElement('option');option.value=s.id;option.textContent=new Date(s.created).toLocaleString()+(s.completed?' · Finished':' · In progress');$('sessionSelect').append(option);});$('sessionSelect').value=session.id;save();
  }
  async function view(parent){
    if(parent)await stop();$('readerView').hidden=parent;$('parentView').hidden=!parent;$('readerTab').setAttribute('aria-pressed',String(!parent));$('parentTab').setAttribute('aria-pressed',String(parent));
    if(parent)renderParent();else renderReader();window.scrollTo({top:0,behavior:'instant'});
  }
  $('startBtn').onclick=start;$('pauseBtn').onclick=stop;$('nextBtn').onclick=next;
  $('parentTab').onclick=()=>view(true);$('readerTab').onclick=()=>view(false);$('backBtn').onclick=()=>view(false);$('homeLink').onclick=e=>{e.preventDefault();view(false);};
  $('reviewSection').onchange=()=>{reviewPart=Number($('reviewSection').value);selected=null;renderReview();};
  $('reviewPassage').onclick=e=>{const button=e.target.closest('[data-word]');if(button){selected=Number(button.dataset.word);renderReview();}};
  document.querySelectorAll('[data-mark]').forEach(button=>button.onclick=()=>{if(selected===null)return;const mark=button.dataset.mark;if(mark==='clear')delete session.sections[reviewPart].marks[selected];else session.sections[reviewPart].marks[selected]=mark;save();renderReview();renderSuggestions();const r=C.summary(session,story);$('stats').lastElementChild.querySelector('strong').textContent=r.errors;});
  $('csvBtn').onclick=()=>{download(new Blob([C.csv(session,story)],{type:'text/csv;charset=utf-8'}),fileBase()+'.csv');$('exportStatus').textContent='CSV download requested. Check browser Downloads.';};
  $('jsonBtn').onclick=()=>{download(new Blob([JSON.stringify(report(),null,2)],{type:'application/json'}),fileBase()+'.json');$('exportStatus').textContent='Report download requested. Audio is available in the ZIP.';};
  $('bundleBtn').onclick=async()=>{
    $('bundleBtn').disabled=true;$('exportStatus').textContent='Preparing your report and local audio…';
    try{const files=[{name:'reading-report.csv',blob:new Blob([C.csv(session,story)],{type:'text/csv'})},{name:'reading-report.json',blob:new Blob([JSON.stringify(report(),null,2)],{type:'application/json'})}];let missing=0;
      for(const [i,seg] of session.segments.entries()){const blob=await clipBlob(seg);if(blob)files.push({name:`audio/part-${seg.section+1}-clip-${i+1}.${seg.mime.includes('mp4')?'m4a':'webm'}`,blob});else missing++;}
      if(missing)files.push({name:'MISSING-AUDIO.txt',blob:new Blob([`${missing} audio clip(s) could not be recovered from this browser. The report lists them for reference.`])});
      download(await C.zip(files),fileBase()+'.zip');$('exportStatus').textContent=`ZIP download requested: report and ${files.filter(f=>f.name.startsWith('audio/')).length} audio clips.${missing?' Some audio was unavailable; see MISSING-AUDIO.txt.':''} Nothing was uploaded.`;
    }catch{$('exportStatus').textContent='Could not make the ZIP. Try individual clip and CSV downloads instead.';}finally{$('bundleBtn').disabled=false;}
  };
  $('loadSessionBtn').onclick=async()=>{await stop();const chosen=readSessions().find(s=>s.id===$('sessionSelect').value);if(!chosen)return;session=chosen;part=chosen.index||0;reviewPart=part;selected=null;renderReader(true);renderParent();};
  $('newSessionBtn').onclick=async()=>{await stop();save();session=makeSession();part=reviewPart=0;selected=null;save();document.body.classList.remove('reading');renderReader(true);renderParent();$('newSessionStatus').textContent='New story session ready. Earlier sessions are kept in the list above.';};
  $('micTestBtn').onclick=async()=>{
    if(active||starting||testing)return;testing=true;updateButtons();$('micTestResult').textContent='Opening headset…';let mic,context,raf;
    try{mic=await navigator.mediaDevices.getUserMedia({audio:true});const name=mic.getAudioTracks()[0]?.label||'browser default';$('inputStatus').textContent='Microphone: '+name;const Context=window.AudioContext||window.webkitAudioContext;
      if(!Context){$('micTestResult').textContent='Microphone permission passed. Sound-level check is unavailable.';return;}
      context=new Context();await context.resume();const a=context.createAnalyser();a.fftSize=1024;context.createMediaStreamSource(mic).connect(a);const samples=new Float32Array(a.fftSize);let peak=0;
      const update=()=>{a.getFloatTimeDomainData(samples);const rms=Math.sqrt(samples.reduce((n,x)=>n+x*x,0)/samples.length);peak=Math.max(peak,rms);$('inputLevel').value=Math.min(100,rms*500);raf=requestAnimationFrame(update);};update();$('micTestResult').textContent='Speak into '+name+' now. Checking for five seconds; not saving audio.';await new Promise(r=>setTimeout(r,5000));$('micTestResult').textContent=peak>.003?'PASS: permission and input sound detected. Headset: '+name:'Microphone opened, but no clear sound was detected. Check mute and input selection. Headset: '+name;
    }catch(e){$('micTestResult').textContent='Microphone check failed: '+(e.name||'unknown error')+'. Check permission and connection.';}finally{if(raf)cancelAnimationFrame(raf);if(context)context.close().catch(()=>{});mic?.getTracks().forEach(t=>t.stop());$('inputLevel').value=0;testing=false;updateButtons();}
  };
  window.addEventListener('beforeunload',e=>{if(active||starting||finishing){e.preventDefault();e.returnValue='';}});
  window.addEventListener('pagehide',()=>{if(active){tick();try{recorder?.requestData();recorder?.stop();}catch{}release();}});
  session=readSessions()[0]||makeSession();part=Math.min(5,Math.max(0,session.index||0));reviewPart=part;
  // A crashed/closed tab may have saved chunks before its recorder stopped.
  session.segments.filter(s=>!s.finished).forEach(s=>{s.recovered=true;});
  const total=expected.reduce((n,w)=>n+w.length,0);$('storyMeta').textContent=`One story · ${total.toLocaleString()} words · about 20 minutes at ${Math.round(total/20)} words/min`;
  $('storyDetails').textContent=`${total.toLocaleString()} words in six connected parts. Roughly 20 minutes at ${Math.round(total/20)} words per minute; actual reading time varies. Pauses and rereads are welcome.`;
  save();renderReader(true);if(session.completed)document.body.classList.add('reading');
  dbReady.then(()=>save());
})();

