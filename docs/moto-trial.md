# Moto Trial G6

Gravity Defied-style motorcycle trials (`moto_trial`). Physics v3, courses
`quarry_v3` (Kamieniołom) and `mountain_v3` (Górska Przełęcz).

Status: **local playtest**. Not yet on production. The first rewrite (v2) was a
two-dot Verlet stick with lean faked as vertical nudges and a Three.js line scene with a
repainted pixel sprite. It was unplayable, so v3 replaces the simulation, the
renderer and both courses. The backend contract is unchanged.

## Try it locally

```sh
python3 -m http.server 8770 --bind 127.0.0.1
```

Open **http://127.0.0.1:8770/games/moto-trial-local.html**. It needs no account, Supabase or
network, because there is no CDN dependency any more. **Wszystkie Gry → Moto Trial G6**
defaults to **Trening bez rankingu**, which is free, never touches the backend and keeps
local bests in the open tab only.

W/↑ throttle · S/↓ brake · A/← lean back · D/→ lean forward · R retry. Phones get four
touch buttons that can be held at the same time. Hiding the tab or blurring the window
ends the attempt and submits the progress reached. A pause would let you study an
official run, so there is none.

## Physics (games/moto-trial-core.js)

**Determinism rule:** the code is float64, but it may only use `+ − × ÷` and
`Math.sqrt/abs/min/max/floor/ceil`. IEEE-754 rounds those exactly, so Safari, Chrome and
Deno agree bit for bit. Rotation is a unit vector `(c, s)` that advances by a small angle
and is then renormalised. `sin/cos/atan2/hypot/pow` must never appear between the
fences: `scripts/moto-trial-parity.mjs` fails if they do. The renderer outside the
fences may use anything.

**Model:** metres, y up, 60 Hz ticks × 4 substeps.
- **Chassis:** a rigid body for the bike plus rider (mass 1, inertia 0.15).
- **Two wheels:** each is a separate body with mass, spin and radius 0.34 m. Each hangs
  from a chassis anchor on a spring-damper that is soft along the fork and stiff across
  it, with bump stops. Landings, weight transfer and pitch come out of these springs.
- **Contact:** wheels collide with the course segments, which are looked up through
  1 m x-buckets. Each contact gets a push-out, a normal impulse and a **friction impulse
  on the contact slip `v_t + ω·r`**, capped by μ·normal. That is real traction: the rear
  wheel can spin, grip and drive. The engine sump also collides, so a crest scrapes
  instead of passing through the frame.
- **Throttle:** a torque on the rear wheel (spin-capped). Its reaction pitches the chassis
  nose-up, which gives natural wheelies.
- **Brake:** the same torque in reverse on both wheels; hard braking on the front tips
  the bike forward.
- **Lean:** a torque on the chassis, 4.2 on the ground and 2.3 in the air. In the air
  that is about 190° per second of held lean.
- **The run ends when:** the helmet circle (r 0.17) or the torso circle (r 0.15) touches
  the course, the bike falls 12 m below the lowest point, or 180 s pass.
- **Finish:** the chassis crosses `course.finish`.
- All tuning lives in the `MT_P` object.

Measured on flat ground: 0 → 9 m/s in 2 s, and 90 ticks of brake stops the bike.
Throttle with back lean held from a standstill loops out in about 2 s. Throttle alone
crashes on both courses.

**Courses** are op lists (`MT_LAYOUTS`) expanded into dense polylines. The ops are flat,
smooth slope, smooth hill/dip, straight line (ramps, kickers, vertical steps) and gap
(a real hole). Kamieniołom has rolling hills, three gap jumps, two steps, a whoops
section, a dip and a big hill. Górska Przełęcz has steep climbs, sharp drop-offs, three
gaps, double climbs and a deep valley.

**Scoring** (contract unchanged): progress is 0–9999 as hundredths of a percent of the
start→finish distance, best x reached, and only a finish scores 10000 plus
`completion_ms`. The arcade score is encoded as `200000 + (180000 − completion_ms)` for a
finish, otherwise the raw progress.

## Renderer (games/moto-trial.js `mtCreateView`)

Canvas 2D at `devicePixelRatio`, in the Gravity Defied look:
- white field
- the track drawn as a dark-green near edge and a light-green far edge offset up and to
  the right, with a tie at every vertex and a faint fill between the two edges
- checkered START/META flags
- a vector bike: spoked wheels that turn with the simulated wheel spin, swingarm, fork,
  engine, red tank
- a rider whose body follows the lean, with a yellow helmet drawn exactly at the crash
  circle

The camera follows with smoothing and velocity look-ahead. Frames are interpolated
between the last two sim states for high-refresh displays. A thin progress strip and a
crash/finish banner are drawn on the canvas, and time and records sit outside it.
`project(x, y)` maps world → CSS px for tests. The view is render-only and nothing in it
feeds the simulation. The interface is `{draw, resize, project, dispose}`, shared by the
game, the practice page and the „Wszystkie Gry" card preview (`games/previews.js`).

## Golden replays and tests

```sh
node scripts/moto-trial-solve.mjs          # beam search; rewrites games/moto-trial-golden.js
node scripts/moto-trial-parity.mjs         # browser ↔ Edge parity + physics invariants
```

`moto-trial-solve.mjs` does a beam search over 8-tick control chunks to find a completing
input log for each course: 24.6 s for quarry and 32.1 s for mountain. That log drives the
idle stage and the card preview, and it proves each course can be finished. A human run
will be slower. **Re-run it after any change to physics or a layout.** Treat the result as
a new version (bump `MT_VERSION`, rename the course ids, update the SQL CHECKs) once a
competitive week has opened.

Parity covers:
- textual equality of the fenced block in both files
- the exact-math rule
- both golden replays in both copies
- 80 randomised drivers, bit-identical in both copies
- malformed input
- resting level, throttle-only and loop-out crashes, braking, falling and the time cap
- course geometry

The PostgreSQL test runs the real migration and the real Edge `start`/`submit` against
PGlite:

```sh
curl -sSfL https://registry.npmjs.org/@electric-sql/pglite/-/pglite-0.5.8.tgz | tar xz -C /tmp
PGLITE_MODULE=/tmp/package/dist/index.js node scripts/moto-trial-db-test.mjs
```

`scripts/moto-trial-browser-test.mjs` (Playwright) checks:
- canvas pixels at the simulated wheels and helmet along both golden replays
- keyboard and simultaneous touch
- fullscreen
- failed-save retry
- teardown
- the in-app picker path

CI runs the parity and DB suites before publishing.

## Server and data

`moto-trial-action` (`verify_jwt = true`):
- `state {mode, courseId?}`
- `start {mode}`: issues the round. The server picks the seasonal course; the round
  expires after 210 s, capped at the week boundary. A new start abandons the old round,
  with a 1 s throttle.
- `submit {roundId, elapsedTicks, moves}`: replays the inputs and rejects a round
  "played too fast" against the wall clock (+1.5 s). It ignores client scores and
  returns the stored result if the same round is submitted twice.
  Arcade finishes on Kamieniołom are also written to `arcade_scores` as service role.

A trigger refuses any client-routed `arcade_scores` row for `moto_trial`. **Do not add
the game to `record_arcade_score`.**

`supabase/moto-trial.sql` contains:
- `moto_trial_rounds/_scores/_weekly_awards`, all client SELECT-only
- views `moto_trial_weekly_best/_current_week/_all_time/_recent_awards`
- `award_moto_trial_week()` (1000/500/200, idempotent, per-week advisory lock), with a
  cron at Sunday 22:00/23:00 UTC gated to Warsaw midnight
- `moto_trial_course_for_week()`, which returns mountain for the week of 2026-10-26 and
  quarry otherwise

## Season

- 2026-10-12: **Tetris G6 encore**, so there is a playtest week.
- 2026-10-19 → 25: Moto Trial · Kamieniołom (debut). This week is 169 h long because DST
  ends 2026-10-25.
- 2026-10-26 → 11-01: Moto Trial · Górska Przełęcz.

These are overrides in both `index.html` `SEASONAL_OVERRIDES` and `seasonal_game_for_week()`
(`season-award-gating.sql`), and they must ship together. `moto_trial` is the 17th
rotation entry (`% 17`). If launch slips, move both Moto Trial weeks and the course
mapping in `moto_trial_course_for_week()` together.

## Release checklist

1. The owner playtests both courses locally and accepts the feel.
2. Prod (`supabase db query --linked`): apply `moto-trial.sql`, then re-run
   `season-award-gating.sql`, `last-active.sql`, `coin-inflow-stats.sql` and
   `economy-stats.sql`.
3. `supabase functions deploy moto-trial-action`, then smoke test start/submit with a real
   account.
4. Push the frontend in the same session. This must land before 2026-10-12 because of the
   Tetris override.
