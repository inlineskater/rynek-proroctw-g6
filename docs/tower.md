# „Wieżowiec G6" (`tower`) — a stacking casino game

`supabase/tower.sql` · `supabase/functions/tower-action` · `tabs/tower.js` · `scripts/tower-rtp.mjs`

A crane swings a block over your tower. Before every floor you pick the block —
and with it the risk — with the **true** probability printed on the button. It
lands: the pot multiplies by exactly the inverse of that probability and the
tower is a floor taller. It slides off: the tower comes down and the pot is gone.
Sell (cash out) whenever you have at least one floor.

| block | lands | × per floor |
|---|---|---|
| 🧱 Szeroki | 90% | ×1,11 |
| 🏢 Normalny | 70% | ×1,43 |
| 🗼 Wąski | 45% | ×2,22 |

Probabilities are stored in thousandths (`pm` 900/700/450) so a landing is an
exact integer comparison against an unbiased (rejection-sampled) `randomBelow(1000)`.

## Why it is option A (server luck), not a skill stacker

The classic Stacker is a timing game. As a casino game that is an open loop: a
player with good reflexes returns more than 100% and prints coins — the exact
failure docs/anti-inflation.md closed on the farm. So the drop is decided by the
server and the animation plays the result out; the player's decision is the
block (risk/variance), never the outcome. Timing is deliberately NOT an input —
a "tap to drop" that secretly ignored the tap would feel dishonest.

## The edge is taken once — the tower is a martingale

Same construction as Drabina Kariery (docs/hilo.md), same reasons: every floor
multiplies the pot by exactly `1/p`, so `E[pot after a floor] = pot`, and the 5%
is taken once, at cash-out. RTP is a flat 95% at any height and with any mix of
blocks; no strategy beats another, only the variance changes. **Never charge the
edge per floor** — it compounds to 0.54 over 12 floors.

## Two things Drabina Kariery gets slightly wrong, fixed here

**1. No clamping at the ceiling.** Hi-Lo clamps the multiplier when a step would
cross its coin ceiling, which makes that single step quietly unfair. Here a block
whose next multiplier would cross `capMultiplier(bet)` is **not offered** (the
button says „ponad sufit"), and when no block fits, the tower cashes itself out
(`result: "capped"`). Every offered floor pays its full fair `1/p`.

**2. No rounding leak.** `floor()` on the payout costs up to one coin per round,
which at a 10-coin stake is **3.5 points of RTP** (measured). `settlePayout()`
pays `floor(x)` plus one coin with probability `frac(x)` — stochastic rounding —
so `E[paid] = x` exactly, at every stake. The displayed pot (`payoutFor`) is the
floor, so a player is never paid less than the button said, only sometimes 1 🪙
more. ⚠️ If you port this to hilo-action, port both halves.

## Verification

`node scripts/tower-rtp.mjs` extracts the pricing code from the Edge Function
(not a copy) and computes the **exact** expected payout by recursion for seven
strategies × four stakes × both house factors (95% / 98% amulet), including
stakes large enough that the ceiling binds and the auto-cash-out fires. All
return the house factor to 2e-13. It also samples the shipped `settlePayout()`
(mean matches the exact pot; never below the shown pot). Do not verify this game
by Monte Carlo over long-shot strategies — see docs/hilo.md for why that
"measures" 170% or 0% on fair rules.

## Caps

`MAX_PAYOUT` 150 000 and `MAX_MULT` 100 000 (same as hilo), `MAX_FLOORS` 60,
stake chips 10…1000 (any stake 1…10 000 000 typed). One tower under construction
per player is a partial unique index, not app logic.

## Cosmetics that come from the server

Where a block settles (`offset`, ±0.30 of half a block for a landing, 0.62–0.92
past the edge for a fall) is rolled by the server and stored in `history`, so a
reloaded tower rebuilds exactly and the feed shows the same tower. The client
never influences it.

## Plumbing

`tower_spins` feeds Hazardista (`hazard_stats.tower_pl`, `game_transactions`),
coin inflow, `economy_stats()` house-net and the Biuro rail (`last-active.sql`).
It writes no `coin_transactions` rows, so none of the four coin-reason consumers
in CLAUDE.md need an entry. Amulet: house factor 0.98 while any casino-luck
instance is live. Its CSS is injected by `tabs/tower.js` (index.html payload
budget). Run order: `tower.sql`, then re-run `hazard-views.sql` +
`coin-inflow-stats.sql` + `economy-stats.sql` + `last-active.sql`, then
`supabase functions deploy tower-action`.
