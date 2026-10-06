// Start python3 -m http.server 8765 --bind 127.0.0.1 first.
// Optional env: PLAYWRIGHT_MODULE, CHROME_PATH, MOTO_BASE_URL.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const base=process.env.MOTO_BASE_URL||'http://127.0.0.1:8765';
try{
 const context=await browser.newContext({viewport:{width:1280,height:1000},hasTouch:true});const page=await context.newPage();const errors=[];let requests=0;
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/*.supabase.co/**',route=>{requests++;return route.abort();});
 await page.goto(base+'/games/moto-trial-local.html');await page.waitForFunction(()=>document.querySelector('#mt-status')?.textContent.includes('Złap'));
 const intro=await page.evaluate(()=>{const s=mtIdleSnapshot(mtCourse('quarry_v3')),r=document.querySelector('#mt-stage').getBoundingClientRect();return {tick:s.tick,over:s.over,ratio:r.width/r.height};});assert(intro.tick>0&&intro.over===false,'idle stage shows the verified replay mid-ride');assert(Math.abs(intro.ratio-16/9)<.01,'desktop stage is 16:9');
 // Read the canvas at the simulated wheel and helmet positions along both golden
 // replays: the drawing must sit exactly where the physics is.
 const rendering=await page.evaluate(()=>{
  let checked=0;const failures=[];
  function check(st){mtView.draw(st);const canvas=document.querySelector('#mt-stage canvas'),ctx=canvas.getContext('2d'),k=canvas.width/canvas.clientWidth;
   for(const [x,y,r] of [[st.wr.x,st.wr.y,MT_P.wheelR-0.035],[st.wf.x,st.wf.y,MT_P.wheelR-0.035],[...mtHead(st),0]]){
    const [sx,sy]=mtView.project(x,y),rad=r*(mtView.project(1,0)[0]-mtView.project(0,0)[0]);
    let hit=false;for(let i=0;i<8&&!hit;i++){const a=i*Math.PI/4,d=ctx.getImageData(Math.round((sx+Math.cos(a)*rad)*k)-2,Math.round((sy+Math.sin(a)*rad)*k)-2,5,5).data;for(let q=0;q<d.length;q+=4)if(d[q]+d[q+1]+d[q+2]<600)hit=true;}
    if(!hit)failures.push({tick:st.tick,x,y});
   }checked++;}
  try{for(const id of MT_COURSE_IDS){const course=mtCourse(id),gold=MT_GOLDEN[id];mtMount(course);const st=mtInit(course);let at=0,keys=0;
   while(!st.over){if(gold.moves[at]?.tick===st.tick)keys=gold.moves[at++].keys;mtStep(st,keys,course);if(st.tick%90===0)check(st);}check(st);}}
  finally{mtMount(mtCourse(mtSelected));}
  return {checked,failures};
 });
 assert(rendering.checked>30);assert.deepEqual(rendering.failures,[],'wheels and helmet are drawn where the simulation has them');
 await page.click('#mt-start');await page.waitForFunction(()=>motoTrialRuntime?.playing);assert(await page.evaluate(()=>motoTrialRuntime.st.tick<5&&Math.abs(motoTrialRuntime.st.b.x-mtCourse('quarry_v3').start)<0.01),'Start always resets to the real course start');await page.keyboard.down('w');await page.waitForTimeout(400);await page.keyboard.up('w');assert((await page.evaluate(()=>motoTrialRuntime.st.b.x))>2.2);
 await page.keyboard.down('a');assert.equal(await page.evaluate(()=>mtKeys),4);await page.keyboard.up('a');assert.equal(await page.evaluate(()=>mtKeys),0);
 await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.waitForFunction(()=>!motoTrialRuntime.playing);assert.equal(await page.evaluate(()=>mtKeys),0);
 await page.click('#mt-start');await page.evaluate(async()=>{const r=motoTrialRuntime,g=MT_GOLDEN.quarry_v3;cancelAnimationFrame(r.raf);r.st=mtReplay('quarry_v3',g.moves,g.ticks);r.moves=g.moves;await mtEndRun('Meta!');});
 const goldTime=await page.evaluate(()=>mtTime(MT_GOLDEN.quarry_v3.completion_ms));assert((await page.locator('#mt-status').textContent()).includes(goldTime));assert((await page.locator('#mt-records').textContent()).includes(goldTime));
 await page.selectOption('#mt-course','mountain_v3');await page.waitForFunction(()=>document.querySelector('#mt-course-label')?.textContent.includes('Górska'));assert.equal(await page.locator('#mt-best').textContent(),'—');
 await page.keyboard.press('r');await page.waitForFunction(()=>motoTrialRuntime?.playing&&motoTrialRuntime.course.id==='mountain_v3');
 await page.click('#mt-full');await page.waitForFunction(()=>!!document.fullscreenElement);const fullStage=await page.locator('#mt-stage').boundingBox();assert(fullStage.height>300);await page.screenshot({path:'/tmp/moto-fullscreen.png'});await page.evaluate(()=>document.exitFullscreen());
 await page.setViewportSize({width:390,height:844});const phoneStage=await page.locator('#mt-stage').boundingBox();assert(Math.abs(phoneStage.width/phoneStage.height-4/3)<.02,'phone stage uses a taller responsive frame');await page.click('#mt-start');
 const left=await page.locator('[data-mt-key="4"]').boundingBox(),right=await page.locator('[data-mt-key="1"]').boundingBox();const cdp=await context.newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:left.x+left.width/2,y:left.y+left.height/2,id:1},{x:right.x+right.width/2,y:right.y+right.height/2,id:2}]});assert.equal(await page.evaluate(()=>mtKeys),5,'simultaneous throttle and lean');
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.equal(await page.evaluate(()=>mtKeys),0);
 // A failed network write must stay retryable; double retry shares one request.
 const recovery=await page.evaluate(async()=>{
  const invoke=mtInvoke;let calls=0;
  mtInvoke=async body=>{if(body.action==='submit'){calls++;await new Promise(resolve=>setTimeout(resolve,20));if(calls===1)throw new Error('Test offline');}return invoke(body);};
  try{
   const r=motoTrialRuntime;cancelAnimationFrame(r.raf);r.st=mtInit(r.course);r.moves=[{tick:0,keys:1}];for(let i=0;i<30;i++)mtStep(r.st,1,r.course);
   await mtEndRun('Test zapisu');const retained=!!mtPending&&!document.getElementById('mt-save').hidden;
   await Promise.all([mtSavePending(),mtSavePending()]);return {calls,retained,pending:!!mtPending,hidden:document.getElementById('mt-save').hidden};
  }finally{mtInvoke=invoke;}
 });assert.deepEqual(recovery,{calls:2,retained:true,pending:false,hidden:true});
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;});
 for(let i=0;i<3;i++){await page.evaluate(()=>stopMotoTrialRound());await page.evaluate(()=>loadMotoTrialState());assert.equal(await page.locator('#mt-stage canvas').count(),1);}
 await page.screenshot({path:'/tmp/moto-phone.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.evaluate(()=>stopMotoTrialRound());assert.equal(await page.locator('#mt-stage canvas').count(),0);assert.equal(requests,0,'practice never contacts Supabase');assert.deepEqual(errors,[]);
 // Smoke-test the actual application's lazy loading, card and teardown hooks.
 const app=await context.newPage();const appErrors=[];let rankedCalls=0;app.on('pageerror',e=>appErrors.push(e.message));
 await app.route('**/*.supabase.co/**',route=>{if(route.request().url().includes('moto-trial-action'))rankedCalls++;return route.fulfill({status:200,contentType:'application/json',body:'[]'});});
 await app.goto(base+'/index.html');await app.waitForFunction(()=>typeof selectAllGame==='function');
 await app.evaluate(()=>{me={id:'00000000-0000-0000-0000-000000000001',nick:'Local test',coins:0};activeTab='all-games';for(let p=document.getElementById('tab-all-games');p;p=p.parentElement){p.classList.remove('hidden');p.style.display='block';}selectAllGame('moto_trial');});
 await app.waitForFunction(()=>document.querySelector('#mt-status')?.textContent.includes('Złap'));
 assert(await app.locator('#mt-practice').isChecked());assert.equal(await app.locator('.ag-card[data-game="moto_trial"]').count(),1);
 await app.evaluate(()=>mtStartRun());assert(await app.evaluate(()=>motoTrialRuntime.playing));await app.evaluate(()=>stopAllArcadeRounds());assert.equal(await app.evaluate(()=>motoTrialRuntime.playing),false);
 assert.equal(await app.evaluate(()=>lbScoreCell({gameType:'moto_trial',score:10000,completion_ms:24633}).tagName),'TD');assert.equal(rankedCalls,0);assert.deepEqual(appErrors,[]);
 console.log('PASS: canvas wheel/helmet alignment across both courses, fullscreen, save failure/double retry, repeated navigation, actual app picker/free practice, local completion and course records, keyboard release, simultaneous touch, blur, mobile overflow, teardown, no backend writes and no browser errors.');
}finally{await browser.close();}
