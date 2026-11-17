// Balance + rules harness for „Ostatnia Karta G6" (last_card). Extracts the
// rules and the bots straight from supabase/functions/last-card-action/index.ts
// (no third copy) and plays thousands of matches with a few player policies.
// It also checks invariants every match: 108 cards always accounted for, the
// match always ends, the player's turn count never runs backwards.
// Usage: node scripts/last-card-balance.mjs [matches]
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../supabase/functions/last-card-action/index.ts', import.meta.url), 'utf8');
const a = src.indexOf('const LC_SEATS'), b = src.indexOf('// ── Plumbing');
const R = new Function(src.slice(a, b) + '\nreturn { newState, fits, playCard, drawForTurn, endTurn, runBots, botPick, bestColor, finish, lcScore, viewFor, isWild, LC_COLORS, rnd };')();
const N = Number(process.argv[2] || 3000);

const total = st => st.deck.length + st.discard.length + st.hands.reduce((s, h) => s + h.length, 0);

// Each policy sees only viewFor() (what the client gets) and returns
// { card, color } or null (draw). `forget` is the chance to miss the call.
const policies = {
  random: { forget: 0, pick(v, st) {
    const ok = v.hand.filter(c => R.fits(st, c));
    if (!ok.length) return null;
    const card = ok[R.rnd(ok.length)];
    return { card, color: R.LC_COLORS[R.rnd(4)] };
  } },
  // The bots' own heuristic, applied to the player's hand.
  botlike: { forget: 0, pick(v, st) {
    const card = R.botPick(st, 0);
    return card ? { card, color: R.bestColor(st.hands[0].filter(c => c !== card)) } : null;
  } },
  forgetful: { forget: 0.5, pick(v, st) { return policies.botlike.pick(v, st); } },
};

for (const [name, P] of Object.entries(policies)) {
  let won = 0, turnsWon = 0, minTurns = 1e9, score = 0, maxPlies = 0;
  const places = [0, 0, 0, 0, 0], reasons = {};
  for (let g = 0; g < N; g++) {
    const st = R.newState();
    let guard = 0, lastTurns = 0;
    while (!st.result) {
      if (guard++ > 5000) throw new Error('match did not end');
      if (st.turn !== 0) throw new Error('not the player\'s turn after runBots');
      const ev = [];
      const v = R.viewFor(st);
      const choice = P.pick(v, st);
      if (choice) {
        if (!st.drawn) st.turns++;
        st.played++;
        R.playCard(st, 0, choice.card, choice.color, Math.random() >= P.forget, ev);
      } else {
        st.turns++;
        if (R.drawForTurn(st, 0, ev)) {
          const c = st.drawn;
          R.playCard(st, 0, c, R.bestColor(st.hands[0]), Math.random() >= P.forget, ev);
          st.played++;
        }
      }
      R.runBots(st, ev);
      if (total(st) !== 108) throw new Error('card count drifted: ' + total(st));
      if (st.turns < lastTurns) throw new Error('turns ran backwards');
      lastTurns = st.turns;
    }
    if (st.result === 'won') { won++; turnsWon += st.turns; minTurns = Math.min(minTurns, st.turns); }
    places[st.place]++;
    score += R.lcScore(st);
    maxPlies = Math.max(maxPlies, st.plies);
    reasons[st.reason] = (reasons[st.reason] || 0) + 1;
  }
  console.log(`${name.padEnd(9)} win ${(100 * won / N).toFixed(1)}%  turns/win ${(turnsWon / Math.max(1, won)).toFixed(1)} (best ${minTurns})  avg score ${(score / N).toFixed(0)}  places 1-4 ${places.slice(1).map(p => (100 * p / N).toFixed(0) + '%').join('/')}  max plies ${maxPlies}`, reasons);
}
