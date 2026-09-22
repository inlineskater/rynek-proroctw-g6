// Balance harness for „Arkanoid G6" (arkanoid).
//
// Extracts the PARITY BLOCK from games/arkanoid.js (the shipped code, not a
// transcription) and drives it with bots of different skill, then asserts the
// invariants the design depends on:
//
//   • every level row is exactly AK_COLS wide and fits in AK_ROWS
//   • every bounce direction has length ≈ 64 (constant ball speed)
//   • no floor takes a perfect bot longer than 150 s, i.e. no layout can trap
//     the ball in a loop the paddle can never break
//   • even a perfect bot cannot exceed AK_MAX_SCORE inside AK_MAX_TICKS, so the
//     cap truncates nothing honest
//   • a good player lands well inside the cap, and reading the bounce matters
//
// Run: node scripts/arkanoid-balance.mjs [rounds]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'games', 'arkanoid.js'), 'utf8');
const block = src.slice(src.indexOf('\n', src.indexOf('// ── PARITY BLOCK START')) + 1, src.indexOf('// ── PARITY BLOCK END'));
const sim = new Function(`${block}
  return { AK_TICK_MS, AK_MAX_TICKS, AK_MAX_SCORE, AK_MAX_INPUTS, AK_FP, AK_W, AK_H, AK_COLS, AK_ROWS,
           AK_BALL, AK_PADDLE_Y, AK_DIRS, AK_LEVELS, akInitState, akTick, akInput, akReplay };`)();

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}

// ── static invariants ────────────────────────────────────────────────────────
const badRows = [];
sim.AK_LEVELS.forEach((rows, li) => {
  if (rows.length > sim.AK_ROWS) badRows.push(`level ${li + 1} has ${rows.length} rows`);
  rows.forEach((r, ri) => { if (r.length !== sim.AK_COLS) badRows.push(`level ${li + 1} row ${ri + 1} is ${r.length} wide`); });
});
check('level layouts are 14 columns and fit the grid', badRows.length === 0, badRows.join('; '));
const lens = sim.AK_DIRS.map(([x, y]) => Math.hypot(x, y));
check('bounce vectors all have length ≈ 64', lens.every(l => Math.abs(l - 64) < 0.6), lens.map(l => l.toFixed(2)).join(' '));
check('no bounce direction is shallower than 25°', sim.AK_DIRS.every(([x, y]) => Math.abs(y) / 64 > Math.sin(25 * Math.PI / 180)));

// ── bots ─────────────────────────────────────────────────────────────────────
function makeRnd(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// Where will the lowest descending ball cross the paddle line? Simple wall-fold
// prediction, which is what a decent player does by eye.
function predictX(st) {
  const falling = st.balls.filter(b => !b.stuck && b.vy > 0);
  const pool = falling.length ? falling : st.balls;
  if (!pool.length) return sim.AK_W >> 1;
  const b = pool.reduce((a, c) => (c.y > a.y ? c : a));
  const cx = b.x / sim.AK_FP + sim.AK_BALL / 2;
  if (b.vy <= 0) return cx;
  const dy = sim.AK_PADDLE_Y - (b.y / sim.AK_FP + sim.AK_BALL);
  let x = cx + b.vx / b.vy * dy;
  const W = sim.AK_W;
  x = ((x % (2 * W)) + 2 * W) % (2 * W);
  return x > W ? 2 * W - x : x;
}

// The paddle offset that sends the ball towards the remaining bricks: a skilled
// player steers with the paddle's edges instead of just catching the ball.
function aimOffset(st, landX) {
  let best = null, bestD = Infinity;
  for (let i = st.hp.length - 1; i >= 0; i -= 1) {
    if (st.hp[i] <= 0) continue;
    const cx = (i % sim.AK_COLS + 0.5) * 16;
    const d = Math.abs(cx - landX);
    if (d < bestD) { bestD = d; best = cx; }
  }
  if (best === null) return 0;
  const dx = best - landX;
  const pw = st.wide > 0 ? 48 : 32;
  // zone 0..7 across the paddle; far targets use the outer zones.
  const zone = dx < -60 ? 1 : dx < -20 ? 2 : dx < 0 ? 3 : dx < 20 ? 4 : dx < 60 ? 5 : 6;
  return pw / 2 - (zone + 0.5) * pw / 8;
}

// Human-shaped bots see the world `lag` ticks late, re-aim every `every` ticks
// and miss by up to ±`noise` units.
function ballX(st) {
  const live = st.balls.filter(b => !b.stuck);
  const pool = live.length ? live : st.balls;
  const b = pool.reduce((a, c) => (c.y > a.y ? c : a));
  return b.x / sim.AK_FP + sim.AK_BALL / 2;
}
function human({ lag, every, noise, aims, predicts = true }) {
  return (st, rnd, mem) => {
    mem.hist ??= [];
    const land = predicts ? predictX(st) : ballX(st);
    mem.hist.push(land + (aims ? aimOffset(st, land) : 0));
    if (mem.hist.length > lag + 1) mem.hist.shift();
    if (st.tick % every !== 0) return null;
    return Math.round(mem.hist[0] + (rnd() - 0.5) * 2 * noise);
  };
}

const POLICIES = {
  // Reads every bounce perfectly and hits with a varied part of the paddle so
  // the ball explores the wall. Never late, never wrong: an UPPER BOUND on what
  // a round can score, which is what AK_MAX_SCORE is checked against.
  perfect: (st, rnd, mem) => {
    if (st.tick % 50 === 0 || mem.aim === undefined) mem.aim = (rnd() - 0.5) * 26;
    return Math.round(predictX(st) + mem.aim);
  },
  // A good office player: reads the bounce, ~140 ms late, ±5 units off.
  good: human({ lag: 7, every: 3, noise: 5, aims: false }),
  // A casual player: reads the bounce but late (~280 ms) and sloppily (±11).
  casual: human({ lag: 14, every: 6, noise: 11, aims: false }),
  // A first-timer: chases where the ball IS rather than where it is going.
  rookie: human({ lag: 5, every: 4, noise: 4, aims: false, predicts: false }),
};

function play(seed, policyName) {
  const st = sim.akInitState(seed);
  const rnd = makeRnd(seed ^ 0x9e3779b9);
  const mem = {};
  const inputs = [];
  let levelStart = 0, lastLevel = 0, maxLevelTicks = 0;
  while (!st.over) {
        let t = POLICIES[policyName](st, rnd, mem);
    if (t !== null && t !== undefined) {
      t = Math.max(0, Math.min(sim.AK_W, t));
      if (t !== st.target) { sim.akInput(st, t); inputs.push(st.tick, t); }
    }
    if (st.balls.some(b => b.stuck) && st.tick % 25 === 5) { sim.akInput(st, -1); inputs.push(st.tick, -1); }
    sim.akTick(st);
    if (st.level !== lastLevel) {
      maxLevelTicks = Math.max(maxLevelTicks, st.tick - levelStart);
      levelStart = st.tick; lastLevel = st.level;
    }
  }
  return { st, inputs, maxLevelTicks };
}

const N = Number(process.argv[2] || 60);
const results = {};
for (const p of Object.keys(POLICIES)) {
  const rows = [];
  for (let i = 0; i < N; i += 1) {
    const seed = 1 + ((i * 2654435761) >>> 0) % 2147483646;
    const r = play(seed, p);
    const rep = sim.akReplay(seed, r.inputs);
    if (!rep.ok || rep.rawScore !== r.st.score || rep.ticks !== r.st.tick) {
      check(`replay reproduces a live ${p} round`, false, `seed ${seed}`);
    }
    rows.push({ score: r.st.score, ticks: r.st.tick, cleared: r.st.cleared, inputs: r.inputs.length / 2, maxLevelTicks: r.maxLevelTicks, lost: r.st.livesLost });
  }
  results[p] = rows;
  const sorted = rows.map(r => r.score).sort((a, b) => a - b);
  const q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  const avg = k => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  console.log(`  ${p.padEnd(8)} score p10 ${q(0.1)} · p50 ${q(0.5)} · p90 ${q(0.9)} · max ${sorted[sorted.length - 1]}`
    + ` · floors ${avg('cleared').toFixed(1)} · round ${(avg('ticks') * sim.AK_TICK_MS / 1000).toFixed(0)} s`
    + ` · inputs ${Math.max(...rows.map(r => r.inputs))} max · slowest floor ${(Math.max(...rows.map(r => r.maxLevelTicks)) * sim.AK_TICK_MS / 1000).toFixed(0)} s`);
}

const perfect = results.perfect;
check('a perfect bot reaches the sixth floor inside 5 minutes', perfect.some(r => r.cleared >= 5), `best ${Math.max(...perfect.map(r => r.cleared))} floors cleared`);
check('a perfect bot stays under AK_MAX_SCORE', perfect.every(r => r.score <= sim.AK_MAX_SCORE), `max ${Math.max(...perfect.map(r => r.score))} vs cap ${sim.AK_MAX_SCORE}`);
check('no floor ever takes longer than 150 s for the perfect bot (no ball traps)',
  perfect.every(r => r.maxLevelTicks * sim.AK_TICK_MS <= 150000), `${Math.max(...perfect.map(r => r.maxLevelTicks)) * sim.AK_TICK_MS / 1000} s`);
check('input logs fit AK_MAX_INPUTS', Object.values(results).flat().every(r => r.inputs <= sim.AK_MAX_INPUTS));
const decentMed = results.good.map(r => r.score).sort((a, b) => a - b)[Math.floor(N / 2)];
check('a decent player lands far below the cap', decentMed < sim.AK_MAX_SCORE / 3, `median ${decentMed}`);
// Round length is decided by SURVIVAL, and bots that read the bounce never die
// — so rather than pretend to model a human death rate, check the spread: a
// player who only chases the ball is out inside a minute, anyone who reads the
// bounce plays the full 5 minutes, and the score gap between them is real.
const rookieSec = results.rookie.reduce((s, r) => s + r.ticks, 0) / N * sim.AK_TICK_MS / 1000;
check('a chasing first-timer is out inside a minute', rookieSec < 60, `${rookieSec.toFixed(0)} s`);
const med = p => results[p].map(r => r.score).sort((a, b) => a - b)[Math.floor(N / 2)];
check('reading the bounce is worth ≥10× chasing it', med('casual') >= 10 * med('rookie'), `${med('casual')} vs ${med('rookie')}`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
