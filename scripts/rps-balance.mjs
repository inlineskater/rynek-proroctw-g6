// Balance harness for „Papier, Kamień, Biuro G6" (rps). Extracts the rules and
// the bot straight from supabase/functions/rps-action/index.ts (no third copy)
// and plays thousands of matches against it with a few player policies.
// Usage: node scripts/rps-balance.mjs [matches]
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../supabase/functions/rps-action/index.ts', import.meta.url), 'utf8');
const a = src.indexOf('const RPS_W'), b = src.indexOf('// ── Plumbing');
const R = new Function(src.slice(a, b) + '\nreturn { newState, legalMoves, applyMove, passTurn, runBot, resolveFight, rpsScore, viewFor, RPS_BEATS, RPS_FIGHTERS, rnd };')();
const N = Number(process.argv[2] || 2000);

const policies = {
  random(st) { const m = R.legalMoves(st, 0); return m[R.rnd(m.length)]; },
  // Uses only what viewFor() shows: attack revealed pieces it beats, avoid
  // ones that beat it, otherwise advance and poke unknown never-moved pieces.
  greedy(st) {
    const v = R.viewFor(st);
    let best = null, bs = -1e9;
    for (const [f, t] of R.legalMoves(st, 0)) {
      const me = v.cells[f], tg = v.cells[t];
      let s = Math.random() * 10;
      if (tg) {
        if (tg.t === 'T') s -= 1000;
        else if (tg.t) s += R.RPS_BEATS[me.t] === tg.t ? 120 : R.RPS_BEATS[tg.t] === me.t ? -150 : 5;
        else s += 30 + (tg.m ? 0 : 15) + (t < 7 ? 20 : 0);
      } else s += (Math.floor(f / 7) - Math.floor(t / 7)) * 8;
      if (s > bs) { bs = s; best = [f, t]; }
    }
    return best;
  },
};

for (const [name, pick] of Object.entries(policies)) {
  let won = 0, total = 0, plies = 0, maxPlies = 0; const reasons = {};
  for (let g = 0; g < N; g++) {
    const home = [28,29,30,31,32,33,34,35,36,37,38,39,40,41];
    const flag = 35 + R.rnd(7); let trap; do { trap = home[R.rnd(14)]; } while (trap === flag);
    const st = R.newState(flag, trap);
    let guard = 0;
    while (!st.result && guard++ < 2000) {
      const ev = [];
      if (st.pending) {
        const { from, to, att } = st.pending;
        st.cells[att === 0 ? from : to].t = R.RPS_FIGHTERS[R.rnd(3)];
        st.cells[att === 0 ? to : from].t = R.RPS_FIGHTERS[R.rnd(3)];
        st.pending = null;
        if (R.resolveFight(st, from, to, ev) !== 'tie') { R.passTurn(st, att); R.runBot(st, ev); }
        continue;
      }
      const [f, t] = pick(st);
      if (R.applyMove(st, 0, f, t, ev) !== 'tie') { R.passTurn(st, 0); R.runBot(st, ev); }
    }
    if (!st.result) throw new Error('match did not end');
    if (st.result === 'won') won++;
    total += R.rpsScore(st); plies += st.plies; maxPlies = Math.max(maxPlies, st.plies);
    reasons[st.result + ':' + st.reason] = (reasons[st.result + ':' + st.reason] || 0) + 1;
  }
  console.log(`${name.padEnd(7)} win ${(100 * won / N).toFixed(1)}%  avg score ${(total / N).toFixed(0)}  avg plies ${(plies / N).toFixed(0)} (max ${maxPlies})`, reasons);
}
