// Parity harness for „Arkanoid G6" (arkanoid).
//
// Like scripts/saper-parity.mjs this does NOT carry a third copy of the sim:
// both PARITY BLOCKs are EXTRACTED from their source files and evaluated, so
// the thing under test is the shipped code.
//
//   client ← games/arkanoid.js
//   server ← supabase/functions/arkanoid-action/index.ts
//
// Two checks:
//   1. TEXTUAL — the fenced blocks must match once comments/blank lines go.
//   2. BEHAVIOURAL — drive rounds through the CLIENT copy exactly the way the
//      runtime does (inputs stamped with the tick they precede, logged only on
//      change), then replay the log through BOTH copies and compare every
//      outcome field. Also feeds malformed logs and expects both to reject.
//
// Run: node scripts/arkanoid-parity.mjs [rounds]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const START = '// ── PARITY BLOCK START';
const END = '// ── PARITY BLOCK END';

function extractBlock(path) {
  const src = readFileSync(path, 'utf8');
  const from = src.indexOf(START);
  const to = src.indexOf(END);
  if (from < 0 || to < 0 || to < from) { console.error(`FATAL: no PARITY BLOCK fences in ${path}`); process.exit(2); }
  return src.slice(src.indexOf('\n', from) + 1, to);
}
const normalize = block => block.split('\n')
  .map(line => line.replace(/\s*\/\/.*$/, '').trimEnd())
  .filter(line => line.trim().length > 0).join('\n');

const clientBlock = extractBlock(join(ROOT, 'games', 'arkanoid.js'));
const serverBlock = extractBlock(join(ROOT, 'supabase', 'functions', 'arkanoid-action', 'index.ts'));

let textualOk = normalize(clientBlock) === normalize(serverBlock);
if (!textualOk) {
  const a = normalize(clientBlock).split('\n'), b = normalize(serverBlock).split('\n');
  console.log('TEXTUAL MISMATCH between the two PARITY BLOCKs:');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) console.log(`  line ${i + 1}\n    client: ${a[i] ?? '<missing>'}\n    server: ${b[i] ?? '<missing>'}`);
  }
}

function loadSim(block, label) {
  try {
    return new Function(`${block}
      return { AK_W, AK_FP, AK_BALL, AK_PADDLE_Y, AK_MAX_TICKS, AK_MAX_INPUTS, AK_MAX_SCORE,
               akInitState, akTick, akInput, akReplay };`)();
  } catch (err) {
    console.error(`FATAL: ${label} PARITY BLOCK does not evaluate standalone:`, err.message);
    process.exit(2);
  }
}
const client = loadSim(clientBlock, 'client');
const server = loadSim(serverBlock, 'server');

function makeRnd(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function predictX(sim, st) {
  const falling = st.balls.filter(b => !b.stuck && b.vy > 0);
  const pool = falling.length ? falling : st.balls;
  if (!pool.length) return sim.AK_W >> 1;
  const b = pool.reduce((a, c) => (c.y > a.y ? c : a));
  const cx = b.x / sim.AK_FP + sim.AK_BALL / 2;
  if (b.vy <= 0) return cx;
  let x = cx + b.vx / b.vy * (sim.AK_PADDLE_Y - (b.y / sim.AK_FP + sim.AK_BALL));
  x = ((x % (2 * sim.AK_W)) + 2 * sim.AK_W) % (2 * sim.AK_W);
  return x > sim.AK_W ? 2 * sim.AK_W - x : x;
}

// Policies return a LIST of inputs for this tick (the runtime can queue a
// target change and a launch on the same tick), exercising every code path.
const POLICIES = {
  // Plays well: long rounds, level transitions, capsules, multiball.
  reader: (sim, st, rnd, mem) => {
    if (st.tick % 40 === 0 || mem.aim === undefined) mem.aim = (rnd() - 0.5) * 24;
    const out = [Math.max(0, Math.min(sim.AK_W, Math.round(predictX(sim, st) + mem.aim)))];
    if (st.balls.some(b => b.stuck) && rnd() < 0.2) out.push(-1);
    return out;
  },
  // Loses balls: covers life loss, re-serve and game over.
  sloppy: (sim, st, rnd) => {
    if (st.tick % 9 !== 0) return [];
    return [Math.max(0, Math.min(sim.AK_W, Math.round(predictX(sim, st) + (rnd() - 0.5) * 60)))];
  },
  // Jitters to the walls and spams launch: paddle clamping, launch on a moving
  // ball (must be a no-op), inputs at the extremes 0 and AK_W.
  fidget: (sim, st, rnd) => {
    const out = [];
    const r = rnd();
    if (r < 0.1) out.push(0);
    else if (r < 0.2) out.push(sim.AK_W);
    else if (r < 0.5) out.push(Math.floor(rnd() * (sim.AK_W + 1)));
    if (rnd() < 0.15) out.push(-1);
    return out;
  },
  // Never touches anything: the auto-launch has to carry the round.
  idle: () => [],
};

// Mirrors akTickOnce() in games/arkanoid.js: a target is logged only when it
// changes the sim's target; a launch only while a ball is held.
function drive(sim, seed, policy) {
  const st = sim.akInitState(seed);
  const rnd = makeRnd(seed ^ 0x5bd1e995);
  const mem = {};
  const log = [];
  while (!st.over) {
    for (const v of policy(sim, st, rnd, mem)) {
      if (v === -1) {
        if (!st.balls.some(b => b.stuck)) continue;
      } else if (v === st.target) continue;
      if (!sim.akInput(st, v)) return { log, st, bad: v };
      log.push(st.tick, v);
    }
    sim.akTick(st);
  }
  return { log, st, bad: null };
}

const FIELDS = ['ok', 'score', 'rawScore', 'ticks', 'level', 'cleared', 'bricks', 'capsules', 'livesLost', 'paddleHits', 'over'];
const same = (a, b) => FIELDS.every(f => a[f] === b[f]);

const N = Number(process.argv[2] || 400);
const names = Object.keys(POLICIES);
let mismatches = 0, rejected = 0, maxInputs = 0, maxTicks = 0, maxScore = 0;
const stats = Object.fromEntries(names.map(n => [n, { runs: 0, sum: 0, levels: 0 }]));

for (let i = 0; i < N; i += 1) {
  const seed = 1 + Math.floor(Math.random() * 2147483646);
  const name = names[i % names.length];
  const d = drive(client, seed, POLICIES[name]);
  if (d.bad !== null) { rejected += 1; continue; }
  const live = {
    ok: true, score: Math.min(client.AK_MAX_SCORE, d.st.score), rawScore: d.st.score, ticks: d.st.tick,
    level: d.st.level, cleared: d.st.cleared, bricks: d.st.bricks, capsules: d.st.capsulesCaught,
    livesLost: d.st.livesLost, paddleHits: d.st.paddleHits, over: d.st.over,
  };
  const c = client.akReplay(seed, d.log);
  const s = server.akReplay(seed, d.log);
  if (!c.ok || !s.ok) {
    rejected += 1;
    if (rejected <= 5) console.log('REPLAY REJECTED seed', seed, name, 'client@', c.atInput, 'server@', s.atInput);
    continue;
  }
  if (!same(c, s) || !same(c, live)) {
    mismatches += 1;
    if (mismatches <= 5) console.log('MISMATCH seed', seed, name, '\n  live  ', live, '\n  client', c, '\n  server', s);
  }
  maxInputs = Math.max(maxInputs, d.log.length / 2);
  maxTicks = Math.max(maxTicks, c.ticks);
  maxScore = Math.max(maxScore, c.rawScore);
  stats[name].runs += 1; stats[name].sum += c.score; stats[name].levels += c.cleared;
}

// Malformed logs must be rejected identically by both copies.
const BAD = [
  ['tick out of order', [10, 50, 5, 60]],
  ['target out of range', [0, 999]],
  ['non-integer target', [0, 12.5]],
  ['tick past the end of the round', [client.AK_MAX_TICKS + 5, 10]],
];
let badOk = true;
for (const [label, log] of BAD) {
  const c = client.akReplay(12345, log), s = server.akReplay(12345, log);
  const ok = !c.ok && !s.ok && c.atInput === s.atInput;
  if (!ok) { badOk = false; console.log('MALFORMED LOG NOT REJECTED:', label, c, s); }
}

console.log(`\ntextual parity: ${textualOk ? 'OK' : 'FAILED'}`);
console.log(`malformed logs rejected by both: ${badOk ? 'OK' : 'FAILED'}`);
console.log(`ran ${N} rounds across [${names.join(', ')}] — mismatches: ${mismatches} · rejected: ${rejected}`);
for (const n of names) {
  const st = stats[n];
  if (st.runs) console.log(`  ${n.padEnd(7)} avg ${Math.round(st.sum / st.runs).toString().padStart(6)} · floors/round ${(st.levels / st.runs).toFixed(2)}`);
}
console.log(`longest input log: ${maxInputs} (AK_MAX_INPUTS = ${client.AK_MAX_INPUTS}) · longest round ${maxTicks} ticks · best raw score ${maxScore} (cap ${client.AK_MAX_SCORE})`);
process.exit(textualOk && badOk && mismatches === 0 && rejected === 0 && maxInputs <= client.AK_MAX_INPUTS ? 0 : 1);
