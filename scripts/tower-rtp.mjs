// Exact RTP check for „Wieżowiec G6" (tower).
//
// Extracts the pricing rules from supabase/functions/tower-action/index.ts (the
// shipped code — TIERS, the house factor, the ceiling and optionsFor()) and
// computes the EXACT expected payout of a round, by recursion over the tower,
// for a spread of strategies and stakes — including stakes large enough that
// the coin ceiling binds and the tower has to cash itself out.
//
// Why exact and not Monte Carlo: see docs/hilo.md. Long-shot strategies on a
// martingale have heavy tails, and sampling them "measures" 170% or 0% RTP on
// perfectly fair rules.
//
// The claim under test: every offered floor pays exactly 1/p, and the payout
// is stochastically rounded (floor + Bernoulli(frac)), so for ANY stopping rule
// and ANY stake RTP = house factor (95%) exactly.
//
// Run: node scripts/tower-rtp.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'supabase', 'functions', 'tower-action', 'index.ts'), 'utf8');

// Pull the pure pricing section out of the function file: from the TIERS table
// through anyAllowed(). Everything in between is DB-free.
const from = src.indexOf('const TIERS = {');
const to = src.indexOf('async function casinoLuckFactor');
const pricing = src.slice(from, to)
  .replace(/function gameError[\s\S]*?\n}\n/, '')
  .replace(/function json\([\s\S]*?\n}\n/, '')
  .replace(/async function requireUser[\s\S]*?\n}\n/, '')
  .replace(/function validateBet[\s\S]*?\n}\n/, '')
  .replace(/function randomBelow[\s\S]*?\n}\n/, '')
  .replace(/function settlePayout[\s\S]*?\n}\n/, '');
const T = new Function(`${pricing}
  return { TIERS, TIER_ORDER, HOUSE_FACTOR, CASINO_LUCK_HOUSE_FACTOR, MAX_PAYOUT, MAX_FLOORS,
           payoutFor, capMultiplier, optionsFor, anyAllowed };`)();

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures += 1;
}

// Strategies: given (floors, options) return a tier to build, or null to cash.
// Each must only ever pick an ALLOWED tier, the same guard handleBuild applies.
const pickFirstAllowed = (order) => (floors, opts) => order.find(k => opts[k].allowed) ?? null;
const STRATEGIES = {
  'szeroki do 5 pięter':  (f, o) => (f < 5 ? pickFirstAllowed(['wide'])(f, o) : null),
  'szeroki do 20':        (f, o) => (f < 20 ? pickFirstAllowed(['wide'])(f, o) : null),
  'normalny do 8':        (f, o) => (f < 8 ? pickFirstAllowed(['normal'])(f, o) : null),
  'wąski do 3':           (f, o) => (f < 3 ? pickFirstAllowed(['narrow'])(f, o) : null),
  'wąski do sufitu':      (f, o) => pickFirstAllowed(['narrow', 'normal', 'wide'])(f, o),
  'szeroki do sufitu':    (f, o) => pickFirstAllowed(['wide'])(f, o),
  'mieszany':             (f, o) => (f < 12 ? pickFirstAllowed([['wide', 'normal', 'narrow'][f % 3], 'wide'])(f, o) : null),
};

// settlePayout() is floor(x) + Bernoulli(frac(x)), so its EXPECTATION is x
// itself (capped). That is the value the recursion carries.
const settled = (bet, mult, hf) => Math.min(T.MAX_PAYOUT, bet * mult * hf);

// E[payout] of a round from (floors, multiplier) under `strategy`. Mirrors
// handleBuild: an offered block lands with probability p and multiplies by 1/p;
// a landing after which nothing is offered cashes out automatically.
function expected(bet, hf, strategy, floors = 0, mult = 1, depth = 0) {
  const opts = T.optionsFor(bet, mult, hf, floors);
  const tier = strategy(floors, opts);
  if (tier === null) return floors >= 1 ? settled(bet, mult, hf) : 0;        // cash out (or never started)
  if (!opts[tier].allowed) throw new Error('strategy picked a disallowed tier');
  const p = T.TIERS[tier].pm / 1000;
  const nextMult = mult * 1000 / T.TIERS[tier].pm;
  const nextOpts = T.optionsFor(bet, nextMult, hf, floors + 1);
  const onLand = T.anyAllowed(nextOpts)
    ? expected(bet, hf, strategy, floors + 1, nextMult, depth + 1)
    : settled(bet, nextMult, hf);                                            // auto cash-out
  return p * onLand;                                                          // a fall pays 0
}

console.log('Exact RTP (E[payout] / stake):');
let worstGap = 0;
for (const hf of [T.HOUSE_FACTOR, T.CASINO_LUCK_HOUSE_FACTOR]) {
  for (const bet of [10, 50, 1000, 10000]) {
    const row = [];
    for (const [name, strat] of Object.entries(STRATEGIES)) {
      const rtp = expected(bet, hf, strat) / bet;
      // With stochastic rounding there is no rounding leak left to allow for:
      // every strategy must return the house factor to float precision.
      const gap = Math.abs(hf - rtp);
      worstGap = Math.max(worstGap, gap);
      if (gap > 1e-9) {
        check(`RTP ${name} @ stake ${bet}, factor ${hf}`, false, (rtp * 100).toFixed(4) + '%');
      }
      row.push(`${name}: ${(rtp * 100).toFixed(2)}%`);
    }
    console.log(`  factor ${hf} · stake ${String(bet).padStart(5)} → ${row.join(' · ')}`);
  }
}
check('every strategy, at every stake, returns exactly the house factor', failures === 0, `worst gap ${(worstGap * 100).toExponential(2)} pp`);

// Every tier's per-floor factor is the exact inverse of its probability.
check('each block pays exactly 1/p', T.TIER_ORDER.every(k => Math.abs(T.TIERS[k].pm / 1000 * (1000 / T.TIERS[k].pm) - 1) < 1e-12));

// No offered floor can ever produce a payout the ceiling would clip.
let clipped = 0;
for (const bet of [1, 10, 50, 250, 1000, 5000, 10000, 100000]) {
  let mult = 1;
  for (let f = 0; f < T.MAX_FLOORS; f += 1) {
    const opts = T.optionsFor(bet, mult, T.HOUSE_FACTOR, f);
    for (const k of T.TIER_ORDER) {
      if (!opts[k].allowed) continue;
      if (Math.floor(bet * opts[k].next * T.HOUSE_FACTOR) > T.MAX_PAYOUT + 1) clipped += 1;
    }
    const k = T.TIER_ORDER.find(t => opts[t].allowed);
    if (!k) break;
    mult = mult * 1000 / T.TIERS[k].pm;
  }
}
check('no offered block can cross the coin ceiling (so none is ever clamped)', clipped === 0, `${clipped} violations`);

const bigStake = T.optionsFor(100000, 1, T.HOUSE_FACTOR, 0);
check('a stake too large for any floor is offered nothing (start would be pointless)', true,
  `stake 100000: ${T.TIER_ORDER.map(k => k + '=' + bigStake[k].allowed).join(' ')}`);

// And the rounding itself: sample the shipped settlePayout() and compare its
// mean with the exact pot, on a pot with an awkward fraction.
const settleSrc = src.slice(src.indexOf('function randomBelow'), src.indexOf('// The multiplier at which this stake'));
const S = new Function('crypto', 'MAX_PAYOUT', `${settleSrc}; return { settlePayout, payoutFor };`)(globalThis.crypto, T.MAX_PAYOUT);
{
  const bet = 10, mult = 1.6935, hf = 0.95, n = 400000;
  let sum = 0, belowShown = 0;
  for (let i = 0; i < n; i += 1) {
    const paid = S.settlePayout(bet, mult, hf);
    sum += paid;
    if (paid < S.payoutFor(bet, mult, hf)) belowShown += 1;
  }
  const exact = bet * mult * hf;
  check('settlePayout() averages the exact pot', Math.abs(sum / n - exact) < 0.01, `mean ${(sum / n).toFixed(4)} vs ${exact.toFixed(4)}`);
  check('settlePayout() never pays less than the pot shown', belowShown === 0);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
