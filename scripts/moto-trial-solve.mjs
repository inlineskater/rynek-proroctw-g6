// Finds a completing input log for each course by beam search over short
// control chunks, and writes it to games/moto-trial-golden.js (attract preview
// + tests). Development command only: tests never rewrite the fixture.
// Usage: node scripts/moto-trial-solve.mjs [courseId] [--dry]
import fs from 'node:fs';import vm from 'node:vm';
const ctx=vm.createContext({});
vm.runInContext(fs.readFileSync('games/moto-trial-core.js','utf8')+';globalThis.MT={mtCourse,mtInit,mtStep,MT_COURSE_IDS};',ctx);
const {mtCourse,mtInit,mtStep,MT_COURSE_IDS}=ctx.MT;
const CHUNK=8, BEAM=48, ACTIONS=[1,5,9,0,4,8,2];
const clone=s=>({...s,b:{...s.b},wr:{...s.wr},wf:{...s.wf}});
// Prefer progress, then speed, then a level chassis with both wheels down.
const value=s=>s.b.x*10+Math.min(s.b.vx,9)*2-Math.abs(s.b.s)*4-Math.abs(s.b.w)*0.5;
function solve(id){
  const course=mtCourse(id);
  let beam=[{s:mtInit(course),log:null,keys:-1}];
  for(let step=0;step<10800/CHUNK;step++){
    const next=[];
    for(const node of beam)for(const k of ACTIONS){
      const s=clone(node.s);for(let i=0;i<CHUNK&&!s.over;i++)mtStep(s,k,course);
      if(s.over&&!s.completed)continue;
      const n={s,keys:k,log:{tick:node.s.tick,keys:k,prev:node.log}};
      if(s.completed)return finish(n);
      next.push(n);
    }
    if(process.env.MT_TRACE&&step%40===0)console.log(step,next.length?Math.max(...next.map(n=>n.s.b.x)).toFixed(1):"-");
    if(!next.length)throw new Error(id+': beam died at step '+step);
    // Keep diversity: one node per (x, pitch, speed) cell, best value first.
    next.sort((a,b)=>value(b.s)-value(a.s));
    const seen=new Set();beam=[];
    for(const n of next){const key=Math.round(n.s.b.x*2)+':'+Math.round(n.s.b.s*6)+':'+Math.round(n.s.b.vx);if(seen.has(key))continue;seen.add(key);beam.push(n);if(beam.length>=BEAM)break;}
  }
  throw new Error(id+': no finish in time');
  function finish(n){
    const moves=[];for(let l=n.log;l;l=l.prev)moves.push({tick:l.tick,keys:l.keys});moves.reverse();
    const dedup=[];for(const m of moves)if(!dedup.length||dedup[dedup.length-1].keys!==m.keys)dedup.push(m);
    return {moves:dedup,ticks:n.s.tick,completion_ms:n.s.completion_ms,completed:true};
  }
}
const only=process.argv[2]&&!process.argv[2].startsWith('--')?[process.argv[2]]:MT_COURSE_IDS;
const results={};
for(const id of only){const t=Date.now();results[id]=solve(id);console.log(id,'finished in',results[id].completion_ms/1000,'s,',results[id].moves.length,'input changes, solved in',(Date.now()-t)/1000,'s');}
if(!process.argv.includes('--dry')){
  if(only.length!==MT_COURSE_IDS.length)throw new Error('Solve every course before writing the fixture.');
  fs.writeFileSync('games/moto-trial-golden.js','// Verified completing inputs (scripts/moto-trial-solve.mjs), also used by the attract-mode preview.\nconst MT_GOLDEN = '+JSON.stringify(results)+';\n');
}
