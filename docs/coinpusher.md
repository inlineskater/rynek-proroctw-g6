# „Automat Monet G6" 🪙 — the physical coin pusher (`coinpusher`)

A real rigid-body coin pusher. Every coin is a Rapier body, the pusher is a
kinematic block that moves coins only by contact, and what falls off the front
edge is decided by the solver. Nothing is scripted, teleported or steered.

| Layer | File |
|---|---|
| Physics core (no DOM; runs in the browser **and** under Node) | `games/coinpusher-core.js` |
| View, HUD, audio, network (lazy tab module) | `tabs/coinpusher.js` |
| Money | `supabase/functions/coinpusher-action/index.ts` |
| Schema | `supabase/coinpusher.sql`, then `supabase/coinpusher-shared.sql` (the one shared machine) |
| Harness (stress, settle, RTP) | `scripts/coinpusher-sim.mjs` |

## Why the physics can be real and the money still safe

The spec wants two things that fight each other: "physics decides what falls"
and "never trust the client with rewards". The server cannot see a coin fall.
Re-running the physics server-side would mean simulating 150–300 bodies inside
an Edge Function with a ~2 s CPU budget, for every drop, with the pusher
running continuously. That is not a realistic design.

So the server doesn't verify physics. It **bounds the claim**. There is one
persistent machine (since 2026-09-25 a single shared one — see below), and
every coin in it is a `coinpusher_coins` row with a server-issued id, value and
**owner**:

- `drop` debits the stake and inserts a coin worth the stake.
- `collect` pays each claimed id **once**, via a status-guarded
  `UPDATE … WHERE status = 'in_machine'`, and always to the coin's **owner**,
  never to whoever reported it.
- Gutter coins are the house's, which is the edge any real arcade pusher has.
  `RECYCLE` (40 %) of their value goes into the machine's `house_bank`; the
  rest is burned.
- Everything that is not a stake comes out of `house_bank` at the moment it is
  issued: refills, 🟡 gold coins (5 × stake), 💎 jackpot tokens, 🌧️ coin rain.

Over a machine's whole life, therefore:

    paid out  ≤  stakes dropped in  +  the machine's one house pre-fill (the game's only mint)

A modified client that claims every coin as a prize gets exactly its own
stakes back. It never loses to the gutters, so its bank stays empty and it
never sees a special. Measured against Postgres: 3 000 staked, 3 140 paid.

⚠️ **Never fund anything in this game from outside the machine** (no pool fed
by other games, no minted bonus). A modified host can report any coin as fallen
the instant it exists, so the machine's closed loop *is* the safety argument.

### The rules that keep the loop closed

- **Host lease.** Only the holder of `coinpusher_shared.host_lease` may
  report exits, pockets or the pile's shape. Otherwise two browsers would
  simulate the same coins twice and race to claim them.
- **Idempotent drops.** `unique(user_id, request_id)` makes a retried drop
  return its original coin. The duplicate check runs *before* the rate limit,
  or a retried success would be refused and its coin never spawned.
- **Token bucket, not a fixed gap**: 8/s with a burst of 6, because network
  jitter compresses honest 250 ms drops.
- **Prizes only while the motor could be running.** The client starts with the
  pusher parked and parks it 60 s after the last drop. The server accepts
  prizes for 150 s after a drop. A refused prize stays in the machine and is
  back on the next load. Together with "settle with collection off", this
  means **reloading can never shake coins loose for free**.
- **`lost` is booked exactly like `gutter`**, so it is never a free choice of a
  better return.
- **`BANK_CAP` = 20 000**: the bank is float, not a vault; overflow is burned.

## One machine for everybody (2026-09-25)

Until 2026-09-25 every player had a private machine. Now there is **one
cabinet** that everyone sees and throws into together
(`supabase/coinpusher-shared.sql`).

### Who runs the physics

Supabase can't run a physics loop around the clock, so **one connected
player's browser, the host, simulates the machine** and streams it to everyone
else. Whoever holds `coinpusher_shared.host_lease` is the host.

- Every client calls `host_beat` every 3 s. The host renews its lease; a
  viewer takes over once the lease is 8 s stale. Phones (`pointer: coarse`)
  wait 16 s, so a desktop in the room wins the race. A phone still hosts if
  nobody else is there.
- **A host that leaves hands over at once.** Switching tabs, hiding the page
  or logging out (closing the tab too, via `visibilitychange`) flushes its
  exits, saves the pile and `resign`s the lease.
- **A resign frees the machine as if the lease had just lapsed.**
  `host_seen_at` is set 8.1 s back, so a desktop takes over on its next beat
  (measured ~3 s) and a phone only after its longer 16 s threshold (measured
  ~11 s). Resetting it to NULL instead handed the machine to whichever client
  beat first, usually a phone.
- **A host whose beats stop getting through stops by itself** after 6.5 s
  (`CP_HOST_SELF_DEMOTE_MS`), before the server's 8 s TTL hands the machine to
  someone else. Two hosts must never stream together. A frozen laptop is the
  real case; the local test rig reproduced it with 31 s frames.
- **Beats keep running while the machine loads.** Settling the pile and
  compiling shaders can take longer than a lease lasts.
- **Takeover continues the pile.** The new host rebuilds from what it last
  saw as a viewer (`cpNetLayout`) plus the authoritative coin list, and
  `resumeAt()` puts the pusher, discs, gates and tower exactly where the old
  host's last snapshot had them, so nothing is shoved on takeover. Coins the
  viewer never saw (thrown during the gap) are laid on top, like a reload.

### Who gets paid (the trust model)

- **A coin pays its owner**, the player who threw it, whichever browser
  reported the fall. Bonus coins from a pocket belong to the owner of the coin
  that hit the pocket.
- **Ownerless coins** (house pre-fill, refills, a tower shower with no recent
  thrower) go to the **most recent thrower within 30 s**, capped at
  **3 000 🪙/min** per player. With nobody eligible, they are booked like a
  gutter coin and recycled into the bank.
- **A coin must be ≥ 1.5 s old to leave.** No thrown coin physically falls
  faster than that.
- Every exit is written to `coinpusher_exits`: coin, owner, paid to, where,
  value, and the reporting host.

So a modified host can decide whether other people's coins fall, but it can't
take them. At most it can time house coins to fall right after its own throws,
and the per-minute cap bounds that. The machine as a whole still can't pay out
more than was thrown in plus its one pre-fill.

### The netcode

Money never travels peer to peer. `drop`, `collect` and `pocket` go through
the Edge Function, which announces them on the Realtime topic
`coinpusher_main` with a server-side REST broadcast:

- `spawn` `{coin, x, rain, nick}`: the host drops the coin; viewers show it in
  the slot until the stream picks it up.
- `paid` `{paid: {user: {amount, ids, nick, jackpot, gold}}, bank}`: your own
  win gets the full presentation; other players' wins float up as
  „Nick +300".
- `bonus` `{pocket, owner, nick, coins, bank}`: toasts and pocket lights.

Only the pile's *shape* travels between browsers:

- `snap` (host → viewers): `{e: stint id, u: host, h: host clock, t/mt: pusher
  and mechanism time, ta: tower angle, m: motor, k: keyframe, c: coins, r:
  exits}`. Coins are packed at 19 bytes each (`cpSnapEncode`: uint32 id, int16
  position in 1/100 cm, int16 quaternion, uint8 look), base64.
- A **keyframe** carries every coin; anything missing from it is gone. A
  **delta** carries only coins that moved more than 0.02 cm or 0.003 in any
  quaternion component.
- `need_key` (viewer → host): sent on joining and when a new host's stint
  starts.

Viewers render **0.35 s behind** the host and interpolate between the last
samples (slerp for rotation). They pose the kinematic parts with
`poseMechanics()` and never step the physics world. Two guards:

- a viewer accepts a stint's deltas only after that stint's keyframe;
- a viewer ignores snapshots from anyone but the host the server last named.

**Realtime quota.** The free plan includes 2 M messages a month.

- Snapshots go out at **4 Hz**, and only while the motor runs or something
  moves. They also stop when nobody is watching: the host learns the viewer
  count from its beat.
- An idle machine sends nothing, and hidden tabs leave the channel entirely.
- Rough cost: one host plus N viewers ≈ 4 × (1 + N) messages per second of
  active play. Two viewers for one hour is ~43 k messages.

The first thing to lower if the quota ever bites is `CP_SNAP_MS`.

### Polish: players strip, your coins, live feed

- **Players strip** (`cpNetRenderWho`, bottom centre of the stage): everyone
  at the machine now, i.e. `host_beat.players`, the players seen within
  `VIEWER_SEEN_S`. The host comes first and is marked 🖥️. Each chip shows the
  player's net for this session (`total_won − bet` of the open session row),
  and you are „Ty". Phones show three chips plus „+N".
- **Your coins glow.** A green ring (one extra `InstancedMesh`,
  `cpView.ring`) is drawn with the same matrices as every coin you own, on
  host and viewers alike.
  - Ownership comes from a client-side `cpNet.owners` map filled from
    `state.coins`, the drop answer, `spawn` (coin and its rain), the host's
    `pocket` answers, and `bonus`, whose payload carries `ids` for exactly
    this.
  - The map is pruned on every exit.
  - Normal blending, not additive: an additive glow disappears against
    polished metal.
  - It can be turned off in „?" (`cp.glow`).
- **Live feed** (`cpLive`, top left): the last six wins and bonuses, newest
  on top, fading with age.
  - It is fed by `paid` and `bonus`.
  - It is seeded on open from `state.recent`: the last 8 prize batches from
    `coinpusher_exits`, grouped by `(paid_to, created_at)`, since one collect
    is one transaction.
  - It lives in the stage, not the side column, because full-page mode covers
    the side column.

### Migration from private machines

`coinpusher-shared.sql` moves every coin still in a private machine into the
shared one, once.

- Player-thrown coins keep their owners.
- House pre-fill coins become ownerless.
- The private banks are pooled into the shared bank.
- The pile is capped at **320 coins**: every player coin moves in, and house
  pre-fill only up to that total. The excess is marked `retired`, a new status
  that is never paid and never counted as a house win. On 2026-09-25 prod held
  463 coins in 5 machines (343 house). At 463, one physics step costs ~4.5 ms
  of the 8.3 ms budget, and the overfull pile dumps ~270 coins in its first
  minute.
- The shared machine's own pre-fill is `SHARED_PREFILL` = 220, minus whatever
  migrated in, so the migrated pile adds nothing.

### Testing it locally

`coinpusher-action` runs unmodified under Node against local Postgres, with a
~60-line stand-in for Realtime (SSE fan-out that honours `self: false`, plus
the REST broadcast endpoint). Three Playwright pages play Ala, Bob and Carl
(Carl a touch phone). Checked:

- all three see the same 220 coins, then the same pile after 18 throws;
- at rest, viewer positions match the host's to within **0.03 cm**;
- every page shows its own server balance;
- killing the host's tab hands over to the desktop, not the phone, and the
  phone follows the new stream;
- a host that leaves properly hands over even to a phone.

Render at LOW quality and small viewports for this test. Three software-GL
pages on 4 cores freeze the host for 30 s at a time, which tests the takeover
path, not the netcode.

## Stats: one row per session, booked at settlement

A drop writes **no** stats row. `collect` adds, per player involved, to that
player's open `coinpusher_spins` session row — the owner of each resolved coin,
and whoever received a prize, whichever browser reported it:

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

## The big cabinet (2026-09-25)

The playfield is 48 cm wide (`halfWidth` 24), with four physical features, all
built from colliders in `games/coinpusher-core.js`:

- **Pin board.** Every thrown coin falls through a 0.8 cm slot between two
  panes and bounces through 5 rows of pins.
  - ⚠️ The gap that matters is **diagonal**, from a pin to its neighbours in the
    next row. 4.6 × 2.8 spacing left 3.06 cm there, less than the 3.3 cm coin,
    and 243 of 250 test coins jammed. 5.0 × 3.7 leaves ≥ 3.9 cm.
  - Pins also stay ≥ 4.4 cm from the side walls: every remaining jam was
    against a wall.
- **Pockets** under the last row: 🌧 rain (8 × 100), ★ a 1 000 coin, and
  🗼 the tower's mouth. The host only reports a pass; `coinpusher-action`'s
  `pocket` action pays from the bank. It only counts a coin the player paid
  for, dropped within 20 s, once (`pocketed_at`).
- **Moving parts:** a turntable in the bed, and two side gates that rise out of
  the bed for 45 % of a 7 s cycle.
- **Jackpot tower:** a kinematic bucket hinged at its front-bottom edge. At 6
  coins inside it tips and pours; the server adds an 18 × 100 shower from the
  bank (20 s cooldown, `last_tower_at`).
- **Cabinet:** a marquee on top, chase lights, and a live JACKPOT display
  (½ bank, capped at 10 000, the same rule the server uses).

Measured with the harness (stake 100, 250 warm-up + 500 counted drops):

| Aim | RTP | Exits over the front |
|---|---|---|
| uniform | **98.8 %** | 98.0 % |
| centre | **99.8 %** | 99.6 % |
| edges | **98.2 %** | 97.2 % |

Pocket and tower bonuses are bank-funded, so they're neutral here. The gates
keep nearly everything out of the gutters. That is the knob if the house edge
should grow: `gates.upFraction`, or `machine.gutterStartZ`. Still ≤ 100 % by
construction.

## One denomination: 100 🪙

Coins now fall into the machine fast (`drop.downSpeed` 140 cm/s), so spammed
coins land quickly. The 🟡 special is a **1 000 🪙 coin** (`GOLD_MULT` 10,
3 % of throws, with the 900 premium paid from the bank). Every coin the
machine adds by itself (refills, rain) is a 100 🪙 coin bought from the bank.
Every private machine was pre-filled once with 140 × 100 🪙 by the house. Since the shared machine (2026-09-25) it is one pre-fill of up to 220 × 100 for everybody, and the migrated private pre-fill counts towards it.


Every coin a player throws is a 100 🪙 coin: the server's stake list is just
`[100]`, and the stake picker becomes a fixed "100 🪙 / moneta" label. Coins
from the earlier 1–50 🪙 stakes still in a machine keep their value (and
their own design) until they fall out. `BANK_CAP` is 20 000, so a jackpot token
(half the bank, `JACKPOT_MAX_MULT` 100 × stake) tops out at **10 000 🪙**. It is
still paid only from that machine's own gutter losses, so it mints nothing.
The only control is WRZUĆ (no auto, no turbo): spamming it is the game,
allowed at 8/s with a burst of 6.

(The RTP table below was measured at stake 10. The physics doesn't care:
every ordinary coin is the same body, so what goes over the front is the same
share at any stake. Only how often the bank can afford a special shifts.)

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

- **Pin-board vibrator** (`pins.unjamAfter` = 2 s, `unjamPins()`):
  - About 1 coin in 60 rapid drops wedged in the pin field **for good**. A
    shared machine never resets, so a day of play would slowly fill the board.
  - A wedged coin is tilted out of the board's plane, its 3.3 cm diameter
    spanning the 0.8 cm slot between the panes, so a sideways flick alone just
    re-wedges it (37 flicks, still stuck).
  - Any coin that has sat still in the pin field for 2 s is now squared back
    into the plane (centred in the slot, 3 mm up) and flicked sideways.
  - Measured: 60 drops every 0.12 s or 0.45 s, 3 seeds each → 0 stuck (was
    1–2 per run).
  - It touches only the pin field, never the beds, so what falls off the front
    is still decided by the pusher alone. RTP after it (stake 100, 250 + 500
    drops): uniform 98.3 %, centre 99.1 %, edges 98.2 % (before: 98.8 / 99.8 /
    98.2).
  - The check runs over all coins every 30 ticks, because a wedged coin is
    usually asleep and the main loop skips sleepers.

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

Measured 2026-09-24 at 120 Hz with the square wiper: stake 10, `RECYCLE` 0.40,
300 warm-up + 600 counted drops, one every 0.6 s.

| Drop strategy | Over the front | RTP | Equilibrium pile |
|---|---|---|---|
| uniform across the rail | 81.6 % | **88.1 %** | 172 |
| centre (±3 cm) | 95.9 % | **98.9 %** | 156 |
| edges (9–13 cm out) | 71.8 % | **80.4 %** | 144 |
| hugging the left wall | 74.6 % | **81.6 %** | 147 |

Aiming at the centre keeps coins away from the gutters, and it is the only
skill in the game. It cannot go above 100 %: the loop is closed, so coins out
≤ coins in (plus the starter pile). The amulet (RECYCLE 0.70) moves every row
up by roughly (1 − front share) × 0.3. Knobs, if the house edge on centred
play (~1 %) is too thin: `gutterStartZ` (open the side edges earlier),
`gutterWidth`, `halfWidth`.

**Re-measured after the coins grew to r 1.65 cm (2026-09-24, stake 100, 250
warm-up + 500 counted drops):** uniform **95.8 %** (93.0 % of exits over the
front, pile 110), centre **97.9 %** (93.2 %, pile 86), edges **90.9 %** (85.2 %,
pile 105). Bigger coins make fewer, fatter columns, which the side gutters
catch less often. The equilibrium pile is ~90–110, so the 140-coin pre-fill
overflows at first: that overflow is the house's pre-fill gift.

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
2. `supabase/coinpusher-shared.sql` (idempotent; the migration runs only
   until the shared machine's first `state`).
3. Re-run `hazard-views.sql`, `coin-inflow-stats.sql`, `economy-stats.sql` and
   `last-active.sql`. All four gained a coinpusher branch.
4. `supabase functions deploy coinpusher-action`. The shared function needs
   step 2 first, and the old frontend's private-machine calls fail against it
   until the frontend is pushed, so deploy the two back to back.
5. Push the frontend. It needs the CSP's `'wasm-unsafe-eval'` for Rapier's
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
