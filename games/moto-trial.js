// Lazy UI + Canvas 2D view. Simulation is in moto-trial-core.js; no rendering affects results.
let mtDepsPromise, mtView, mtBoard, mtSelected='quarry_v3', mtKeys=0, mtPointers=new Map(), mtKeyboard=new Set();
let mtGeneration=0, mtAudio=null, mtMuted=true, mtPending=null, mtStateBusy=false, mtSaveTask=null;
let mtPractice=true, mtLocalRound=null, mtLocalBest={};
// Ghosts: the best runs of the top 3 rivals, replayed in lockstep from their stored inputs.
let mtGhostData=null, mtGhostTask=null, mtGhostsOn=true;
try{mtGhostsOn=localStorage.getItem('rp_mt_ghosts')!=='0';}catch{}
const MT_GHOST_COLORS=['#c99712','#6f7f8c','#b0652c'];
function mtTraining(){return allGamesMode && mtPractice;}
function mtDependencies() {
 if(!mtDepsPromise)mtDepsPromise=Promise.all([
 new Promise((resolve,reject)=>{if(typeof mtStep==='function')return resolve();const s=document.createElement('script');s.src='games/moto-trial-core.js?v='+BUILD_ID;s.onload=resolve;s.onerror=reject;document.head.append(s);})
 ,new Promise((resolve,reject)=>{if(typeof MT_GOLDEN!=='undefined')return resolve();const s=document.createElement('script');s.src='games/moto-trial-golden.js?v='+BUILD_ID;s.onload=resolve;s.onerror=reject;document.head.append(s);})
 ]).catch(e=>{mtDepsPromise=null;throw e;});
 return mtDepsPromise;
}
function mtTime(ms){return (ms/1000).toFixed(2)+' s';}
function mtResultText(s){if(!s)return '—';return s?.completed||s?.score===10000?'🏁 '+mtTime(s.completion_ms):((s?.score||0)/100).toFixed(2)+'%';}
function mtSet(id,text){const e=document.getElementById(id);if(e)e.textContent=text;}
function mtStatus(text){mtSet('mt-status',text);}
function mtMode(){return allGamesMode?'arcade':'season';}
function mtVisible(){return allGamesMode?allGamesSelectedGame==='moto_trial':activeTab==='whack-boss'&&getCurrentSeasonalEntry().gameType==='moto_trial';}
async function mtInvoke(body){if(mtTraining() || body.roundId?.startsWith('local-'))return mtLocalAction(body);const {data,error}=await sb.functions.invoke('moto-trial-action',{body});if(error||!data?.ok)throw new Error(data?.error||error?.message||'Brak połączenia.');return data;}
function mtBuildPanel(){
 const host=document.getElementById('seasonal-game-moto-trial');if(host.querySelector('.mt-shell'))return;
 const css=document.createElement('style');css.textContent=`
 .mt-shell{max-width:1200px;margin:auto;background:#172b32;border:1px solid #3b5359;border-radius:18px;overflow:hidden;color:#f4f1e8;font-family:inherit}
 .mt-top,.mt-bottom{padding:16px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}.mt-top h2{margin:0;font-size:23px;letter-spacing:-.6px}.mt-kicker{font-size:10px;letter-spacing:2px;color:#c9d49d;font-weight:800}.mt-top .mt-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 .mt-shell button,.mt-shell select{border:1px solid #658087;border-radius:8px;padding:10px 14px;color:#fff;background:#29424a;font:inherit;cursor:pointer}.mt-shell button:disabled{opacity:.5;cursor:wait}.mt-shell button:focus-visible{outline:3px solid #ffcf68;outline-offset:2px}.mt-shell .mt-primary{background:#efbe62;border-color:#efbe62;color:#172b32;font-weight:800}
 .mt-info{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;background:#edf1ec;color:#172b32}.mt-course-label{font-size:12px;font-weight:700;letter-spacing:.04em}.mt-hud{position:static;display:flex;justify-content:flex-end;gap:8px;color:#172b32;font-variant-numeric:tabular-nums}.mt-hud strong{font-size:19px;display:block}.mt-hud small{font-size:9px;text-transform:uppercase;letter-spacing:1.2px}.mt-hud>div{min-width:94px;background:#fff;border-radius:5px;padding:6px 10px}
 .mt-stage{position:relative;width:100%;height:auto;aspect-ratio:16/9;background:#fff;overflow:hidden;touch-action:none}.mt-stage canvas{display:block;width:100%;height:100%}.mt-controls{display:flex;gap:8px;padding:12px 18px;background:#20373f}.mt-controls button{flex:1;touch-action:none;user-select:none;-webkit-user-select:none;min-height:52px;font-weight:700}.mt-controls button[data-held=true]{background:#a9c793;color:#172b32}.mt-controls .mt-gap{width:30px}.mt-bottom{justify-content:space-between;font-size:13px}.mt-help{color:#b8c9cc;padding:0 20px 16px;font-size:12px;line-height:1.7}.mt-records{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:16px 20px;background:#102329}.mt-records h3{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#c9d49d}.mt-records ol{list-style:none;padding:0;margin:0}.mt-records li{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid #ffffff12;font-size:13px}.mt-shell:fullscreen{max-width:none;width:100%;height:100%;border-radius:0;overflow:auto}.mt-shell:fullscreen{display:flex;flex-direction:column;overflow:hidden}.mt-shell:fullscreen .mt-stage{flex:1;min-height:0;aspect-ratio:auto}.mt-shell:fullscreen .mt-help,.mt-shell:fullscreen .mt-records{display:none}.mt-shell:fullscreen .mt-top,.mt-shell:fullscreen .mt-bottom{padding:8px 12px}.mt-shell:fullscreen .mt-controls{padding:6px 12px}
 @media(max-width:600px){.mt-top{padding:12px}.mt-top h2{font-size:19px}.mt-top .mt-actions{margin-left:0}.mt-info{align-items:flex-start;flex-direction:column;padding:10px}.mt-hud{width:100%;justify-content:space-between}.mt-hud>div{flex:1;min-width:0}.mt-hud strong{font-size:17px}.mt-hud small{font-size:8px}.mt-stage{aspect-ratio:4/3}.mt-records{grid-template-columns:1fr}.mt-controls{padding:10px}.mt-controls button{padding:8px 4px;font-size:12px}.mt-help{font-size:11px}}
 `;document.head.append(css);
 host.innerHTML=`<section class="mt-shell"><div class="mt-top"><div><div class="mt-kicker">G6 • TRIAL RACING</div><h2>Moto Trial <span style="color:#efbe62">G6</span></h2></div><div class="mt-actions"><select id="mt-course" aria-label="Trasa"><option value="quarry_v3">Kamieniołom</option><option value="mountain_v3">Górska Przełęcz</option></select><label id="mt-practice-wrap" style="font-size:12px"><input type="checkbox" id="mt-practice" checked> Trening bez rankingu</label><button id="mt-ghosts" aria-pressed="${mtGhostsOn}">Duchy: ${mtGhostsOn?'wł.':'wył.'}</button><button id="mt-sound" aria-label="Włącz dźwięk">Dźwięk: wył.</button><button id="mt-full">Pełny ekran</button></div></div><div class="mt-info"><div class="mt-course-label" id="mt-course-label">Kamieniołom</div><div class="mt-hud"><div><small>Czas</small><strong id="mt-time">0.00 s</strong></div><div><small>Trasa</small><strong id="mt-progress">0.00%</strong></div><div><small>Twój rekord</small><strong id="mt-best">—</strong></div></div></div><div class="mt-stage" id="mt-stage"></div><div class="mt-controls" aria-label="Sterowanie motocyklem"><button data-mt-key="4">← Odchyl</button><button data-mt-key="8">Pochyl →</button><span class="mt-gap"></span><button data-mt-key="2">↓ Hamulec</button><button data-mt-key="1">↑ Gaz</button></div><div class="mt-bottom"><div role="status" aria-live="polite" id="mt-status">Ładowanie trasy…</div><div><button id="mt-discard" hidden>Odrzuć zapis</button> <button id="mt-save" hidden>Zapisz ponownie</button> <button class="mt-primary" id="mt-start">Start / Ponów · R</button></div></div><div class="mt-help">W / ↑ gaz · S / ↓ hamulec · A / ← odchyl · D / → pochyl · R ponów. Jedno życie, dowolna liczba prób. Skacz z rozpędu, ląduj na kołach. Wszyscy jadą tym samym motocyklem — przedmioty nie dają premii. Duchy to najlepsze przejazdy trzech czołowych rywali — jadą razem z tobą.<br><span id="mt-season-note">Nagrody tygodnia: 🥇 1000 · 🥈 500 · 🥉 200 monet.</span></div><div class="mt-records"><div><h3 id="mt-rank-title">Ten tydzień</h3><ol id="mt-weekly"></ol></div><div><h3>Rekordy tej trasy</h3><ol id="mt-records"></ol></div></div></section>`;
 document.getElementById('mt-start').onclick=mtStartRun;
 document.getElementById('mt-practice').onchange=e=>mtChangeSetup(mtSelected,e.target.checked);
 document.getElementById('mt-save').onclick=()=>mtSavePending();
 document.getElementById('mt-discard').onclick=()=>{mtPending=null;document.getElementById('mt-save').hidden=true;document.getElementById('mt-discard').hidden=true;mtStatus('Zapis odrzucony. Możesz zacząć nową próbę.');};
 document.getElementById('mt-course').onchange=e=>{e.target.blur();mtChangeSetup(e.target.value,mtPractice);};
 document.getElementById('mt-full').onclick=()=>{const e=host.querySelector('.mt-shell');if(document.fullscreenElement)document.exitFullscreen();else e.requestFullscreen?.().catch(()=>mtStatus('Pełny ekran jest niedostępny w tej przeglądarce.'));};
 document.getElementById('mt-ghosts').onclick=e=>{mtGhostsOn=!mtGhostsOn;try{localStorage.setItem('rp_mt_ghosts',mtGhostsOn?'1':'0');}catch{}e.currentTarget.textContent='Duchy: '+(mtGhostsOn?'wł.':'wył.');e.currentTarget.setAttribute('aria-pressed',String(mtGhostsOn));};
 document.getElementById('mt-sound').onclick=()=>{mtMuted=!mtMuted;mtSet('mt-sound','Dźwięk: '+(mtMuted?'wył.':'wł.'));if(!mtMuted)mtAudioStart();else mtAudioStop();};
 for(const b of host.querySelectorAll('[data-mt-key]')){
 b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);mtPointers.set(e.pointerId,Number(b.dataset.mtKey));mtSyncKeys();};
 b.onpointerup=b.onpointercancel=b.onlostpointercapture=e=>{mtPointers.delete(e.pointerId);mtSyncKeys();};
 }
 document.addEventListener('keydown',e=>{if(!mtVisible()||isTypingTarget(e.target))return;const k=mtKeyFor(e.code);if(k){e.preventDefault();mtKeyboard.add(e.code);mtSyncKeys();}else if(motoTrialRuntime?.playing&&MT_SCROLL_KEYS.has(e.code))e.preventDefault();if(e.code==='KeyR'&&!e.repeat){e.preventDefault();mtStartRun();}});
 document.addEventListener('keyup',e=>{mtKeyboard.delete(e.code);mtSyncKeys();});
 window.addEventListener('blur',()=>{mtClearKeys();if(motoTrialRuntime?.playing)mtEndRun('Próba przerwana — okno straciło fokus.');});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){mtClearKeys();if(motoTrialRuntime?.playing)mtEndRun('Próba przerwana — karta została ukryta.');}});
 new ResizeObserver(()=>{if(mtView)mtView.resize();}).observe(document.getElementById('mt-stage'));
 // No page scrolling during a ride; the chat rail keeps its own scroll.
 const block=e=>{if(motoTrialRuntime?.playing&&mtVisible()&&!e.target.closest?.('#chat-rail'))e.preventDefault();};
 window.addEventListener('wheel',block,{passive:false});window.addEventListener('touchmove',block,{passive:false});
 window.addEventListener('resize',mtFit);document.addEventListener('fullscreenchange',mtFit);
}
async function mtChangeSetup(courseId,practice){
 if(mtStateBusy)return;mtStateBusy=true;
 const controls=['mt-start','mt-course','mt-practice'].map(id=>document.getElementById(id));controls.forEach(e=>e.disabled=true);
 try{await mtEndRun('Zmiana trasy lub trybu.');stopMotoTrialRound();mtSelected=courseId;mtPractice=practice;await loadMotoTrialState();}
 finally{mtStateBusy=false;controls.forEach(e=>e.disabled=false);}
}
const MT_SCROLL_KEYS=new Set(['Space','PageUp','PageDown','Home','End']);
// The stage takes whatever height lets the whole game (title bar, track, buttons, Start)
// fit under the sticky nav, never taller than its natural 16:9 (4:3 on phones).
function mtNavBottom(){const n=document.querySelector('.nav-tabs');return n?Math.max(0,n.getBoundingClientRect().bottom):0;}
function mtFit(){
 const stage=document.getElementById('mt-stage'),shell=stage?.closest('.mt-shell');if(!shell)return;
 if(document.fullscreenElement){stage.style.height='';return;}if(!shell.offsetParent)return;
 const controls=shell.querySelector('.mt-controls'),bottom=shell.querySelector('.mt-bottom');
 const above=stage.getBoundingClientRect().top-shell.getBoundingClientRect().top,below=controls.offsetHeight+bottom.offsetHeight;
 const natural=stage.clientWidth*(window.innerWidth<=600?3/4:9/16),room=window.innerHeight-mtNavBottom()-above-below-12;
 stage.style.aspectRatio='auto';stage.style.height=Math.round(Math.max(Math.min(180,natural),Math.min(natural,room)))+'px';
}
// Start lines the game up under the nav so the whole ride is on screen.
function mtLockView(){
 mtFit();const shell=document.getElementById('mt-stage')?.closest('.mt-shell');if(!shell||document.fullscreenElement)return;
 window.scrollTo({top:window.scrollY+shell.getBoundingClientRect().top-mtNavBottom()-6,behavior:'instant'});
}
function mtKeyFor(code){return {KeyW:1,ArrowUp:1,KeyS:2,ArrowDown:2,KeyA:4,ArrowLeft:4,KeyD:8,ArrowRight:8}[code]||0;}
function mtSyncKeys(){mtKeys=0;for(const k of mtKeyboard)mtKeys|=mtKeyFor(k);for(const k of mtPointers.values())mtKeys|=k;document.querySelectorAll('[data-mt-key]').forEach(b=>b.dataset.held=String(!!(mtKeys&Number(b.dataset.mtKey))));}
function mtClearKeys(){mtKeyboard.clear();mtPointers.clear();mtSyncKeys();}
async function loadMotoTrialState(){
 const generation=mtGeneration;mtBuildPanel();
 try{await mtDependencies();if(generation!==mtGeneration||!mtVisible())return;
 const mode=mtMode();document.getElementById('mt-practice-wrap').hidden=mode==='season'||!!window.MOTO_LOCAL;const data=await mtInvoke({action:'state',mode,courseId:mtSelected});if(generation!==mtGeneration||!mtVisible())return;
 mtBoard=data;mtSelected=data.courseId;const select=document.getElementById('mt-course');select.value=mtSelected;select.hidden=mode==='season';
 if(!motoTrialRuntime?.playing){mtMount(mtCourse(mtSelected));mtStatus('Złap równowagę. Dojedź dalej. Pobij czas.');}
 mtRenderBoards(data);mtLoadGhosts(mtSelected,mode,data);mtSet('mt-rank-title',mtTraining()?'Trening lokalny':'Ten tydzień');mtSet('mt-course-label',mtCourse(mtSelected).name+' • '+(mode==='season'?'WYŚCIG TYGODNIA':mtTraining()?'TRENING • BEZ RANKINGU':'JAZDA ARKADOWA'));
 const left=Math.max(0,new Date(data.calendar.week_end)-new Date(data.calendar.server_now));
 mtSet('mt-season-note',mode==='season'?`Nagrody: 1000 / 500 / 200 monet. Koniec tygodnia: ${new Date(data.calendar.week_end).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'})} (Warszawa).${left<180000?' Uwaga: do końca zostało mniej niż 3 minuty.':''}`:mtTraining()?'Bezpłatny trening. Wyniki pozostają w tej karcie przeglądarki; bez logowania, monet i rankingu.':'Rekordy tras są oddzielne. Kamieniołom liczy się w klasyfikacji ogólnej salonu gier.');
 }catch(e){mtStatus('Nie udało się wczytać gry: '+e.message);}
}
function mtRenderBoards(data){
 mtSet('mt-best',mtResultText(mtMode()==='season'?data.myWeekly:data.personal));
 for(const [id,rows] of [['mt-weekly',data.weekly],['mt-records',data.records]]){
 const list=document.getElementById(id);list.replaceChildren();for(const r of rows){const li=document.createElement('li'),name=document.createElement('span'),score=document.createElement('strong');name.textContent=r.rank+'. '+r.nick;score.textContent=mtResultText(r);li.append(name,score);list.append(li);}if(!rows.length){const li=document.createElement('li');li.textContent='Pierwszy ślad może być twój.';list.append(li);}
 }
}
// The ranking the player is racing in (this week, or the course records in arcade/practice)
// minus themselves; each ghost is that rival's ranked run, picked with the views' own ORDER BY.
// Every stored log was already replayed by moto-trial-action, so it reproduces exactly here.
function mtLoadGhosts(courseId,mode,board){
 if(window.MOTO_LOCAL||typeof sb==='undefined')return;
 return mtGhostTask=mtFetchGhosts(courseId,mode,board);
}
async function mtFetchGhosts(courseId,mode,board){
 const week=String(board?.calendar?.week_start||'').slice(0,10);
 try{
  let rows=mode==='season'?board.weekly:board.records;
  if(mtTraining()){const {data,error}=await sb.from('moto_trial_all_time').select('rank,user_id,nick,score').eq('course_id',courseId).order('rank').limit(4);if(error)throw error;rows=data;}
  const top=(rows||[]).filter(r=>r.user_id&&r.user_id!==me?.id&&r.score>0).slice(0,3);
  const list=await Promise.all(top.map(async(r,i)=>{
   let q=sb.from('moto_trial_scores').select('client_meta,duration_ms,completed,completion_ms').eq('user_id',r.user_id).eq('course_id',courseId).eq('version',MT_VERSION);
   if(mode==='season')q=q.eq('mode','season').eq('week_start',week);
   const {data,error}=await q.order('score',{ascending:false}).order('completion_ms',{ascending:true,nullsFirst:false}).order('submitted_at').order('id').limit(1);
   if(error||!data?.[0])return null;
   let meta=data[0].client_meta;if(typeof meta==='string')meta=JSON.parse(meta);
   if(!Array.isArray(meta?.moves))return null;
   return {name:r.rank+'. '+r.nick,color:MT_GHOST_COLORS[i],moves:meta.moves,ticks:Math.ceil(data[0].duration_ms*MT_HZ/1000),completion_ms:data[0].completed?data[0].completion_ms:null};
  }));
  mtGhostData={courseId,mode,list:list.filter(Boolean)};
 }catch(e){console.warn('Moto Trial ghosts:',e);}
}
function mtGhostsFor(course){
 if(mtGhostData?.courseId!==course.id||mtGhostData.mode!==mtMode())return [];
 return mtGhostData.list.map(g=>({...g,st:mtInit(course),prev:null,at:0,keys:0}));
}
function mtGhostStep(g,course){
 if(g.st.over||g.st.tick>=g.ticks){g.done=true;g.prev=null;g.idle=(g.idle||0)+1;return;}
 g.prev=mtSnap(g.st);
 if(g.moves[g.at]?.tick===g.st.tick)g.keys=g.moves[g.at++].keys;
 mtStep(g.st,g.keys,course);
}
function mtMount(course){if(mtView)mtView.dispose();mtView=null;mtFit();try{mtView=mtCreateView(document.getElementById('mt-stage'),course);mtView.draw(mtIdleSnapshot(course));mtSet('mt-time','0.00 s');mtSet('mt-progress','0.00%');}catch(e){mtView=null;throw e;}}
// The idle stage shows the verified replay a few seconds in, mid-ride.
function mtIdleSnapshot(course){
 const replay=MT_GOLDEN[course.id],st=mtInit(course);let at=0,keys=0;
 while(st.tick<150&&!st.over){if(replay.moves[at]?.tick===st.tick)keys=replay.moves[at++].keys;mtStep(st,keys,course);}
 return st;
}
async function mtStartRun(){
 if(mtStateBusy||!mtVisible())return;mtStateBusy=true;const gen=++mtGeneration;
 const button=document.getElementById('mt-start');button.disabled=true;
 try{
 if(motoTrialRuntime?.playing)await mtEndRun('Nowa próba.');
 if(mtPending){await mtSavePending();if(mtPending)throw new Error('Najpierw zapisz poprzedni wynik.');}
 await mtDependencies();if(!mtVisible())return;
 const requestedAt=performance.now();const data=await mtInvoke({action:'start',mode:mtMode(),courseId:mtSelected});if(gen!==mtGeneration||!mtVisible())return;
 // A Start pressed right after opening the tab must not outrun the rivals' replays.
 if(mtGhostTask)await Promise.race([mtGhostTask,new Promise(r=>setTimeout(r,2000))]);if(gen!==mtGeneration||!mtVisible())return;
 mtSelected=data.round.course_id;const course=mtCourse(mtSelected);mtMount(course);mtLockView();
 motoTrialRuntime={playing:true,course,st:mtInit(course),moves:[],lastKeys:-1,round:data.round,acc:0,last:performance.now(),raf:0,deadline:requestedAt+Math.max(0,new Date(data.round.expires_at)-new Date(data.calendar.server_now))-1000,ghosts:mtGhostsFor(course)};
 const ghosts=motoTrialRuntime.ghosts;
 mtView?.draw(motoTrialRuntime.st,null,1,0,mtGhostsOn?ghosts:null);mtStatus(ghosts.length?'Ścigasz się z duchami: '+ghosts.map(g=>g.name).join(', ')+'.':'Gaz i równowaga. Powodzenia!');if(!mtMuted)mtAudioStart();mtLoop(performance.now());
 }catch(e){mtStatus(e.message);}finally{mtStateBusy=false;button.disabled=false;}
}
function mtLoop(now){
 const r=motoTrialRuntime;if(!r?.playing)return;if(!mtVisible()){stopMotoTrialRound();return;}
 const delta=now-r.last;r.last=now;if(delta>1000){mtEndRun('Próba przerwana — długa przerwa w animacji.');return;}
 r.acc+=delta;while(r.acc>=1000/MT_HZ&&!r.st.over){r.acc-=1000/MT_HZ;for(const g of r.ghosts)mtGhostStep(g,r.course);if(r.lastKeys!==mtKeys){r.moves.push({tick:r.st.tick,keys:mtKeys});r.lastKeys=mtKeys;}r.prev=mtSnap(r.st);mtStep(r.st,mtKeys,r.course);}
 mtSet('mt-course-label',r.course.name+' • '+(mtTraining()?'TRENING BEZ RANKINGU':'PRÓBA RANKINGOWA'));
 mtView?.draw(r.st,r.st.over?null:r.prev,r.st.over?1:r.acc*MT_HZ/1000,delta,mtGhostsOn?r.ghosts:null);mtSet('mt-time',mtTime(r.st.tick*1000/MT_HZ));mtSet('mt-progress',mtResultText(r.st));mtAudioUpdate(r.st);
 if(r.st.over||now>=r.deadline){mtEndRun(r.st.over?r.st.reason:'Koniec tygodnia / czasu rundy.');return;}
 r.raf=requestAnimationFrame(mtLoop);
}
async function mtEndRun(reason){const r=motoTrialRuntime;if(!r?.playing)return;r.playing=false;cancelAnimationFrame(r.raf);mtAudioStop();mtStatus(reason);if(!mtMuted&&/Uderzenie|Upadek/.test(reason))mtImpactSound();if(r.st.tick){mtPending={action:'submit',roundId:r.round.id,elapsedTicks:r.st.tick,moves:r.moves};await mtSavePending();}}
async function mtSavePending(){
 if(mtSaveTask)return mtSaveTask;
 if(!mtPending)return;
 const pending=mtPending,generation=mtGeneration,courseId=mtSelected;
 const current=()=>mtVisible()&&generation===mtGeneration&&courseId===mtSelected;
 mtSaveTask=(async()=>{try{
  const data=await mtInvoke(pending);
  if(mtPending!==pending)return;
  mtPending=null;agPickerScoresAt=0;
  if(!current())return;
  mtStatus(data.result.reason+' · '+mtResultText(data.result)+(pending.roundId.startsWith('local-')?' · trening lokalny':' · zapisano'));
  document.getElementById('mt-save').hidden=true;document.getElementById('mt-discard').hidden=true;
  const board=await mtInvoke({action:'state',mode:mtMode(),courseId});
  if(current()){mtBoard=board;mtRenderBoards(board);mtLoadGhosts(courseId,mtMode(),board);}
 }catch(e){if(current()&&mtPending===pending){mtStatus('Wynik nie został zapisany: '+e.message);document.getElementById('mt-save').hidden=false;document.getElementById('mt-discard').hidden=false;}}
 })();
 try{await mtSaveTask;}finally{mtSaveTask=null;}
}
function stopMotoTrialRound(){mtGeneration++;if(motoTrialRuntime?.playing)mtEndRun('Próba przerwana.');mtAudioStop();mtAudio?.ctx.suspend();mtClearKeys();if(mtView){mtView.dispose();mtView=null;}}
function mtAudioStart(){if(mtMuted)return;try{if(!mtAudio){const ctx=new (window.AudioContext||window.webkitAudioContext)(),osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='sawtooth';gain.gain.value=0;osc.connect(gain).connect(ctx.destination);osc.start();mtAudio={ctx,osc,gain};}mtAudio.ctx.resume();}catch{}}
function mtAudioStop(){if(mtAudio)mtAudio.gain.gain.setTargetAtTime(0,mtAudio.ctx.currentTime,.05);}
function mtAudioUpdate(st){if(!mtAudio||mtMuted)return;const t=mtAudio.ctx.currentTime;mtAudio.osc.frequency.setTargetAtTime(38+Math.abs(st.wr.w)*2.4,t,.05);mtAudio.gain.gain.setTargetAtTime(st.over?0:.018,t,.03);}

// Canvas 2D renderer in the Gravity Defied style: white field, a green 2.5D
// track (near edge, far edge, ties at every vertex), a vector bike and rider.
// Render-only: the camera, interpolation and effects never feed the simulation.
function mtSnap(st){return {...st,b:{...st.b},wr:{...st.wr},wf:{...st.wf}};}
function mtCreateView(host,course){
 const canvas=document.createElement('canvas');canvas.style.cssText='display:block;width:100%;height:100%';host.prepend(canvas);
 const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas jest niedostępny w tej przeglądarce.');
 const DEPTH=[0.55,0.42];
 let W=640,H=360,dpr=1,ppm=40,cam=null,last=null,disposed=false;
 function resize(){if(disposed)return;dpr=Math.min(2,window.devicePixelRatio||1);W=Math.max(160,host.clientWidth||640);H=Math.max(120,host.clientHeight||360);canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);ppm=Math.min(H/7,W/(W<600?8.5:11.5));if(last)draw(last.st,last.prev,last.t,0,last.ghosts);}
 const mix=(a,b,t)=>a+(b-a)*t;
 function pose(st,prev,t){
  const p=prev||st,c=mix(p.b.c,st.b.c,t),s=mix(p.b.s,st.b.s,t),l=Math.sqrt(c*c+s*s)||1;
  const spin=(a,b)=>{let d=b-a;if(d>Math.PI)d-=2*Math.PI;else if(d<-Math.PI)d+=2*Math.PI;return a+d*t;};
  return {x:mix(p.b.x,st.b.x,t),y:mix(p.b.y,st.b.y,t),c:c/l,s:s/l,vx:st.b.vx,lean:mix(p.lean,st.lean,t),
   r:{x:mix(p.wr.x,st.wr.x,t),y:mix(p.wr.y,st.wr.y,t),a:spin(p.wr.a,st.wr.a)},f:{x:mix(p.wf.x,st.wf.x,t),y:mix(p.wf.y,st.wf.y,t),a:spin(p.wf.a,st.wf.a)}};
 }
 function line(pts,color,width){ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i][0],pts[i][1]);ctx.strokeStyle=color;ctx.lineWidth=width/ppm;ctx.stroke();}
 function drawTrack(x0,x1){
  ctx.lineCap='round';ctx.lineJoin='round';
  for(const piece of course.pieces){
   if(piece[piece.length-1][0]<x0||piece[0][0]>x1)continue;
   const pts=piece.filter((q,i)=>(q[0]>=x0&&q[0]<=x1)||(piece[i+1]&&piece[i+1][0]>=x0&&q[0]<=x1)||(piece[i-1]&&piece[i-1][0]<=x1&&q[0]>=x0));
   if(pts.length<2)continue;
   const far=pts.map(q=>[q[0]+DEPTH[0],q[1]+DEPTH[1]]);
   ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);for(const q of pts)ctx.lineTo(q[0],q[1]);for(let i=far.length-1;i>=0;i--)ctx.lineTo(far[i][0],far[i][1]);ctx.closePath();ctx.fillStyle='rgba(46,154,58,.07)';ctx.fill();
   ctx.beginPath();for(let i=0;i<pts.length;i++){ctx.moveTo(pts[i][0],pts[i][1]);ctx.lineTo(far[i][0],far[i][1]);}ctx.strokeStyle='#9fd39f';ctx.lineWidth=1/ppm;ctx.stroke();
   line(far,'#6dbd6d',1.4);line(pts,'#1f8f2e',2.6);
  }
 }
 function flag(x,label){
  const y=courseY(x);if(y==null)return;
  line([[x,y],[x,y+1.9]],'#222',2.2);
  const w=0.62,h=0.42,n=4,m=3;for(let i=0;i<n;i++)for(let j=0;j<m;j++){ctx.fillStyle=(i+j)%2?'#fff':'#111';ctx.fillRect(x+i*w/n,y+1.9-h+j*h/m,w/n,h/m);}
  ctx.strokeStyle='#111';ctx.lineWidth=1/ppm;ctx.strokeRect(x,y+1.9-h,w,h);
  if(label){ctx.save();ctx.translate(x+0.05,y+2.05);ctx.scale(1/ppm,-1/ppm);ctx.fillStyle='#222';ctx.font='700 11px system-ui,sans-serif';ctx.fillText(label,0,0);ctx.restore();}
 }
 function courseY(x){let y=null;for(const s of course.segs)if(x>=s[0]&&x<=s[2]&&s[2]>s[0]){const v=s[1]+(s[3]-s[1])*(x-s[0])/(s[2]-s[0]);if(y==null||v>y)y=v;}return y;}
 // tint: draw the whole bike and rider in one colour (a ghost's silhouette).
 function drawBike(p,tint=null){
  const L=(lx,ly)=>[p.x+p.c*lx-p.s*ly,p.y+p.s*lx+p.c*ly],R=MT_P.wheelR,lean=p.lean,C=c=>tint||c;
  ctx.lineCap='round';ctx.lineJoin='round';
  // Suspension first so the wheels and frame sit on top.
  line([L(-0.06,-0.26),[p.r.x,p.r.y]],C('#3b3f42'),5);
  line([L(0.44,0.14),[p.f.x,p.f.y]],C('#8a9094'),4.5);line([L(0.47,0.16),L(0.52,0.0)],C('#3b3f42'),6);
  for(const w of [p.r,p.f]){
   ctx.beginPath();ctx.arc(w.x,w.y,R-0.035,0,Math.PI*2);ctx.strokeStyle=C('#121416');ctx.lineWidth=0.07;ctx.stroke();
   ctx.beginPath();ctx.arc(w.x,w.y,R*0.62,0,Math.PI*2);ctx.strokeStyle=C('#7d8489');ctx.lineWidth=1.2/ppm;ctx.stroke();
   ctx.beginPath();for(let i=0;i<6;i++){const a=w.a+i*Math.PI/3;ctx.moveTo(w.x,w.y);ctx.lineTo(w.x+Math.cos(a)*R*0.62,w.y+Math.sin(a)*R*0.62);}ctx.lineWidth=1/ppm;ctx.stroke();
   ctx.beginPath();ctx.arc(w.x,w.y,0.045,0,Math.PI*2);ctx.fillStyle=C('#2b2f31');ctx.fill();
  }
  // Frame, engine, tank, seat, exhaust.
  ctx.beginPath();for(const [i,q] of [L(-0.16,-0.4),L(0.22,-0.4),L(0.26,-0.14),L(-0.14,-0.12)].entries())i?ctx.lineTo(...q):ctx.moveTo(...q);ctx.closePath();ctx.fillStyle=C('#4a4f53');ctx.fill();
  line([L(-0.06,-0.26),L(0.44,0.14),L(0.2,-0.3)],C('#2a2d30'),3);line([L(-0.62,0.02),L(-0.06,-0.26)],C('#2a2d30'),2.5);
  line([L(-0.2,-0.32),L(-0.5,-0.2),L(-0.78,-0.16)],C('#9aa0a4'),3);
  ctx.beginPath();for(const [i,q] of [L(-0.08,0.04),L(0.12,0.17),L(0.4,0.15),L(0.34,0.0),L(-0.04,-0.03)].entries())i?ctx.lineTo(...q):ctx.moveTo(...q);ctx.closePath();ctx.fillStyle=C('#d8322b');ctx.fill();
  line([L(-0.66,0.06),L(-0.08,0.06)],C('#151719'),5);
  line([L(-0.7,0.08),L(-0.86,0.18)],C('#d8322b'),3);
  line([L(0.4,0.3),L(0.5,0.34)],C('#151719'),3);
  // Rider: the helmet sits exactly where the crash test checks it.
  const hip=L(-0.2-0.1*lean,0.14),head=mtLocal({x:p.x,y:p.y,c:p.c,s:p.s},MT_P.head[0]-MT_P.leanShift*lean,MT_P.head[1]-0.05*Math.abs(lean));
  const neck=L(0.06-0.26*lean,0.66-0.05*Math.abs(lean)),hand=L(0.42,0.32),elbow=L(0.24-0.12*lean,0.38),knee=L(0.2,0.02),foot=L(0.02,-0.2);
  line([hip,knee,foot],C('#1f2b44'),7);line([foot,L(0.12,-0.2)],C('#111'),4);
  line([hip,neck],C('#1d5fd1'),10);line([neck,elbow,hand],C('#1d5fd1'),5.5);
  ctx.beginPath();ctx.arc(head[0],head[1],MT_P.headR,0,Math.PI*2);ctx.fillStyle=C('#f2c230');ctx.fill();ctx.strokeStyle=C('#1b1d1f');ctx.lineWidth=1.4/ppm;ctx.stroke();
  const fx=p.c,fy=p.s;ctx.beginPath();ctx.arc(head[0]+fx*0.05,head[1]+fy*0.05,MT_P.headR*0.62,Math.atan2(fy,fx)-0.9,Math.atan2(fy,fx)+0.5);ctx.strokeStyle=C('#22303a');ctx.lineWidth=0.06;ctx.stroke();
  return head;
 }
 // A crashed ghost lingers for 1.5 s where it fell, then leaves; a finished one stays at the line.
 function ghostShown(g){return !g.done||g.st.completed||(g.idle||0)<90;}
 // Ghosts are solid pale silhouettes (the rank colour mixed into the white field),
 // drawn before the track so they sit behind it. No offscreen layer: compositing a
 // full-canvas layer every frame nearly doubled the frame cost at Retina fullscreen.
 const pale={};
 function paleOf(hex){return pale[hex]||(pale[hex]='#'+[1,3,5].map(i=>Math.round(255-(255-parseInt(hex.slice(i,i+2),16))*0.42).toString(16).padStart(2,'0')).join(''));}
 function drawGhosts(ghosts,t,x0,x1){
  const heads=ghosts.filter(ghostShown).map(g=>{const p=pose(g.st,g.prev,t);return {g,p,head:mtLocal(p,MT_P.head[0]-MT_P.leanShift*p.lean,MT_P.head[1]-0.05*Math.abs(p.lean))};});
  for(const h of heads)if(h.p.x>x0-1.4&&h.p.x<x1+1.4)drawBike(h.p,paleOf(h.g.color));
  return heads;
 }
 // Name tags in screen space, nudged apart when ghosts ride together; a ghost
 // outside the view gets a tag pinned to that edge with its distance.
 // A tag is rendered once into a small canvas and reused while its text stays the same:
 // measuring and filling text every frame was most of what the ghosts still cost.
 const tagCache=new Map();
 function tagImage(text,color){
  const key=text+'|'+color+'|'+dpr;let tag=tagCache.get(key);if(tag)return tag;
  if(tagCache.size>48)tagCache.clear();
  const font='700 11px system-ui,sans-serif';ctx.font=font;
  const w=Math.ceil(ctx.measureText(text).width)+14,h=18,c=document.createElement('canvas'),x=c.getContext('2d');
  c.width=Math.ceil(w*dpr);c.height=Math.ceil(h*dpr);x.scale(dpr,dpr);
  x.beginPath();x.roundRect?x.roundRect(0.75,0.75,w-1.5,h-1.5,8.5):x.rect(0.75,0.75,w-1.5,h-1.5);x.fillStyle='#fff';x.fill();x.strokeStyle=color;x.lineWidth=1.5;x.stroke();
  x.font=font;x.textBaseline='middle';x.textAlign='center';x.fillStyle=color;x.fillText(text,w/2,h/2+0.5);
  tagCache.set(key,tag={c,w,h});return tag;
 }
 function ghostTags(heads,px){
  const placed=[];
  for(const {g,p,head} of heads){
   let sx=W*0.4+(head[0]-cam.x)*ppm,sy=H*0.6-(head[1]+MT_P.headR+0.32-cam.y)*ppm;
   const dist=Math.round(p.x-px),off=sx<8?-1:sx>W-8?1:0;
   const text=(off<0?'◀ ':'')+(g.done?(g.st.completed?'🏁 ':'💥 '):'')+g.name+(g.st.completed?' · '+(g.completion_ms/1000).toFixed(2)+' s':'')+(off?' · '+(dist>0?'+':'')+dist+' m':'')+(off>0?' ▶':'');
   const tag=tagImage(text,g.color),w=tag.w,h=tag.h;
   sx=Math.max(4+w/2,Math.min(W-4-w/2,sx));sy=Math.max(14,Math.min(H-12,sy));
   for(let k=0;k<6&&placed.some(r=>Math.abs(r.x-sx)<(r.w+w)/2&&Math.abs(r.y-sy)<h);k++)sy-=h+2;
   placed.push({x:sx,y:sy,w});
   ctx.globalAlpha=g.done&&!g.st.completed?0.6:0.92;
   ctx.drawImage(tag.c,Math.round(sx-w/2),Math.round(sy-h/2),w,h);
  }
  ctx.globalAlpha=1;
 }
 function banner(text,color){ctx.font='800 '+Math.round(Math.min(44,W/12))+'px system-ui,sans-serif';ctx.textAlign='center';ctx.lineWidth=5;ctx.strokeStyle='#fff';ctx.strokeText(text,W/2,H*0.22);ctx.fillStyle=color;ctx.fillText(text,W/2,H*0.22);ctx.textAlign='start';}
 function draw(st,prev=null,t=1,dt=0,ghosts=null){
  if(disposed)return;last={st,prev,t,ghosts};
  const p=pose(st,prev,t),look=Math.max(-1.5,Math.min(2.6,p.vx*0.24)),tx=p.x+look,ty=p.y+0.35;
  if(!cam||!dt)cam={x:tx,y:ty};else{const kx=1-Math.exp(-dt/140),ky=1-Math.exp(-dt/220);cam.x+=(tx-cam.x)*kx;cam.y+=(ty-cam.y)*ky;}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
  const ox=W*0.4,oy=H*0.6;
  const world=[dpr*ppm,0,0,-dpr*ppm,dpr*(ox-cam.x*ppm),dpr*(oy+cam.y*ppm)];
  ctx.setTransform(...world);
  const x0=cam.x-ox/ppm-1,x1=cam.x+(W-ox)/ppm+1;
  const heads=ghosts?.length?drawGhosts(ghosts,t,x0,x1):[];
  drawTrack(x0,x1);
  if(course.start-1>x0-2&&course.start-1<x1+2)flag(course.start-1,'START');
  if(course.finish>x0-2&&course.finish<x1+2)flag(course.finish,'META');
  drawBike(p);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  if(heads.length)ghostTags(heads,p.x);
  // Progress strip along the top edge, with a notch for each ghost.
  ctx.fillStyle='#e9efe6';ctx.fillRect(0,0,W,4);ctx.fillStyle='#1f8f2e';ctx.fillRect(0,0,W*Math.min(1,st.score/10000),4);
  for(const g of ghosts||[]){ctx.fillStyle=g.color;ctx.fillRect(Math.min(W-3,W*g.st.score/10000)-1,0,3,7);}
  if(st.over)banner(st.completed?'META! '+(st.completion_ms/1000).toFixed(2)+' s':st.reason||'Koniec',st.completed?'#1f8f2e':'#c62d24');
 }
 resize();
 // project(): world metres → CSS pixels on the stage, for tests and overlays.
 return {draw,resize,project:(x,y)=>[W*0.4+(x-cam.x)*ppm,H*0.6-(y-cam.y)*ppm],dispose(){disposed=true;canvas.remove();}};
}

// Explicit practice adapter, never used by ranked/seasonal requests.
function mtLocalAction(body){
 const now=new Date(),calendar={server_now:now.toISOString(),week_end:new Date(+now+210000).toISOString(),game:'moto_trial',course_id:mtSelected};
 if(body.action==='state')return {calendar,courseId:mtSelected,weekly:[],records:mtLocalBest[mtSelected]?[mtLocalBest[mtSelected]]:[],personal:mtLocalBest[mtSelected]||null,myWeekly:null};
 if(body.action==='start'){mtLocalRound={id:'local-'+crypto.randomUUID(),course_id:mtSelected,version:MT_VERSION,mode:'arcade',started_at:now.toISOString(),expires_at:calendar.week_end};return {round:mtLocalRound,calendar};}
 if(body.action==='submit'){
  if(!mtLocalRound||body.roundId!==mtLocalRound.id)throw new Error('Trening został zakończony.');
  const st=mtReplay(mtLocalRound.course_id,body.moves,body.elapsedTicks),result={...st,course_id:mtLocalRound.course_id,reason:st.over?st.reason:'Próba przerwana'};
  const best=mtLocalBest[result.course_id];if(!best||mtArcadeScore(result)>mtArcadeScore(best))mtLocalBest[result.course_id]={...result,nick:'Ty · trening',rank:1};
  return {result};
 }
 throw new Error('Nieznana akcja treningu.');
}

function mtImpactSound(){if(!mtAudio)return;const {ctx}=mtAudio,o=ctx.createOscillator(),g=ctx.createGain();o.type='triangle';o.frequency.setValueAtTime(110,ctx.currentTime);o.frequency.exponentialRampToValueAtTime(30,ctx.currentTime+.14);g.gain.setValueAtTime(.1,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.15);o.connect(g).connect(ctx.destination);o.start();o.stop(ctx.currentTime+.16);o.onended=()=>{o.disconnect();g.disconnect();};}
