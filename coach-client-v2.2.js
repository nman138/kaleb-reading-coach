(() => {
  'use strict';
  const $=id=>document.getElementById(id),UI=window.CoachUI;
  let available=false,running=false,reportOwner=null;
  const replayUrls=new Map();
  const status=text=>{$('aiStatus').textContent=text;$('childCoachStatus').textContent=text;};
  async function request(path,body,headers={}){
    const r=await fetch(path,{method:'POST',headers:{'X-Coach-Request':'1',...headers},body,signal:AbortSignal.timeout(270000)});
    let data;try{data=await r.json();}catch{throw new Error('The private coach connection is unavailable.');}
    if(!r.ok)throw new Error(data.error||'The coach could not finish.');return data;
  }
  function display(){
    const plan=UI.session().coachPlan,div=$('autoPractice');div.replaceChildren();
    $('parentPlanSummary').textContent=plan?(plan.evidenceVersion!==3?'Earlier report: made with the previous single-pass recognizer. Its suggestions have not been rechecked.':plan.targets.length?plan.targets.map(t=>t.reason+': '+t.phrase).join('\n\n'):'No supported trouble spots selected. General fluency practice prepared; this does not mean error-free reading.'):'Practice targets appear here after automatic coaching finishes.';
    const evidence=$('parentAiEvidence');
    if(evidence){
      evidence.replaceChildren();
      if(reportOwner!==UI.session().id){for(const url of replayUrls.values())URL.revokeObjectURL(url);replayUrls.clear();reportOwner=UI.session().id;}
      if(plan?.evidenceVersion===3){
        const note=document.createElement('p');note.textContent='Automatic matches are unverified. Small words stay unverified even if both recognizers agree. Uncertain evidence does not become a mistake or increase the reading level.';evidence.append(note);
        for(const [i,report] of (plan.reports||[]).entries()){
          const detail=document.createElement('details'),title=document.createElement('summary'),text=document.createElement('p');
          title.textContent=`Part ${i+1}: ${report.issues?.length||0} recognition disagreements · ${report.uncertainWords||0} words unverified`;
          text.textContent=report.transcript||'No reliable transcript available.';detail.append(title,text);evidence.append(detail);
        }
        for(const target of plan.targets){
          const seg=UI.session().segments.find(s=>s.id===target.clip);if(!seg)continue;
          const button=document.createElement('button');button.textContent='Listen near: '+target.word;
          button.onclick=async()=>{
            const owner=UI.session().id;button.disabled=true;
            try{const blob=await UI.blob(seg);if(owner!==UI.session().id)return;if(!blob)throw Error('Recording unavailable.');
              let url=replayUrls.get(seg.id);if(!url){url=URL.createObjectURL(blob);replayUrls.set(seg.id,url);}
              const audio=document.createElement('audio');audio.controls=true;audio.src=url;audio.onloadedmetadata=()=>{audio.currentTime=target.start||0;};button.after(audio);
              audio.ontimeupdate=()=>{if(audio.currentTime>=target.end)audio.pause();};
            }catch(e){button.textContent=e.message;button.disabled=false;}
          };evidence.append(button);
        }
      }
    }
    if(plan){
      for(const target of plan.targets.slice(0,3)){
        const box=document.createElement('div');box.className='practice';
        const text=document.createElement('p');text.textContent=target.phrase;
        const why=document.createElement('small');why.textContent=target.reason+' — possible practice target, not a confirmed mistake.';
        const play=document.createElement('button');play.textContent='Hear an example';
        play.disabled=!window.speechSynthesis;play.onclick=()=>{
          speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(target.phrase);u.rate=.85;u.lang='en-CA';speechSynthesis.speak(u);
        };
        box.append(why,text,play);div.append(box);
      }
      if(!plan.targets.length)div.textContent='No reliable trouble spots were selected. The next story offers general smooth-reading practice.';
    }
    $('nextStoryBtn').hidden=!plan;$('nextStoryBtn').disabled=running;
    $('analyseBtn').disabled=!available||running||!UI.session().completed;
  }
  async function run(){
    if(running)return;
    if(!available){status('Automatic coaching is not connected. Your reading is saved.');return;}
    const owner=UI.session();
    if(owner.coachPlan){status('Your next story is ready.');display();return;}
    if(!owner.completed){status('Finish the story before preparing the next one.');return;}
    running=true;UI.busy(true);display();
    try {
      const clips=[];
      for(const [i,seg] of owner.segments.entries()){
        status(`Preparing practice: checking recording ${i+1} of ${owner.segments.length}…`);
        if(seg.aiTranscript?.evidenceVersion!==3){
          const blob=await UI.blob(seg);
          if(!blob)throw new Error('A saved recording is missing. Keep the current story and ask a grown-up to check.');
          if(blob.size>9*1024*1024)throw new Error('A recording is too large for this coach. Try shorter reading sections next time.');
          const quality=await window.checkRecording(blob);
          if(quality.status==='quiet'||quality.status==='clipped'||quality.status==='unknown'){
            seg.aiTranscript={id:seg.id,evidenceVersion:3,dual:false,text:'',words:[],quality,warning:quality.reason};
          }else{
            seg.aiTranscript={...await request('/api/transcribe',blob,{'Content-Type':seg.mime,'X-Clip-Id':seg.id}),quality};
          }
          UI.save();
        }
        clips.push({...seg.aiTranscript,section:seg.section,gaps:(owner.gaps||[]).filter(g=>g.segment===seg.id)});
      }
      if(!clips.length)throw new Error('There are no recordings to analyse.');
      status('Choosing practice and writing the next robot mystery…');
      owner.coachPlan=await request('/api/plan',JSON.stringify({id:owner.id,sections:UI.story().sections.map((s,i)=>({text:s.text,clips:clips.filter(c=>c.section===i)}))}),{'Content-Type':'application/json'});
      UI.save();status('Your next story is ready. Hear a practice example, then try reading the phrase smoothly.');
    }catch(e){status(e.message+' Your recordings are still saved. Use Retry coaching when ready.');}
    finally{running=false;UI.busy(false);display();}
  }
  $('analyseBtn').onclick=run;
  $('nextStoryBtn').onclick=()=>{const plan=UI.session().coachPlan;if(plan&&!running){UI.newStory(plan.story);display();status('Your new mystery is ready.');}};
  UI.onFinish=run;UI.onChange=display;
  const local=location.hostname==='127.0.0.1'&&location.port==='8767';
  if($('adultTestLink'))$('adultTestLink').hidden=!local;
  if(!local){$('autoEnabled').disabled=true;status('Automatic coaching runs in the private laptop version. Open “Start Reading Coach” on the laptop.');display();return;}
  $('connectionSetup').hidden=false;
  $('saveConnection').onclick=async()=>{
    const key=$('apiKeyInput').value.trim();
    $('saveConnection').disabled=true;
    try{
      const result=await request('/api/config',JSON.stringify({key,childDataApproved:$('childDataApproved').checked}),{'Content-Type':'application/json'});
      available=result.ready;$('apiKeyInput').value='';status(result.message);display();
    }catch(e){status(e.message);}
    finally{$('saveConnection').disabled=false;}
  };
  fetch('/api/status').then(r=>r.json()).then(data=>{
    available=data.ready;status(data.message);display();
    // The parent requested automatic coaching. Old sessions are never uploaded on load.
    $('autoEnabled').checked=localStorage.getItem('kaleb-auto-coach-consent')!=='no';
  }).catch(()=>{status('The private coach is offline. Reading still works.');display();});
  $('autoEnabled').onchange=()=>{
    localStorage.setItem('kaleb-auto-coach-consent',$('autoEnabled').checked?'yes':'no');
    status($('autoEnabled').checked?'Automatic coaching enabled for future finishes.':'Automatic uploads are off. Reading and recording still work.');
  };
  UI.onFinish=()=>{if($('autoEnabled').checked)return run();status('Reading saved. A grown-up can enable automatic coaching or press Retry coaching.');};
})();

