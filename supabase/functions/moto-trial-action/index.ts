// @ts-nocheck
// Server-owned rounds, deterministic replay, no inventory bonuses.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import postgres from 'npm:postgres@3.4.5';
const db = postgres(Deno.env.get('SUPABASE_DB_URL')!, {prepare:false,max:4,idle_timeout:20});
const cors = {'Access-Control-Allow-Origin':'https://inlineskater.github.io','Access-Control-Allow-Headers':'authorization,x-client-info,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'};
// Canonical physics; scripts/moto-trial-parity.mjs verifies the Edge copy.
// MOTO PARITY BEGIN
const MT_VERSION = 3;
const MT_HZ = 60;
const MT_SUB = 4;
const MT_DT = 1 / (MT_HZ * MT_SUB);
const MT_MAX_TICKS = 10800;
const MT_KEYS = { throttle: 1, brake: 2, back: 4, forward: 8 };
const MT_COURSE_IDS = ['quarry_v3', 'mountain_v3'];
const MT_P = {
  g: 10.5,
  bodyM: 1, bodyI: 0.15, wheelM: 0.16, wheelI: 0.0115, wheelR: 0.34,
  rear: [-0.62, -0.42], front: [0.62, -0.42],
  kAxial: 160, cAxial: 4.2, kLat: 950, cLat: 15, travel: 0.17, kStop: 3200,
  engine: 3.0, react: 0.45, maxSpin: 46, brake: 3.2, lean: 4.2, leanAir: 2.3,
  angDamp: 0.35, airDrag: 0.04, roll: 0.25, mu: 1.15, rest: 0.08,
  engineBottom: [0.05, -0.36],
  head: [0.1, 0.86], headR: 0.17, torso: [-0.12, 0.44], torsoR: 0.15, leanShift: 0.22,
};
function mtClamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

// ── Courses ────────────────────────────────────────────────────────────────
// A course is a list of ops expanded into dense polylines. Gaps split it into
// separate pieces (a real hole you can fall into). Ops:
//   F len          flat
//   S len dy       smooth slope (zero slope at both ends)
//   H len h        smooth hill (h > 0) or dip (h < 0) returning to the same height
//   L dx dy        straight line — ramps, kickers, steps (dx 0 = vertical wall)
//   G len dy       gap: end this piece, continue len further and dy higher
const MT_LAYOUTS = {
  quarry_v3: [
    ['F', 14], ['H', 10, 0.8], ['F', 4], ['H', 12, 1.4], ['F', 6],
    ['S', 10, 2.5], ['F', 3], ['L', 0.05, -0.6], ['F', 6], ['S', 8, -1.9], ['F', 6],
    ['L', 5, 1.2], ['G', 5, -1.2], ['L', 4, -0.6], ['F', 6],
    ['H', 6, 0.7], ['H', 6, 0.7], ['H', 6, 0.7], ['F', 5],
    ['L', 0.05, 0.45], ['F', 5], ['L', 0.05, 0.45], ['F', 7], ['S', 10, -0.9], ['F', 5],
    ['H', 16, -2.2], ['F', 4], ['S', 12, 3.2], ['F', 4], ['L', 6, 1.0], ['G', 7, -2.2],
    ['L', 5, -1.2], ['F', 6], ['H', 8, 1.2], ['F', 3], ['H', 8, 1.6], ['F', 5],
    ['S', 6, -0.8], ['L', 0.05, -0.8], ['F', 8], ['H', 20, 3.0], ['F', 6],
    ['L', 5, 1.4], ['G', 6, -0.4], ['F', 4], ['S', 10, -1.0], ['F', 22],
  ],
  mountain_v3: [
    ['F', 14], ['S', 12, 3.5], ['F', 3], ['S', 10, -2.0], ['F', 4],
    ['L', 0.05, 0.55], ['F', 4], ['L', 0.05, 0.55], ['F', 6],
    ['S', 9, 4.2], ['F', 3], ['L', 5, 1.2], ['G', 6, -3.5], ['L', 5, -1.6], ['F', 6],
    ['H', 5, 0.8], ['H', 5, 0.8], ['H', 5, 0.8], ['H', 5, 0.8], ['F', 6],
    ['S', 8, 4.0], ['F', 2], ['S', 7, 3.2], ['F', 4], ['L', 0.05, -1.4], ['F', 5],
    ['S', 10, -3.6], ['F', 3], ['L', 0.05, 0.6], ['F', 5], ['H', 14, -2.6], ['F', 3],
    ['L', 6, 1.6], ['G', 8, -1.0], ['L', 4, -1.4], ['F', 6],
    ['S', 7, 2.6], ['F', 3], ['S', 7, 2.6], ['F', 3], ['L', 0.05, -1.2], ['F', 4],
    ['S', 12, -4.5], ['F', 5], ['H', 9, 1.8], ['F', 2], ['H', 9, 2.2], ['F', 4],
    ['L', 5, 1.5], ['G', 7, -2.0], ['L', 4, -1.0], ['F', 5], ['L', 0.05, 0.5], ['F', 3],
    ['S', 10, 3.0], ['F', 3], ['S', 10, -3.0], ['F', 24],
  ],
};
function mtCourse(id) {
  if (!MT_COURSE_IDS.includes(id)) throw new Error('Nieznana trasa.');
  const hard = id === 'mountain_v3';
  const pieces = []; let pts = [[-24, 0], [0, 0]], x = 0, y = 0;
  const steps = len => Math.max(2, Math.ceil(len / 0.55));
  const ops = {
    F(len) { x += len; pts.push([x, y]); },
    L(dx, dy) { x += dx; y += dy; pts.push([x, y]); },
    S(len, dy) { const x0 = x, y0 = y, n = steps(len); for (let i = 1; i <= n; i++) { const t = i / n; pts.push([x0 + len * t, y0 + dy * t * t * (3 - 2 * t)]); } x = x0 + len; y = y0 + dy; },
    H(len, h) { const x0 = x, y0 = y, n = steps(len); for (let i = 1; i <= n; i++) { const t = i / n, u = t * (1 - t); pts.push([x0 + len * t, y0 + 16 * h * u * u]); } x = x0 + len; },
    G(len, dy) { pieces.push(pts); x += len; y += dy; pts = [[x, y]]; },
  };
  for (const op of MT_LAYOUTS[id]) ops[op[0]](op[1], op[2]);
  pieces.push(pts);
  const segs = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity;
  for (const p of pieces) for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    segs.push([a[0], a[1], b[0], b[1]]);
    minX = Math.min(minX, a[0]); maxX = Math.max(maxX, b[0]); minY = Math.min(minY, a[1], b[1]);
  }
  // 1-metre buckets of segment indices for contact queries.
  const x0 = Math.floor(minX) - 1, buckets = [];
  for (let i = 0; i <= Math.ceil(maxX) - x0 + 1; i++) buckets.push([]);
  segs.forEach((s, i) => { for (let b = Math.floor(s[0]) - x0; b <= Math.floor(s[2]) - x0; b++) buckets[b].push(i); });
  const finish = x - 12;
  return { id, version: MT_VERSION, name: hard ? 'Górska Przełęcz' : 'Kamieniołom', hard, pieces, segs, buckets, x0, minY, start: 2, finish };
}

// Closest point of the course to (px, py) within r: {d, nx, ny} or null.
function mtNearest(course, px, py, r) {
  let best = null, bd = r * r;
  const lo = Math.max(0, Math.floor(px - r) - course.x0), hi = Math.min(course.buckets.length - 1, Math.floor(px + r) - course.x0);
  for (let b = lo; b <= hi; b++) for (const i of course.buckets[b]) {
    const s = course.segs[i], dx = s[2] - s[0], dy = s[3] - s[1], len2 = dx * dx + dy * dy;
    let t = ((px - s[0]) * dx + (py - s[1]) * dy) / len2; t = mtClamp(t, 0, 1);
    const qx = s[0] + dx * t, qy = s[1] + dy * t, ex = px - qx, ey = py - qy, d2 = ex * ex + ey * ey;
    if (d2 < bd) { bd = d2; best = { qx, qy, ex, ey, sx: dx, sy: dy }; }
  }
  if (!best) return null;
  const d = Math.sqrt(bd);
  if (d > 1e-9) return { d, nx: best.ex / d, ny: best.ey / d };
  const l = Math.sqrt(best.sx * best.sx + best.sy * best.sy);
  return { d: 0, nx: -best.sy / l, ny: best.sx / l };
}

function mtWheel(x, y) { return { x, y, vx: 0, vy: 0, w: 0, a: 0, g: false }; }
function mtInit(course) {
  const P = MT_P, by = P.wheelR - P.rear[1] - 0.03, bx = course.start;
  return {
    tick: 0, over: false, completed: false, reason: '', completion_ms: null, score: 0,
    maxX: bx, lean: 0,
    b: { x: bx, y: by, vx: 0, vy: 0, c: 1, s: 0, w: 0 },
    wr: mtWheel(bx + P.rear[0], P.wheelR), wf: mtWheel(bx + P.front[0], P.wheelR),
  };
}
// Chassis-local point → world.
function mtLocal(b, lx, ly) { return [b.x + b.c * lx - b.s * ly, b.y + b.s * lx + b.c * ly]; }
function mtHead(st) { const P = MT_P; return mtLocal(st.b, P.head[0] - P.leanShift * st.lean, P.head[1] - 0.05 * Math.abs(st.lean)); }
function mtTorso(st) { const P = MT_P; return mtLocal(st.b, P.torso[0] - 0.5 * P.leanShift * st.lean, P.torso[1]); }

function mtSuspend(b, W, A, h) {
  const P = MT_P;
  const rx = b.c * A[0] - b.s * A[1], ry = b.s * A[0] + b.c * A[1];
  const dx = W.x - (b.x + rx), dy = W.y - (b.y + ry);
  const dvx = W.vx - (b.vx - b.w * ry), dvy = W.vy - (b.vy + b.w * rx);
  const dl = dx * b.c + dy * b.s, du = -dx * b.s + dy * b.c;
  const vl = dvx * b.c + dvy * b.s, vu = -dvx * b.s + dvy * b.c;
  const fl = -P.kLat * dl - P.cLat * vl;
  let fu = -P.kAxial * du - P.cAxial * vu;
  if (du > P.travel) fu -= P.kStop * (du - P.travel);
  else if (du < -P.travel) fu -= P.kStop * (du + P.travel);
  const fx = fl * b.c - fu * b.s, fy = fl * b.s + fu * b.c;
  W.vx += fx * h / P.wheelM; W.vy += fy * h / P.wheelM;
  b.vx -= fx * h / P.bodyM; b.vy -= fy * h / P.bodyM;
  b.w -= (rx * fy - ry * fx) * h / P.bodyI;
}
function mtWheelContact(W, course) {
  const P = MT_P, n = mtNearest(course, W.x, W.y, P.wheelR + 0.004);
  W.g = false;
  if (!n) return;
  W.g = true;
  if (n.d < P.wheelR) { const pen = P.wheelR - n.d; W.x += n.nx * pen; W.y += n.ny * pen; }
  const vn = W.vx * n.nx + W.vy * n.ny;
  let jn = 0;
  if (vn < 0) { jn = -vn * (1 + P.rest) * P.wheelM; W.vx -= vn * (1 + P.rest) * n.nx; W.vy -= vn * (1 + P.rest) * n.ny; }
  const tx = n.ny, ty = -n.nx;
  const vt = W.vx * tx + W.vy * ty + W.w * P.wheelR;
  const k = 1 / P.wheelM + P.wheelR * P.wheelR / P.wheelI;
  const lim = P.mu * jn, jt = mtClamp(-vt / k, -lim, lim);
  W.vx += jt * tx / P.wheelM; W.vy += jt * ty / P.wheelM; W.w += jt * P.wheelR / P.wheelI;
}
// The engine sump scrapes instead of sinking through a crest.
function mtBodyContact(b, course) {
  const P = MT_P, [px, py] = mtLocal(b, P.engineBottom[0], P.engineBottom[1]);
  const n = mtNearest(course, px, py, 0.06);
  if (!n) return;
  const pen = 0.06 - n.d; b.x += n.nx * pen; b.y += n.ny * pen;
  const rx = px - b.x, ry = py - b.y;
  const vn = (b.vx - b.w * ry) * n.nx + (b.vy + b.w * rx) * n.ny;
  if (vn >= 0) return;
  const rn = rx * n.ny - ry * n.nx, j = -vn * 1.05 / (1 / P.bodyM + rn * rn / P.bodyI);
  b.vx += j * n.nx / P.bodyM; b.vy += j * n.ny / P.bodyM; b.w += rn * j / P.bodyI;
  b.vx *= 0.995; b.vy *= 0.995;
}
function mtSub(st, thr, brk, lean, course) {
  const P = MT_P, h = MT_DT, b = st.b, R = st.wr, F = st.wf;
  const air = !R.g && !F.g;
  b.vy -= P.g * h; R.vy -= P.g * h; F.vy -= P.g * h;
  mtSuspend(b, R, P.rear, h);
  mtSuspend(b, F, P.front, h);
  if (thr && R.w > -P.maxSpin) { R.w -= P.engine * h / P.wheelI; b.w += P.engine * P.react * h / P.bodyI; }
  if (brk) for (const W of [R, F]) {
    const dw = P.brake * h / P.wheelI, before = W.w;
    W.w = W.w > dw ? W.w - dw : W.w < -dw ? W.w + dw : 0;
    b.w -= (W.w - before) * P.wheelI * P.react / P.bodyI;
  }
  b.w += lean * (air ? P.leanAir : P.lean) * h / P.bodyI;
  b.w -= b.w * P.angDamp * h;
  b.vx -= b.vx * P.airDrag * h; b.vy -= b.vy * P.airDrag * h;
  for (const W of [R, F]) { W.w -= W.w * P.roll * h; W.x += W.vx * h; W.y += W.vy * h; W.a += W.w * h; if (W.a > 6.283185307179586) W.a -= 6.283185307179586; else if (W.a < 0) W.a += 6.283185307179586; }
  b.x += b.vx * h; b.y += b.vy * h;
  const dc = b.c - b.s * b.w * h, ds = b.s + b.c * b.w * h, l = Math.sqrt(dc * dc + ds * ds);
  b.c = dc / l; b.s = ds / l;
  mtWheelContact(R, course); mtWheelContact(F, course);
  mtBodyContact(b, course);
}
function mtTouches(course, p, r) { return mtNearest(course, p[0], p[1], r) !== null; }
function mtStep(st, keys, course) {
  if (st.over) return st;
  const P = MT_P, brk = (keys & 2) !== 0, thr = (keys & 1) !== 0 && !brk;
  const lean = ((keys & 4) ? 1 : 0) - ((keys & 8) ? 1 : 0);
  for (let i = 0; i < MT_SUB; i++) mtSub(st, thr, brk, lean, course);
  st.lean += mtClamp(lean - st.lean, -0.125, 0.125);
  st.tick++;
  const b = st.b;
  st.maxX = Math.max(st.maxX, b.x);
  st.score = mtClamp(Math.floor((st.maxX - course.start) * 10000 / (course.finish - course.start)), 0, 9999);
  if (mtTouches(course, mtHead(st), P.headR)) { st.over = true; st.reason = 'Uderzenie kaskiem'; }
  else if (mtTouches(course, mtTorso(st), P.torsoR)) { st.over = true; st.reason = 'Upadek z motocykla'; }
  else if (b.y < course.minY - 12) { st.over = true; st.reason = 'Upadek w przepaść'; }
  else if (b.x >= course.finish) { st.over = true; st.completed = true; st.score = 10000; st.completion_ms = Math.floor(st.tick * 1000 / MT_HZ); st.reason = 'Meta!'; }
  else if (st.tick >= MT_MAX_TICKS) { st.over = true; st.reason = 'Koniec czasu'; }
  return st;
}
function mtReplay(courseId, moves, ticks) {
  if (!Number.isInteger(ticks) || ticks < 1 || ticks > MT_MAX_TICKS || !Array.isArray(moves) || moves.length > MT_MAX_TICKS) throw new Error('Niepoprawny zapis rundy.');
  let prev = -1;
  for (const m of moves) { if (!m || !Number.isInteger(m.tick) || m.tick <= prev || m.tick < 0 || m.tick >= ticks || !Number.isInteger(m.keys) || m.keys < 0 || m.keys > 15) throw new Error('Niepoprawne sterowanie.'); prev = m.tick; }
  const course = mtCourse(courseId), st = mtInit(course);
  let at = 0, keys = 0;
  while (st.tick < ticks && !st.over) { if (moves[at]?.tick === st.tick) keys = moves[at++].keys; mtStep(st, keys, course); }
  if (st.tick !== ticks) throw new Error('Runda zakończyła się wcześniej.');
  return st;
}
function mtArcadeScore(st) { return st.completed ? 200000 + (180000 - st.completion_ms) : st.score; }
// MOTO PARITY END

async function mtCalendar(tx=db) {
 const [r]=await tx`select clock_timestamp() as server_now,public.moto_trial_week_start() as week_start,
 public.seasonal_game_for_week(public.moto_trial_week_start()) as game,
 ((public.moto_trial_week_start()+7)::timestamp at time zone 'Europe/Warsaw') as week_end,
 public.moto_trial_course_for_week(public.moto_trial_week_start()) as course_id`;
 return r;
}
async function mtState(userId,body) {
 const cal=await mtCalendar();
 const courseId=body.mode==='arcade' ? (body.courseId==='mountain_v3'?'mountain_v3':'quarry_v3') : cal.course_id;
 const weekly=await db`select * from public.moto_trial_current_week order by rank limit 20`;
 const records=await db`select * from public.moto_trial_all_time where course_id=${courseId} order by rank limit 20`;
 const [personal]=await db`select * from public.moto_trial_all_time where course_id=${courseId} and user_id=${userId}`;
 const [myWeekly]=await db`select * from public.moto_trial_current_week where user_id=${userId}`;
 return {calendar:cal,courseId,weekly,records,personal:personal||null,myWeekly:myWeekly||null,prizes:[1000,500,200]};
}
async function mtStart(userId,body) {
 if(!['season','arcade'].includes(body.mode))throw new Error('Niepoprawny tryb.');
 return await db.begin(async tx=>{
 const [p]=await tx`select id,nick from public.profiles where id=${userId} for update`;
 if(!p)throw new Error('Brak profilu.');
 const cal=await mtCalendar(tx);
 if(body.mode==='season'&&cal.game!=='moto_trial')throw new Error('Ten sezon nie jest aktywny.');
 const courseId=body.mode==='season'?cal.course_id:(body.courseId==='mountain_v3'?'mountain_v3':'quarry_v3');
 const course=mtCourse(courseId);
 const [recent]=await tx`select id from public.moto_trial_rounds where user_id=${userId} and started_at>clock_timestamp()-interval '1 second' limit 1`;
 if(recent)throw new Error('Odczekaj sekundę przed kolejną próbą.');
 await tx`update public.moto_trial_rounds set abandoned=true where user_id=${userId} and submitted_at is null and not abandoned`;
 const [round]=await tx`insert into public.moto_trial_rounds(user_id,nick_snapshot,mode,week_start,course_id,version,expires_at)
 values(${userId},${p.nick},${body.mode},${cal.week_start},${courseId},${MT_VERSION},
 case when ${body.mode}='season' then least(clock_timestamp()+interval '210 seconds',${cal.week_end}::timestamptz) else clock_timestamp()+interval '210 seconds' end)
 returning id,course_id,version,mode,started_at,expires_at`;
 return {round,course:{id:course.id,name:course.name},calendar:cal};
 });
}
async function mtSubmit(userId,body) {
 if(typeof body.roundId!=='string'||!/^[0-9a-f-]{36}$/i.test(body.roundId))throw new Error('Niepoprawna runda.');
 return await db.begin(async tx=>{
 const [r]=await tx`select *,clock_timestamp() as checked_at from public.moto_trial_rounds where id=${body.roundId} and user_id=${userId} for update`;
 if(!r)throw new Error('Nie znaleziono rundy.');
 if(r.result)return {result:r.result};
 // Serialize the weekly cutoff against awards. Re-read time after waiting.
 if(r.mode==='season')await tx`select pg_advisory_xact_lock(hashtext('moto_trial_award'),${r.week_start}::date-DATE '2000-01-01')`;
 const [clock]=await tx`select clock_timestamp() as checked_at`;r.checked_at=clock.checked_at;
 if(r.abandoned||new Date(r.checked_at)>=new Date(r.expires_at))throw new Error('Runda wygasła.');
 if(r.version!==MT_VERSION)throw new Error('Odśwież grę: zmieniła się wersja.');
 if(!Number.isInteger(body.elapsedTicks)||body.elapsedTicks*1000/MT_HZ>new Date(r.checked_at).getTime()-new Date(r.started_at).getTime()+1500)throw new Error('Runda rozegrana za szybko.');
 const st=mtReplay(r.course_id,body.moves,body.elapsedTicks);
 // A manual restart/navigation may bank reached progress, never a fabricated finish.
 const result={score:st.score,completed:st.completed,completion_ms:st.completion_ms,duration_ms:Math.floor(st.tick*1000/MT_HZ),reason:st.over?st.reason:'Próba przerwana',course_id:r.course_id};
 await tx`insert into public.moto_trial_scores(round_id,user_id,nick_snapshot,mode,week_start,course_id,version,score,completed,completion_ms,duration_ms,client_meta)
 values(${r.id},${userId},${r.nick_snapshot},${r.mode},${r.week_start},${r.course_id},${r.version},${st.score},${st.completed},${st.completion_ms},${result.duration_ms},${tx.json({server_validated:true,moves:body.moves,reason:result.reason})})`;
 if(r.mode==='arcade'&&r.course_id==='quarry_v3')await tx`insert into public.arcade_scores(user_id,game_type,score,coins_paid,client_meta)
 values(${userId},'moto_trial',${mtArcadeScore(st)},0,${tx.json(result)})`;
 await tx`update public.moto_trial_rounds set result=${tx.json(result)},submitted_at=clock_timestamp() where id=${r.id}`;
 return {result};
 });
}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
 const respond=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
 if(req.method!=='POST')return respond({ok:false,error:'Method not allowed'},405);
 try {
 const auth=req.headers.get('Authorization')||'';
 const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:auth}}});
 const {data,error}=await client.auth.getUser();if(error||!data.user)return respond({ok:false,error:'Zaloguj się ponownie.'},401);
 const raw=await req.text();if(raw.length>400000)return respond({ok:false,error:'Zbyt duży zapis.'},413);
 const body=JSON.parse(raw);let out;
 if(body.action==='state')out=await mtState(data.user.id,body);
 else if(body.action==='start')out=await mtStart(data.user.id,body);
 else if(body.action==='submit')out=await mtSubmit(data.user.id,body);
 else throw new Error('Nieznana akcja.');
 return respond({ok:true,...out});
 }catch(e){console.error(e);return respond({ok:false,error:e instanceof Error&&!('severity' in e)?e.message:'Błąd serwera. Spróbuj ponownie.'});}
});
