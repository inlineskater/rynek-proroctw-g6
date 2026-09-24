# „Automat Monet G6" 🪙 — the physical coin pusher (`coinpusher`)

A real rigid-body coin pusher. Every coin is a Rapier body, the pusher is a
kinematic block that moves coins only by contact, and what falls off the front
edge is decided by the solver. Nothing is scripted, teleported or steered.

| Layer | File |
|---|---|
| Physics core (no DOM; runs in the browser **and** under Node) | `games/coinpusher-core.js` |
| View, HUD, audio, network (lazy tab module) | `tabs/coinpusher.js` |
| Money | `supabase/functions/coinpusher-action/index.ts` |
| Schema | `supabase/coinpusher.sql` |
| Harness (stress, settle, RTP) | `scripts/coinpusher-sim.mjs` |

## Why the physics can be real and the money still safe

The spec wants two things that fight each other: "physics decides what falls"
and "never trust the client with rewards". The server cannot see a coin fall.
Re-running the physics server-side would mean simulating 150–300 bodies inside
an Edge Function with a ~2 s CPU budget, for every drop, with the pusher
running continuously. That is not a realistic design.

So the server doesn't verify physics. It **bounds the claim**. Each player owns
one persistent machine, and every coin in it is a `coinpusher_coins` row with a
server-issued id and value:

- `drop` debits the stake and inserts a coin worth the stake.
- `collect` pays each claimed id **once**, via a status-guarded
  `UPDATE … WHERE status = 'in_machine'`, and only if the coin is in the
  caller's machine.
- Gutter coins are the house's, which is the edge any real arcade pusher has.
  `RECYCLE` (40 %) of their value goes into that machine's `house_bank`; the
  rest is burned.
- Everything that is not a stake comes out of `house_bank` at the moment it is
  issued: refills, 🟡 gold coins (5 × stake), 💎 jackpot tokens, 🌧️ coin rain.

Over a machine's whole life, therefore:

    paid out  ≤  stakes dropped in  +  one starter pile (140 × 1 🪙)

A modified client that claims every coin as a prize gets exactly its own
stakes back. It never loses to the gutters, so its bank stays empty and it
never sees a special. Measured against Postgres: 3 000 staked, 3 140 paid.

⚠️ **Never fund anything in this game from outside the player's own machine**
(no shared jackpot pool, no minted bonus). A modified client can claim any coin
the instant it exists, so the per-machine closed loop *is* the safety argument.

### The rules that keep the loop closed

- **Lease.** `state` hands the tab a lease and every write must carry it.
  Otherwise two tabs would simulate the same coins twice and race to claim
  them.
- **Idempotent drops.** `unique(user_id, request_id)` makes a retried drop
  return its original coin. The duplicate check runs *before* the rate limit,
  or a retried success would be refused and its coin never spawned.
- **Token bucket, not a fixed gap**: 4/s with a burst of 3, because network
  jitter compresses honest 250 ms drops.
- **Prizes only while the motor could be running.** The client starts with the
  pusher parked and parks it 60 s after the last drop. The server accepts
  prizes for 150 s after a drop. A refused prize stays in the machine and is
  back on the next load. Together with "settle with collection off", this
  means **reloading can never shake coins loose for free**.
- **`lost` is booked exactly like `gutter`**, so it is never a free choice of a
  better return.
- **`BANK_CAP` = 3 000**: the bank is float, not a vault; overflow is burned.

## Stats: one row per session, booked at settlement

A drop writes **no** stats row. `collect` adds to the player's open
`coinpusher_spins` session row:

- `bet += Σ funded` of the resolved coins (what they cost the player; 0 for
  starter, refill and rain coins)
- `total_won += Σ value` of the prize coins

`sum(bet − total_won)` is then real house net, so `hazard_stats`,
`game_transactions`, `coin-inflow-stats.sql`, `economy_stats()` and the farm's
`farm_burn_per_day()` all take it unchanged.

⚠️ Per-drop rows were the first design and are wrong. They book every coin in
the machine as burned the moment it goes in, and 0.9 × casino burn funds the
farm NPC budget (docs/anti-inflation.md). A session closes after 8 min of quiet
(the feed's `SESSION_GAP_MS`), at Warsaw midnight, and when the amulet flips.
It is deliberately not in `bank.sql`'s casino-share basis, which floors each
day at 0: a machine can hold coins across days.

## The machine

Units are cm (gravity −981). +z points at the player.

- **Tier 1** is the top of the pusher block. Coins drop onto it from the slot.
  A fixed **wiper** hangs 0.5 mm above it with a **square** lower edge. ⚠️ A
  rounded (capsule) edge was shipped briefly and is wrong: it presses each coin
  *down* onto the moving block, friction locks the coin to the block, and
  tier 1 stops feeding tier 2. Measured: the upper tier hoarded ~200 coins and
  only ~35 % of exits went over the front, against ~86 % with the square
  edge.
- **Tier 2** is the bed. As the block retracts, the wiper holds tier-1 coins,
  so they migrate to the block's front edge and fall; the block's front face
  then shoves the bed pile toward the prize edge.
- **Side gutters** open past `gutterStartZ`. Separators divide each gutter lane
  from the prize chute, and each outlet has its own volume.
- **Collection.** A coin counts only when its whole bounding sphere is
  `collectDepth` below the bed. In front of the separator it is a prize;
  anywhere else (a gutter, the rear return behind the block, a coin that
  bounced under the bed) it is the house's.
- **Pusher.** It is crank-driven: each stroke is a half-cosine with pauses at
  both ends. It is driven only by `setNextKinematicTranslation`, and only when
  its target actually changes: re-issuing an unchanged target wakes every coin
  touching it.
- **Coins.** Every ordinary coin (1 🪙 house coin, every stake, gold) is the
  **same body**. A bigger 50 🪙 coin would make the return depend on the
  stake. Looks differ; physics doesn't. The jackpot token is the one
  deliberately different object: big and heavy.

### Tuning notes (measured, not guessed)

| Knob | Value | Why |
|---|---|---|
| `dt` | 1/120 | At 1/60 a pile of 3 mm coins leaning on each other never stops rocking: mean angular speed after 8 s was 0.035 rad/s at 60 Hz against 0.008 at 120 Hz. With 4 solver iterations it is also **cheaper** per simulated second, because contacts converge. |
| `lengthUnit` | 5 | Rapier's tolerances and sleep thresholds scale with it. In cm the default (1) treats a settled coin twitching at 0.002 cm/s as moving, so nothing ever sleeps. |
| `wiperGap` | 0.05 | At 0.12 the wiper and the moving block squeezed a coin 0.15 cm into the block until it slipped under. |
| wiper edge | square | A rounded edge pins coins to the block (see above): the machine stops paying. |
| clinks | velocity change | Contact-force events fire every step for every resting coin: a coin carries its own weight, ~14 000 dyn. Audio uses per-step Δv > 35 cm/s instead, throttled to 2 per frame. |
| turbo | UI only | Turbo speeds up auto-drop and count-ups, never the pusher: the machine's return must not depend on a UI toggle. |

## Return (RTP)

Measured by `scripts/coinpusher-sim.mjs --rtp`, which runs the **real** core
and reads the policy constants out of the Edge Function source. RTP is
`paid / (staked − Δfloat)`, where float is the coin value still sitting in the
machine or its bank at the end of the run.

RTP_TABLE

The drop position is the only skill and the only strategy. Every strategy
stays below 100 %.

## Performance

About 1.3–2.5 ms per 120 Hz step at 150–190 coins in Node. The equilibrium pile
is ~150–180 coins. The browser picks LOW/MEDIUM/HIGH/ULTRA from device class,
and steps down once if the first 3 s average under 38 fps. Only pixels, shadows
and particle counts change; physics is identical at every quality. A device
that can't keep up runs the machine in slow motion (max 8 steps per frame)
rather than taking bigger steps.

## Run order

1. `supabase/coinpusher.sql`
2. Re-run `hazard-views.sql`, `coin-inflow-stats.sql`, `economy-stats.sql` and
   `last-active.sql`. All four gained a coinpusher branch.
3. `supabase functions deploy coinpusher-action`
4. Push the frontend. It needs the CSP's `'wasm-unsafe-eval'` for Rapier's
   inlined WebAssembly, and that is already in `index.html`.

## Verifying

```
npm i --no-save @dimforge/rapier3d-compat@0.20.0   # anywhere; the repo has no package.json
RAPIER_PATH=…/node_modules/@dimforge/rapier3d-compat node scripts/coinpusher-sim.mjs --settle
RAPIER_PATH=… node scripts/coinpusher-sim.mjs --stress --coins 300 --minutes 3
RAPIER_PATH=… node scripts/coinpusher-sim.mjs --rtp [--strategy uniform|centre|edges|left] [--luck]
```

Debug overlay and tuning panel: be an admin, or add `?cpdebug` to the URL,
then open „?". It shows render/physics rates, step time, awake bodies, pusher
phase, exits and pending claims. It toggles the win/gutter volumes and the
collider wireframes, and has live sliders with SAVE/RESET (stored locally,
this browser only).
