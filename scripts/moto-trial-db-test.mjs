// Run with PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js
// Uses an isolated in-memory PostgreSQL; never connects to Supabase.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();
await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
GRANT USAGE ON SCHEMA auth TO authenticated,anon;
CREATE TABLE profiles(id uuid PRIMARY KEY,nick text NOT NULL,coins integer NOT NULL DEFAULT 0);
CREATE TABLE arcade_scores(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,game_type text,score integer,coins_paid integer,client_meta jsonb,created_at timestamptz DEFAULT now());
CREATE PUBLICATION supabase_realtime;
CREATE SCHEMA cron;CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;`);
const gate=fs.readFileSync('supabase/season-award-gating.sql','utf8').split('-- pg_cron runs')[0];await db.exec(gate);
const migration=fs.readFileSync('supabase/moto-trial.sql','utf8');await db.exec(migration);await db.exec(migration); // idempotent
const one=async(sql,args=[]) =>(await db.query(sql,args)).rows[0];
assert.equal((await one("select moto_trial_week_start('2026-10-18 21:59:59Z')::text as w")).w,'2026-10-12');
assert.equal((await one("select moto_trial_week_start('2026-10-18 22:00:00Z')::text as w")).w,'2026-10-19');
assert.equal((await one("select extract(epoch from ((DATE '2026-10-26')::timestamp at time zone 'Europe/Warsaw')-((DATE '2026-10-19')::timestamp at time zone 'Europe/Warsaw'))/3600 as hours")).hours, '169.0000000000000000');
assert.equal((await one("select seasonal_game_for_week('2026-10-05') as g")).g,'rps');
assert.equal((await one("select seasonal_game_for_week('2026-10-12') as g")).g,'tetris');
assert.equal((await one("select moto_trial_course_for_week('2026-10-19') as c")).c,'quarry_v3');
assert.equal((await one("select moto_trial_course_for_week('2026-10-26') as c")).c,'mountain_v3');
for(const week of ['2026-10-19','2026-10-26'])assert.equal((await one('select seasonal_game_for_week($1) as g',[week])).g,'moto_trial');
const users=[1,2,3,4].map(n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0'));
for(let i=0;i<4;i++)await db.query('insert into profiles(id,nick) values($1,$2)',[users[i],'Rider '+i]);
async function score(user,progress,time,mode='season',week='2026-10-19',course='quarry_v3',submitted='2026-10-20T12:00:00Z'){
 const r=await one("insert into moto_trial_rounds(user_id,nick_snapshot,mode,week_start,course_id,version,expires_at) values($1,'Rider',$2,$3,$4,3,now()+interval '3 minutes') returning id",[users[user],mode,week,course]);
 await db.query('insert into moto_trial_scores(round_id,user_id,nick_snapshot,mode,week_start,course_id,version,score,completed,completion_ms,duration_ms,submitted_at) values($1,$2,$3,$4,$5,$6,3,$7,$8,$9,90000,$10)',[r.id,users[user],'Rider '+user,mode,week,course,progress,progress===10000,time,submitted]);return r.id;
}
await score(0,9999,null);await score(1,10000,80000);await score(2,10000,79000);await score(0,10000,75000);
await score(3,10000,1,'arcade');await score(3,10000,1,'season','2026-10-19','mountain_v3');
let rows=(await db.query("select * from moto_trial_weekly_best where week_start='2026-10-19' order by rank")).rows;assert.deepEqual(rows.map(r=>r.user_id),[users[0],users[2],users[1]]);
await score(1,10000,79000,'season','2026-10-19','quarry_v3','2026-10-20T12:00:01Z');
rows=(await db.query("select * from moto_trial_weekly_best where week_start='2026-10-19' order by rank")).rows;assert.deepEqual(rows.map(r=>r.user_id),[users[0],users[2],users[1]],'earlier submission wins exact time tie');
for(let i=0;i<3;i++)await score(i,10000,70000+i*1000,'season','2026-10-26','mountain_v3');
// Close both weeks for payout tests without changing machine time.
await db.exec("CREATE OR REPLACE FUNCTION moto_trial_week_start(p_ts timestamptz DEFAULT now()) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-11-02' $$;");
await db.query("select award_moto_trial_week('2026-10-19')");await db.query("select award_moto_trial_week('2026-10-19')");
assert.equal((await one('select sum(coins)::integer as coins from profiles')).coins,1700);
await db.query("select award_moto_trial_week('2026-10-26')");await db.query("select award_moto_trial_week('2026-10-26')");assert.equal((await one('select sum(coins)::integer as coins from profiles')).coins,3400);
assert.equal((await one('select count(*)::integer as n from moto_trial_weekly_awards')).n,6);
await assert.rejects(()=>db.query("select award_moto_trial_week('2026-11-02')"),/week_not_closed/);
assert.equal((await one("select award_moto_trial_week('2026-10-05') as r")).r.skipped,true);
await db.exec("SET ROLE authenticated;SELECT set_config('request.jwt.claim.role','authenticated',false);");
await assert.rejects(()=>db.query('delete from moto_trial_scores'),/permission denied/);
await assert.rejects(()=>db.query("select award_moto_trial_week('2026-10-19')"),/permission denied/);
await db.exec("RESET ROLE;");
// Even a security-definer arcade RPC cannot accept a fabricated client score.
await assert.rejects(()=>db.query("insert into arcade_scores(game_type,score) values('moto_trial',379999)"),/server_replay_required/);
console.log('PASS: actual PostgreSQL migration/reapply, ranking, course/mode isolation, tie order, two weekly payouts, duplicate awards, role restrictions, arcade replay guard and Warsaw DST.');
// Exercise the actual Edge action functions against this same PostgreSQL.
await db.exec("SELECT set_config('request.jwt.claim.role','',false);CREATE OR REPLACE FUNCTION moto_trial_week_start(p_ts timestamptz DEFAULT now()) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-10-19' $$;");
function sqlTag(pg){const tag=async(parts,...values)=>{let sql=parts[0];for(let i=0;i<values.length;i++)sql+='$'+(i+1)+parts[i+1];return (await pg.query(sql,values)).rows;};tag.json=v=>JSON.stringify(v);tag.begin=fn=>pg.transaction(tx=>fn(sqlTag(tx)));return tag;}
let server=fs.readFileSync('supabase/functions/moto-trial-action/index.ts','utf8').replace(/^import .*$/gm,'').replace(/^const db = .*$/m,'').split('Deno.serve(')[0];
const ctx=vm.createContext({db:sqlTag(db),console,Date});vm.runInContext(server,ctx);
const start=(i,mode='arcade',courseId='quarry_v3')=>ctx.mtStart(users[i],{mode,courseId});
const submit=(i,body)=>ctx.mtSubmit(users[i],body);
const resetRate=()=>db.exec("UPDATE moto_trial_rounds SET started_at=clock_timestamp()-interval '10 minutes'");
await resetRate();let {round}=await start(3);
await assert.rejects(()=>submit(3,{roundId:round.id,elapsedTicks:10000,moves:[]}),/za szybko/);
await assert.rejects(()=>submit(0,{roundId:round.id,elapsedTicks:1,moves:[]}),/Nie znaleziono/);
await assert.rejects(()=>submit(3,{roundId:round.id,elapsedTicks:1,moves:[{tick:0,keys:99}]}),/sterowanie/);
let result=await submit(3,{roundId:round.id,elapsedTicks:1,moves:[],score:999999});assert.equal(result.result.score,0,'ignore fabricated client score');
let duplicate=await submit(3,{roundId:round.id,elapsedTicks:100,moves:[]});assert.deepEqual(JSON.parse(JSON.stringify(duplicate)),JSON.parse(JSON.stringify(result)));
assert.equal((await one('select count(*)::integer as n from moto_trial_scores where round_id=$1',[round.id])).n,1);
await resetRate();({round}=await start(3,'season'));await db.query("update moto_trial_rounds set expires_at=clock_timestamp()-interval '1 second' where id=$1",[round.id]);await assert.rejects(()=>submit(3,{roundId:round.id,elapsedTicks:1,moves:[]}),/wygasła/);
const goldContext=vm.createContext({});vm.runInContext(fs.readFileSync('games/moto-trial-golden.js','utf8'),goldContext);const golden=vm.runInContext('MT_GOLDEN',goldContext);
await resetRate();({round}=await start(3));await db.query("update moto_trial_rounds set started_at=clock_timestamp()-interval '100 seconds' where id=$1",[round.id]);
const log=golden.quarry_v3,body={roundId:round.id,elapsedTicks:log.ticks,moves:log.moves};const before=(await one("select count(*)::integer as n from arcade_scores where game_type='moto_trial'")).n;
const both=await Promise.all([submit(3,body),submit(3,body)]);assert.deepEqual(JSON.parse(JSON.stringify(both[0])),JSON.parse(JSON.stringify(both[1])));assert.equal(both[0].result.completion_ms,log.completion_ms);assert.equal((await one("select count(*)::integer as n from arcade_scores where game_type='moto_trial'")).n,before+1);
await resetRate();({round}=await start(3,'arcade','mountain_v3'));await db.query("update moto_trial_rounds set started_at=clock_timestamp()-interval '100 seconds' where id=$1",[round.id]);await submit(3,{roundId:round.id,elapsedTicks:golden.mountain_v3.ticks,moves:golden.mountain_v3.moves});assert.equal((await one("select count(*)::integer as n from arcade_scores where game_type='moto_trial'")).n,before+1,'mountain never changes generic arcade medals');
await resetRate();const first=await start(3);await resetRate();await start(3);await assert.rejects(()=>submit(3,{roundId:first.round.id,elapsedTicks:1,moves:[]}),/wygasła/);
await db.exec("CREATE OR REPLACE FUNCTION moto_trial_week_start(p_ts timestamptz DEFAULT now()) RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-10-05' $$;");await resetRate();await assert.rejects(()=>start(3,'season'),/nie jest aktywny/);
console.log('PASS: actual Edge start/submit functions, ownership, malformed controls, impossible timing, fabricated scores, cutoff, duplicate replay, abandonment, arcade course isolation and off-season rejection.');
await db.close();
