#!/usr/bin/env node
// Headless harness for „Automat Monet G6" (games/coinpusher-core.js).
//
// Loads the REAL physics core from source (via vm — no second copy to drift)
// and runs it under Node with the same Rapier build the browser gets.
//
//   node scripts/coinpusher-sim.mjs --stress [--coins 300] [--minutes 5]
//       Keeps N coins in the machine for N simulated minutes and asserts:
//       no NaN, no runaway velocity, no coin through the bed, bounded
//       body/pool counts, and reports step time.
//   node scripts/coinpusher-sim.mjs --rtp [--drops 4000] [--warmup 600] [--interval 0.6]
//       A bot drops a coin every `interval` s at a random x. After a warm-up
//       (the pile finds its equilibrium), counts where every coin that leaves
//       ends up. prize / (prize + gutter) is the physical return; docs/coinpusher.md
//       explains how the server turns that into RTP.
//   node scripts/coinpusher-sim.mjs --settle
//       Asserts the 140-coin starter pile lays out and falls asleep with
//       nothing leaving the machine.
//
// Rapier is not a repo dependency (the repo has no package.json). Point
// RAPIER_PATH at an installed @dimforge/rapier3d-compat, or run from a
// directory where `npm i @dimforge/rapier3d-compat@0.20.0` has been done.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? Number(args[i + 1]) : d; };

function loadRapier() {
  const req = createRequire(join(process.cwd(), 'noop.js'));
  const tries = [process.env.RAPIER_PATH, '@dimforge/rapier3d-compat'].filter(Boolean);
  for (const t of tries) { try { return req(t); } catch (_) {} }
  console.error('Rapier not found. Set RAPIER_PATH=/path/to/node_modules/@dimforge/rapier3d-compat');
  process.exit(2);
}

const RAPIER = loadRapier();
await RAPIER.init();
const ctx = { console, Math, Number, Map, Object, Array, String, Infinity };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(join(here, '..', 'games', 'coinpusher-core.js'), 'utf8'), ctx, { filename: 'coinpusher-core.js' });
const Core = ctx.CoinPusherCore;

let nextId = 1;
const coinOf = (kind, value) => ({ id: String(nextId++), kind, value });

function check(sim, where) {
  const M = sim.cfg.machine;
  let maxV = 0;
  for (const coin of sim.coins.values()) {
    const t = coin.body.translation(), v = coin.body.linvel();
    if (![t.x, t.y, t.z, v.x, v.y, v.z].every(Number.isFinite)) throw new Error(`${where}: NaN on coin ${coin.id}`);
    const s = Math.hypot(v.x, v.y, v.z);
    if (s > maxV) maxV = s;
    // Through the bed: below the bed surface while above the bed footprint.
    if (t.y < -M.bedThickness - 0.2 && Math.abs(t.x) < M.halfWidth - coin.r && t.z < M.bedFrontZ - coin.r && t.z > M.bedBackZ + 1)
      throw new Error(`${where}: coin ${coin.id} fell through the bed at ${t.x.toFixed(2)},${t.y.toFixed(2)},${t.z.toFixed(2)}`);
  }
  if (maxV > 800) throw new Error(`${where}: runaway velocity ${maxV.toFixed(0)} cm/s`);
  return maxV;
}

function starter(sim, n = 140, seed = 1) {
  const list = Array.from({ length: n }, () => coinOf('house', 1));
  sim.layoutPile(list, seed);
  sim.settle(6);
}

if (flag('settle')) {
  const sim = Core.cpCreateSim(RAPIER, {});
  let left = 0;
  sim.onCollect = () => { left++; };
  starter(sim);
  const awake = sim.restlessCount();
  check(sim, 'settle');
  console.log(`starter: ${sim.coins.size} coins, ${awake} still moving after settle, ${left} left the machine`);
  if (left) { console.error('FAIL: coins left the machine during settle'); process.exit(1); }
  if (awake > 10) { console.error('FAIL: pile did not come to rest'); process.exit(1); }
  console.log('OK');
}

if (flag('stress')) {
  const target = opt('coins', 300), minutes = opt('minutes', 5);
  const sim = Core.cpCreateSim(RAPIER, {});
  starter(sim, Math.min(target, 160), 3);
  const rnd = Core.cpRng(99);
  const steps = Math.round(minutes * 60 / sim.cfg.physics.dt);
  let worst = 0, total = 0, maxV = 0, pooled = 0;
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) {
    // Keep the machine at `target` coins: drop one every 0.2 s while below it.
    if (i % 12 === 0 && sim.coins.size < target) {
      sim.dropCoin(coinOf('standard', 10), (rnd() - 0.5) * 26, rnd);
    }
    const a = performance.now();
    sim.step();
    const d = performance.now() - a;
    total += d; if (d > worst) worst = d;
    if (i % 60 === 0) maxV = Math.max(maxV, check(sim, `t=${(i * sim.cfg.physics.dt).toFixed(1)}s`));
  }
  for (const p of Object.values(sim.pools)) pooled += p.length;
  const bodies = sim.world.bodies.len();
  console.log(`stress: ${minutes} min simulated in ${((performance.now() - t0) / 1000).toFixed(1)} s wall`);
  console.log(`  coins live ${sim.coins.size}, pooled ${pooled}, rapier bodies ${bodies}, awake ${sim.awakeCount()}`);
  console.log(`  step avg ${(total / steps).toFixed(2)} ms, worst ${worst.toFixed(1)} ms, max speed seen ${maxV.toFixed(0)} cm/s`);
  console.log(`  left machine: prize ${sim.stats.prize}, gutter ${sim.stats.gutter}, lost ${sim.stats.lost}`);
  if (sim.stats.lost) { console.error('FAIL: coins escaped the geometry'); process.exit(1); }
  if (bodies > sim.coins.size + pooled + 20) { console.error('FAIL: body leak'); process.exit(1); }
  console.log('OK');
}

if (flag('rtp')) {
  // ── Accounting model: a transcription-free mirror of coinpusher-action ────
  // Policy constants are READ from the Edge Function source, so the harness
  // measures the numbers that are actually deployed.
  const fn = readFileSync(join(here, '..', 'supabase', 'functions', 'coinpusher-action', 'index.ts'), 'utf8');
  const K = name => {
    const m = fn.match(new RegExp('const ' + name + ' = ([0-9_.]+)'));
    if (!m) throw new Error('constant not found in coinpusher-action: ' + name);
    return Number(m[1].replace(/_/g, ''));
  };
  const POL = {
    RECYCLE: K('RECYCLE'), LUCK: K('CASINO_LUCK_RECYCLE'), BANK_CAP: K('BANK_CAP'),
    GOLD_P: K('GOLD_P'), GOLD_MULT: K('GOLD_MULT'), JACKPOT_P: K('JACKPOT_P'),
    JACKPOT_MIN_MULT: K('JACKPOT_MIN_MULT'), JACKPOT_MAX_MULT: K('JACKPOT_MAX_MULT'),
    RAIN_P: K('RAIN_P'), RAIN_MIN: K('RAIN_MIN'), RAIN_MAX: K('RAIN_MAX'), RAIN_BANK_SHARE: K('RAIN_BANK_SHARE'),
  };
  const drops = opt('drops', 1200), warm = opt('warmup', 400), interval = opt('interval', 0.6);
  const stake = opt('stake', 10);
  // Aim strategies scale with the machine's drop rail.
  const W = Core.CP_CONFIG.drop.maxX;
  const strategies = {
    uniform: rnd => (rnd() - 0.5) * 2 * W,
    centre:  rnd => (rnd() - 0.5) * W * 0.25,
    edges:   rnd => (rnd() < 0.5 ? -1 : 1) * (W * 0.7 + rnd() * W * 0.3),
    left:    rnd => -W + rnd() * W * 0.3,
  };
  const only = args.includes('--strategy') ? args[args.indexOf('--strategy') + 1] : null;
  const recycle = flag('luck') ? POL.LUCK : POL.RECYCLE;
  console.log(`rtp: stake ${stake}, recycle ${recycle}, ${warm} warm-up + ${drops} counted drops every ${interval}s`);
  for (const [name, aim] of Object.entries(strategies)) {
    if (only && only !== name) continue;
    const sim = Core.cpCreateSim(RAPIER, {});
    const rnd = Core.cpRng(4242);
    const roll = n => Math.floor(rnd() * n);
    let bank = 0, counting = false;
    const acc = { staked: 0, paid: 0, burned: 0, prize: 0, gutter: 0, gold: 0, jackpot: 0, rain: 0 };
    const machineValue = () => { let v = 0; for (const c of sim.coins.values()) v += c.value; return v; };
    sim.onCollect = (coin, where) => {
      if (where === 'prize') { if (counting) { acc.paid += coin.value; acc.prize++; } return; }
      const back = Math.floor(coin.value * recycle);
      const kept = Math.min(back, Math.max(0, POL.BANK_CAP - bank));
      bank += kept;
      if (counting) { acc.burned += coin.value - kept; acc.gutter++; }
    };
    starter(sim, 140, 11);
    const every = Math.round(interval / sim.cfg.physics.dt);
    let n = 0, v0 = 0, b0 = 0;
    for (let i = 0; n < warm + drops; i++) {
      if (i % every === 0) {
        if (n === warm) { counting = true; v0 = machineValue(); b0 = bank; }
        // drop — same order and rules as handleDrop
        let kind = 'standard', value = stake;
        const r = roll(10000);
        if (r < POL.GOLD_P) {
          const extra = (POL.GOLD_MULT - 1) * stake;
          if (bank >= extra) { kind = 'gold'; value = POL.GOLD_MULT * stake; bank -= extra; }
        } else if (r < POL.GOLD_P + POL.JACKPOT_P) {
          const jp = Math.min(Math.floor(bank / 2), POL.JACKPOT_MAX_MULT * stake);
          if (jp >= POL.JACKPOT_MIN_MULT * stake) { kind = 'jackpot'; value = jp; bank -= jp - stake; }
        }
        if (counting) { acc.staked += stake; if (kind !== 'standard') acc[kind]++; }
        sim.dropCoin({ id: String(nextId++), kind, value }, aim(rnd), rnd);
        const rainN = Math.min(POL.RAIN_MAX, Math.floor(bank * POL.RAIN_BANK_SHARE / stake));
        if (rainN >= POL.RAIN_MIN && roll(10000) < POL.RAIN_P) {
          bank -= rainN * stake;
          if (counting) acc.rain++;
          for (let k = 0; k < rainN; k++) sim.dropCoin({ id: String(nextId++), kind: 'rain', value: stake }, (rnd() - 0.5) * 26, rnd);
        }
        n++;
      }
      sim.step();
      if (i % 600 === 0) check(sim, `rtp ${name} t=${(i / 60).toFixed(0)}s`);
    }
    for (let i = 0; i < 300; i++) sim.step();
    const dFloat = (machineValue() - v0) + (bank - b0);
    // Long-run return: what came out, over what went in net of the float that
    // is still sitting in the machine or its bank at the end of the run.
    const rtp = acc.paid / Math.max(1, acc.staked - dFloat);
    const exits = acc.prize + acc.gutter;
    console.log(`  ${name.padEnd(8)} RTP ${(100 * rtp).toFixed(1)}%  | front ${(100 * acc.prize / Math.max(1, exits)).toFixed(1)}% of exits`
      + ` | staked ${acc.staked} paid ${acc.paid} burned ${acc.burned} float Δ${dFloat}`
      + ` | gold ${acc.gold} jackpot ${acc.jackpot} rain ${acc.rain} | pile ${sim.coins.size}${sim.stats.clamped ? ' clamped ' + sim.stats.clamped : ''}`);
    sim.dispose();
  }
}
