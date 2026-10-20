(function(root){
  'use strict';
  const normalize=s=>s.toLowerCase().normalize('NFD').replace(/[\p{M}]/gu,'').replace(/[^\p{L}\p{N}]/gu,'');
  const words=s=>(s.match(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu)||[]).map(normalize).filter(Boolean);
  const tokens=s=>(s.match(/\S+/g)||[]).map(display=>({display,value:normalize(display)})).filter(w=>w.value);
  // Bounded by one story section. Insertions are cheap enough to allow restarts
  // such as "he waits, he waits until" without marking every repeated word wrong.
  function align(expected,heard,confirmed=heard.length){
    const n=heard.length,m=expected.length,stride=n+1;
    if(!n)return Array(m).fill('unread');
    const cost=new Float32Array((m+1)*stride),back=new Uint8Array(cost.length);
    for(let i=1;i<=m;i++){cost[i*stride]=i*1.15;back[i*stride]=2;}
    for(let j=1;j<=n;j++){cost[j]=j*.85;back[j]=3;}
    for(let i=1;i<=m;i++)for(let j=1;j<=n;j++){
      const exact=expected[i-1].value===heard[j-1];
      let c=cost[(i-1)*stride+j-1]+(exact?0:1.8),d=1;
      if(cost[(i-1)*stride+j]+1.15<c-.00001){c=cost[(i-1)*stride+j]+1.15;d=2;}
      const repeated=j>1&&heard.slice(Math.max(0,j-5),j-1).includes(heard[j-1]);
      const extra=cost[i*stride+j-1]+(repeated?.35:.85);
      if(extra<c-.00001){c=extra;d=3;}
      cost[i*stride+j]=c;back[i*stride+j]=d;
    }
    let end=0,best=Infinity;
    for(let i=0;i<=m;i++)if(cost[i*stride+n]-i*.0001<best){best=cost[i*stride+n]-i*.0001;end=i;}
    const result=Array(m).fill('unread');let i=end,j=n;
    while(i||j){const d=back[i*stride+j];if(d===1){result[i-1]=j>confirmed?'pending':expected[i-1].value===heard[j-1]?'correct':'check';i--;j--;}else if(d===2){result[i-1]=j>confirmed?'pending':'possible';i--;}else if(d===3)j--;else break;}
    return result;
  }
  const secondsText=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
  function summary(session,story){
    let matched=0,flagged=0,reviewed=0,errors=0,spoken=0,seconds=0,visited=0;
    session.sections.forEach(s=>{matched+=s.states.filter(x=>x==='correct').length;flagged+=s.states.filter(x=>x==='possible'||x==='check').length;spoken+=words(s.transcript).length;seconds+=s.seconds;visited+=s.visited?1:0;Object.values(s.marks).forEach(mark=>{reviewed++;if(['skipped','pronunciation','hesitation'].includes(mark))errors++;});});
    const total=story.sections.reduce((n,s)=>n+tokens(s.text).length,0);
    return {matched,flagged,reviewed,errors,spoken,seconds,visited,total,spokenWpm:seconds>=15?Math.round(spoken*60/seconds):null,matchWpm:seconds>=15?Math.round(matched*60/seconds):null};
  }
  const csvCell=x=>'"'+String(x??'').replace(/"/g,'""')+'"';
  function csv(session,story){
    const r=summary(session,story);
    const rows=[['Metric','Value'],['App version',session.version||'2.0'],['Story',story.title],['Session date',session.created],['Active reading seconds',Math.round(r.seconds)],['Speech words per minute (estimate; includes repeats)',r.spokenWpm??'Not enough reading time'],['Unique speech-matched words per minute (estimate)',r.matchWpm??'Not enough reading time'],['Story words',r.total],['Speech-matched words',r.matched],['Automatic flags (unverified)',r.flagged],['Parent reviewed',r.reviewed],['Parent confirmed practice items',r.errors],['Sections visited',r.visited],['Story finished',!!session.completed],['Note','Speech matches are not pronunciation grades. Audio gaps are unverified and may be natural pauses.'],[],['Section','Title','Active seconds','Transcript']];
    session.sections.forEach((s,i)=>rows.push([i+1,story.sections[i].title,Math.round(s.seconds),s.transcript]));
    rows.push([],['Section','Word number','Word','Automatic result (unverified)','Parent review']);
    session.sections.forEach((s,i)=>tokens(story.sections[i].text).forEach((w,j)=>rows.push([i+1,j+1,w.display,s.states[j]==='correct'?'speech-match-unverified':s.states[j]||'unread',s.marks[j]||'Not reviewed'])));
    rows.push([],['Audio gap: section','Segment','Start seconds in recording','Gap seconds','Note']);
    session.gaps.forEach(g=>rows.push([g.section+1,g.segment,g.start.toFixed(1),g.duration.toFixed(1),'Audio only; listen before interpreting']));
    if(session.coachPlan){
      rows.push([],['AI practice section','Phrase','Reason','Status']);
      session.coachPlan.targets.forEach(t=>rows.push([t.section+1,t.phrase,t.reason,'Possible practice target, not a confirmed mistake']));
      rows.push(['Next story',session.coachPlan.story.title],['Coaching prepared',session.coachPlan.created]);
      rows.push(['Evidence method',session.coachPlan.evidenceVersion===3?'Two recognition passes; agreement is unverified':'Legacy single-pass report; not rechecked']);
      rows.push([],['AI evidence section','Word number','Word','Evidence status (not a correctness grade)']);
      (session.coachPlan.reports||[]).forEach((report,i)=>(report.states||[]).forEach((state,j)=>rows.push([i+1,j+1,tokens(story.sections[i].text)[j]?.display||'',state])));
      rows.push([],['Recognition disagreement: section','Clip','Timing pass','Verbatim pass','Seconds in recording']);
      (session.coachPlan.reports||[]).forEach((report,i)=>(report.issues||[]).forEach(issue=>rows.push([i+1,issue.clip,issue.timingWords,issue.verbatimWords,issue.start])));
    }
    return '\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
  }
  function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
  async function zip(files){
    const local=[],central=[];let offset=0,centralSize=0;const enc=new TextEncoder();
    for(const file of files){const name=enc.encode(file.name),data=new Uint8Array(await file.blob.arrayBuffer()),crc=crc32(data);
      const header=new Uint8Array(30+name.length),v=new DataView(header.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);header.set(name,30);local.push(header,data);
      const c=new Uint8Array(46+name.length),w=new DataView(c.buffer);w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);w.setUint16(8,0x800,true);w.setUint32(16,crc,true);w.setUint32(20,data.length,true);w.setUint32(24,data.length,true);w.setUint16(28,name.length,true);w.setUint32(42,offset,true);c.set(name,46);central.push(c);centralSize+=c.length;offset+=header.length+data.length;
    }
    const end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,centralSize,true);v.setUint32(16,offset,true);
    return new Blob([...local,...central,end],{type:'application/zip'});
  }
  const api={normalize,words,tokens,align,summary,csv,secondsText,zip};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.CoachCore=api;
})(typeof window==='object'?window:globalThis);

