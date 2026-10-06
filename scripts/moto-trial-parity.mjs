// Moto Trial G6: browser/server simulation parity and physics invariants.
// Extracts the fenced block from both files (no third copy) and runs both.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const core=fs.readFileSync('games/moto-trial-core.js','utf8');const edge=fs.readFileSync('supabase/functions/moto-trial-action/index.ts','utf8');
const block=s=>s.match(/\/\/ MOTO PARITY BEGIN[\s\S]*?\/\/ MOTO PARITY END/)[0];
assert.equal(block(core),block(edge),'browser/server source parity');
// No transcendental Math in the simulation: those may round differently per engine.
assert(!/Math\.(sin|cos|tan|atan|atan2|hypot|pow|exp|log|cbrt|random)\b/.test(block(core)),'parity block may only use exactly-rounded Math');
const a=vm.createContext({}),b=vm.createContext({});vm.runInContext(core,a);vm.runInContext(block(edge),b);vm.runInContext(fs.readFileSync('games/moto-trial-golden.js','utf8'),a);
const run=(ctx,code)=>JSON.parse(JSON.stringify(vm.runInContext(code,ctx)));
const golden=run(a,'MT_GOLDEN');
assert.deepEqual(Object.keys(golden),run(a,'MT_COURSE_IDS'));
for(const [id,g] of Object.entries(golden)){
 const expr=`mtReplay('${id}',${JSON.stringify(g.moves)},${g.ticks})`,client=run(a,expr),server=run(b,expr);
 assert.deepEqual(client,server);assert(client.completed,id+' golden must finish');assert.equal(client.completion_ms,g.completion_ms);
 assert(g.completion_ms>=15000&&g.completion_ms<=90000,id+' golden time out of band');
 console.log(`${id}: verified ${g.completion_ms/1000}s completion (${g.moves.length} input changes)`);
 assert.throws(()=>run(a,`mtReplay('${id}',${JSON.stringify(g.moves)},${g.ticks+1})`),'no input after the finish');
}
// Randomised drivers: both copies must agree on every bit of the final state.
for(let seed=1;seed<=80;seed++){
 const id=seed%2?'quarry_v3':'mountain_v3';
 const generated=run(a,`(()=>{const c=mtCourse('${id}'),s=mtInit(c),moves=[];let n=${seed},old=-1;while(!s.over&&s.tick<1800){n=(Math.imul(n,1664525)+1013904223)>>>0;const k=s.tick%15===0?((n>>>25)&15)|((n>>>20)&1):old;if(k!==old){moves.push({tick:s.tick,keys:k});old=k;}mtStep(s,k,c);}return {s,moves};})()`);
 const replay=run(b,`mtReplay('${id}',${JSON.stringify(generated.moves)},${generated.s.tick})`);
 assert.deepEqual(replay,generated.s,`seed ${seed}`);
}
for(const expr of ["mtReplay('bad',[],1)","mtReplay('quarry_v3',[],0)","mtReplay('quarry_v3',[],10801)","mtReplay('quarry_v3',[{tick:0,keys:16}],1)","mtReplay('quarry_v3',[{tick:0,keys:1},{tick:0,keys:2}],2)","mtReplay('quarry_v3',[{tick:1,keys:1}],1)","mtReplay('quarry_v3',[{tick:0.5,keys:1}],2)","mtReplay('quarry_v3',[{tick:-1,keys:1}],2)","mtReplay('quarry_v2',[],1)"])assert.throws(()=>vm.runInContext(expr,a),expr);
const sim=(id,body)=>run(a,`(()=>{const c=mtCourse('${id}'),s=mtInit(c);${body};return s;})()`);
// Standing still: the bike settles on its suspension and never times out early or drifts.
const idle=sim('quarry_v3','for(let i=0;i<600;i++)mtStep(s,0,c)');assert(!idle.over&&Math.abs(idle.b.x-2)<0.05&&Math.abs(idle.b.s)<0.01,'bike must rest level');
// Skill is required: throttle alone crashes on both courses, and a held wheelie loops out.
for(const id of Object.keys(golden)){const s=sim(id,'while(!s.over)mtStep(s,1,c)');assert(!s.completed&&s.score<9000,id+': throttle-only must not finish');}
assert.equal(sim('quarry_v3','while(!s.over)mtStep(s,5,c)').reason,'Uderzenie kaskiem','held throttle + lean back must loop out');
// Throttle accelerates, brake stops.
const fast=sim('quarry_v3','for(let i=0;i<120;i++)mtStep(s,1,c)');assert(fast.b.vx>7,'throttle must accelerate');
const stop=sim('quarry_v3','for(let i=0;i<120;i++)mtStep(s,1,c);for(let i=0;i<90;i++)mtStep(s,2,c)');assert(Math.abs(stop.b.vx)<1,'brake must stop the bike');
// Falling out of the world ends the run.
const fall=sim('quarry_v3','for(const o of [s.b,s.wr,s.wf])o.y-=40;mtStep(s,0,c)');assert(fall.over&&fall.reason==='Upadek w przepaść');
assert.equal(sim('quarry_v3','while(!s.over)mtStep(s,0,c)').reason,'Koniec czasu');
// Course geometry: segments run left to right (vertical steps allowed), pieces are separated by real gaps.
for(const id of Object.keys(golden)){
 const c=run(a,`mtCourse('${id}')`);for(const s of c.segs)assert(s[2]>=s[0]);
 for(let i=1;i<c.pieces.length;i++)assert(c.pieces[i][0][0]-c.pieces[i-1].at(-1)[0]>=4,'gaps must be real');
 assert(c.finish>250,'course length');
}
console.log('PASS: source parity, exact-math rule, 80 randomized replays, golden completions, invalid inputs, rest, throttle-only and wheelie crashes, braking, fall, time cap and course geometry.');
