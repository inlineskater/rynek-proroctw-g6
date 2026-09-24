// Balance harness for „Arkanoid G6" (arkanoid).
//
// Extracts the PARITY BLOCK from games/arkanoid.js (the shipped code, not a
// transcription) and drives it with bots of different skill, then asserts the
// invariants the design depends on:
//
//   • every level row is exactly AK_COLS wide and fits in AK_ROWS
//   • every breakable brick can be reached around the concrete walls ('X')
//   • no wall pocket holds a ball away from the paddle and the bricks for long
//   • every bounce direction has length ≈ 64 (constant ball speed)
//   • every floor, started fresh, is cleared by a perfect bot well inside the
//     5-minute round, and no ball ever bounces off walls alone for long (the
//     AK_STALL_* rule is what guarantees that; this checks it works)
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
           AK_BALL, AK_PADDLE_Y, AK_DIRS, AK_LEVELS, AK_STALL_TICKS, akInitState, akLoadLevel, akTick, akInput, akReplay };`)();

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
const badChars = [];
sim.AK_LEVELS.forEach((rows, li) => rows.forEach((r, ri) => {
  if (!/^[.1-6HSX]*$/.test(r)) badChars.push(`level ${li + 1} row ${ri + 1}`);
}));
check('level layouts use only known brick codes', badChars.length === 0, badChars.join('; '));
// Walls are the one thing a ball cannot go through, so a brick is reachable iff
// a 4-connected path of non-wall cells joins it to open field: the band above
// row 0 (AK_TOP > 0) or anything below the layout. Diagonal steps between two
// corner-touching walls are NOT a path — a 4-unit ball cannot pass a zero-width
// corner — which is exactly what 4-connectivity models.
const sealed = [];
sim.AK_LEVELS.forEach((rows, li) => {
  const R = rows.length, C = sim.AK_COLS;
  const wall = (r, c) => rows[r].charAt(c) === 'X';
  const seen = Array.from({ length: R }, () => new Array(C).fill(false));
  const queue = [];
  for (let c = 0; c < C; c += 1) {
    if (!wall(R - 1, c)) { seen[R - 1][c] = true; queue.push([R - 1, c]); }
    if (!wall(0, c) && !seen[0][c]) { seen[0][c] = true; queue.push([0, c]); }
  }
  while (queue.length) {
    const [r, c] = queue.shift();
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= R || nc < 0 || nc >= C || seen[nr][nc] || wall(nr, nc)) continue;
      seen[nr][nc] = true;
      queue.push([nr, nc]);
    }
  }
  rows.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch !== '.' && ch !== 'X' && !seen[r][c]) sealed.push(`level ${li + 1} r${r + 1}c${c + 1}`);
  }));
  if (!rows.join('').replace(/[.X]/g, '').length) sealed.push(`level ${li + 1} has no breakable brick`);
});
check('every breakable brick is reachable around the walls', sealed.length === 0, sealed.join('; '));
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
  // Ticks with a ball in flight since it last touched the paddle or a
  // breakable brick — i.e. time spent only bouncing off walls and the frame.
  let idle = 0, maxIdle = 0, lastHits = 0, lastPaddle = 0;
  while (!st.over) {
        let t = POLICIES[policyName](st, rnd, mem);
    if (t !== null && t !== undefined) {
      t = Math.max(0, Math.min(sim.AK_W, t));
      if (t !== st.target) { sim.akInput(st, t); inputs.push(st.tick, t); }
    }
    if (st.balls.some(b => b.stuck) && st.tick % 25 === 5) { sim.akInput(st, -1); inputs.push(st.tick, -1); }
    const livesBefore = st.lives;
    sim.akTick(st);
    const inFlight = st.balls.some(b => !b.stuck);
    if (!inFlight || st.levelHits !== lastHits || st.paddleHits !== lastPaddle || st.level !== lastLevel || st.lives !== livesBefore) idle = 0;
    else idle += 1;
    lastHits = st.levelHits; lastPaddle = st.paddleHits;
    if (idle > maxIdle) maxIdle = idle;
    if (st.level !== lastLevel) {
      maxLevelTicks = Math.max(maxLevelTicks, st.tick - levelStart);
      levelStart = st.tick; lastLevel = st.level;
    }
  }
  return { st, inputs, maxLevelTicks, maxIdle };
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
    rows.push({ score: r.st.score, ticks: r.st.tick, cleared: r.st.cleared, inputs: r.inputs.length / 2, maxLevelTicks: r.maxLevelTicks, maxIdle: r.maxIdle, lost: r.st.livesLost });
  }
  results[p] = rows;
  const sorted = rows.map(r => r.score).sort((a, b) => a - b);
  const q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  const avg = k => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  console.log(`  ${p.padEnd(8)} score p10 ${q(0.1)} · p50 ${q(0.5)} · p90 ${q(0.9)} · max ${sorted[sorted.length - 1]}`
    + ` · floors ${avg('cleared').toFixed(1)} · round ${(avg('ticks') * sim.AK_TICK_MS / 1000).toFixed(0)} s`
    + ` · inputs ${Math.max(...rows.map(r => r.inputs))} max · slowest floor ${(Math.max(...rows.map(r => r.maxLevelTicks)) * sim.AK_TICK_MS / 1000).toFixed(0)} s`
    + ` · longest wall-only bounce ${(Math.max(...rows.map(r => r.maxIdle)) * sim.AK_TICK_MS / 1000).toFixed(1)} s`);
}

const perfect = results.perfect;
check('a perfect bot clears at least two floors in a round', perfect.every(r => r.cleared >= 2), `worst ${Math.min(...perfect.map(r => r.cleared))} floors cleared`);
check('a perfect bot stays under AK_MAX_SCORE', perfect.every(r => r.score <= sim.AK_MAX_SCORE), `max ${Math.max(...perfect.map(r => r.score))} vs cap ${sim.AK_MAX_SCORE}`);
// A trap is a ball that bounces between walls and never comes back. The
// anti-stall rule re-aims such a ball after AK_STALL_TICKS, so no bot should
// ever see much more than that without a paddle or brick contact. Escaping can
// take a few re-aims (each lands only at the next wall bounce), hence 2×.
const stallLimit = sim.AK_STALL_TICKS * 2;
const worstIdle = Math.max(...Object.values(results).flat().map(r => r.maxIdle));
check('no ball bounces off walls alone for longer than the stall rule allows (no ball traps)',
  worstIdle <= stallLimit, `${(worstIdle * sim.AK_TICK_MS / 1000).toFixed(1)} s vs ${(stallLimit * sim.AK_TICK_MS / 1000).toFixed(1)} s`);

// Floors past the third are rarely reached inside 5 minutes, so the round-level
// bots never test them. Start the perfect bot ON each floor, with lives to
// spare, and check every one of them gets cleared.
const FLOOR_SEEDS = Math.max(6, Math.round(N / 6));
const floorRows = [];
for (let L = 0; L < sim.AK_LEVELS.length; L += 1) {
  const times = [];
  for (let k = 0; k < FLOOR_SEEDS; k += 1) {
    const seed = 1 + ((k * 2654435761 + L * 40503) >>> 0) % 2147483646;
    const st = sim.akInitState(seed);
    st.level = L; sim.akLoadLevel(st); st.lives = 99;
    const rnd = makeRnd(seed ^ 0x9e3779b9), mem = {};
    let idle = 0, maxIdle = 0, lastHits = 0, lastPaddle = 0;
    while (st.level === L && st.tick < sim.AK_MAX_TICKS) {
      const t = POLICIES.perfect(st, rnd, mem);
      sim.akInput(st, Math.max(0, Math.min(sim.AK_W, t)));
      if (st.balls.some(b => b.stuck)) sim.akInput(st, -1);
      sim.akTick(st);
      if (!st.balls.some(b => !b.stuck) || st.levelHits !== lastHits || st.paddleHits !== lastPaddle) idle = 0; else idle += 1;
      lastHits = st.levelHits; lastPaddle = st.paddleHits;
      if (idle > maxIdle) maxIdle = idle;
    }
    times.push({ s: st.level === L ? Infinity : st.tick * sim.AK_TICK_MS / 1000, idle: maxIdle });
  }
  const sorted = times.map(t => t.s).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  floorRows.push({ L, med, max: sorted[sorted.length - 1], idle: Math.max(...times.map(t => t.idle)) });
  const bricks = sim.AK_LEVELS[L].join('').replace(/[.X]/g, '').length;
  const walls = sim.AK_LEVELS[L].join('').replace(/[^X]/g, '').length;
  console.log(`  floor ${L + 1}: ${String(bricks).padStart(2)} bricks, ${String(walls).padStart(2)} walls · perfect bot clears it in p50 ${med.toFixed(0)} s, max ${sorted[sorted.length - 1].toFixed(0)} s`);
}
check('every floor, started fresh, is cleared inside the 5-minute round',
  floorRows.every(f => Number.isFinite(f.max)), floorRows.filter(f => !Number.isFinite(f.max)).map(f => `floor ${f.L + 1}`).join(', '));
check('no floor takes the perfect bot more than 150 s in a typical run',
  floorRows.every(f => f.med <= 150), floorRows.map(f => f.med.toFixed(0)).join(' / ') + ' s');
check('no wall pocket stalls a ball on any floor',
  floorRows.every(f => f.idle <= stallLimit), `${(Math.max(...floorRows.map(f => f.idle)) * sim.AK_TICK_MS / 1000).toFixed(1)} s`);
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
