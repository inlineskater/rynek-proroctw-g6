// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://inlineskater.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
const db = databaseUrl
  ? postgres(databaseUrl, { prepare: false, max: 4, idle_timeout: 20 })
  : null;

// „Arkanoid G6" (arkanoid) — Breakout with office bricks.
//
// ⚠️ PARITY CONTRACT: everything between the PARITY BLOCK fences below must
// stay byte-for-byte equivalent to the same block in games/arkanoid.js — the
// client plays this exact simulation and the server replays seed + the input
// log to derive the trusted score. Verified by `node scripts/arkanoid-parity.mjs`.

// ── PARITY BLOCK START ──────────────────────────────────────────────────────
const AK_TICK_MS = 20;                // 50 simulation ticks per second
const AK_MAX_TICKS = 15000;           // 5 min: hard ceiling on a round's replay cost
// Input log entries (pairs). A mouse that moves on every tick for the whole
// round logs AK_MAX_TICKS target changes, plus one launch per serve — so the
// ceiling sits above the tick count, or an honest busy round would be refused.
const AK_MAX_INPUTS = 16000;
// Ceiling on a submitted score, mirrored by the arcade cap in arcade.sql.
// Measured: scripts/arkanoid-balance.mjs's never-wrong bot tops out around
// 16 000 inside the 5-minute cap, a good reader of the bounce lands 8-11 000.
const AK_MAX_SCORE = 40000;

const AK_FP = 16;                     // fixed-point sub-units per field unit
const AK_W = 224;                     // field, in units
const AK_H = 256;
const AK_COLS = 14;
const AK_ROWS = 12;
const AK_BRICK_W = 16;
const AK_BRICK_H = 8;
const AK_TOP = 32;                    // first brick row's y

const AK_PADDLE_Y = 234;
const AK_PADDLE_H = 5;
const AK_PADDLE_W = 32;
const AK_PADDLE_WIDE_W = 48;
const AK_PADDLE_SPEED = 8 * 16;       // FP per tick — always faster than the ball
const AK_BALL = 4;                    // ball is a 4×4 square
const AK_SUBSTEPS = 4;                // ball moves in 4 sub-steps a tick

// Speed is FP per SUB-step. 18 → 4.5 units/tick → 225 units/s, i.e. a paddle →
// bricks → paddle return takes ~1.2 s at the start of floor 1. AK_SPD_MAX (28 →
// 7 units/tick) stays below AK_PADDLE_SPEED (8), so a ball is never simply
// faster than the paddle can move — a miss is always a read, not a race.
const AK_SPD_BASE = 18;
const AK_SPD_PER_LEVEL = 1;
const AK_SPD_HITS = 10;               // +1 speed per this many bricks hit on a floor
const AK_SPD_MAX = 28;
const AK_SPD_SLOW = 5;                // the ☕ capsule takes this much off

const AK_LIVES = 3;
const AK_MAX_LIVES = 5;
const AK_MAX_BALLS = 3;
const AK_AUTO_LAUNCH_TICKS = 150;     // a held ball launches itself after 3 s
// Anti-stall. The concrete walls can hold a ball in a periodic orbit that
// never reaches the paddle or a breakable brick (measured: 166 s in the vault's
// ceiling band), or in a paddle → wall → paddle loop that never finds the last
// bricks tucked behind a shelf (measured: 180 s on floor 3). So a ball that
// has touched neither paddle nor brick for AK_STALL_TICKS, or any floor where
// no brick has been hit for AK_DROUGHT_TICKS, gets a random table direction at
// its next wall/ceiling bounce — never at the paddle, where the player aims —
// and again every AK_STALL_RETRY ticks until a brick is hit. Seeded, so replays
// agree.
const AK_STALL_TICKS = 250;           // 5 s
const AK_DROUGHT_TICKS = 750;         // 15 s
const AK_STALL_RETRY = 50;            // 1 s

// Capsules: 1 in AK_CAPSULE_ODDS destroyed bricks drops one.
const AK_CAPSULE_ODDS = 6;
const AK_CAPSULE_FALL = 20;           // FP per tick
const AK_CAPSULE_W = 12;
const AK_CAPSULE_H = 6;
const AK_CAP_WIDE = 0;                // ⌨️ szersza klawiatura
const AK_CAP_SLOW = 1;                // ☕ wolniejsza piłka
const AK_CAP_LIFE = 2;                // ❤️ dodatkowe życie
const AK_CAP_MULTI = 3;               // ✨ trzy piłki
const AK_WIDE_TICKS = 750;
const AK_SLOW_TICKS = 600;

const AK_PTS_BAND = 10;               // a colour brick is worth 10 × its band (1..6)
const AK_PTS_HARD = 60;               // 📁 segregator, 2 hits
const AK_PTS_SAFE = 100;              // 🔒 sejf, 3 hits
const AK_PTS_CHIP = 5;                // a hit that does not break the brick
const AK_PTS_CAPSULE = 25;
const AK_CLEAR_BONUS = 500;
const AK_CLEAR_TIME_BONUS = 1000;     // ...decaying to 0 over
const AK_CLEAR_TIME_DECAY = 6;        // ...1000 × 6 ticks = 120 s (a floor takes 60-95 s)

// Bounce directions off the paddle, by which eighth of it the ball hit. Every
// vector has length ≈ 64 (56²+31² = 4097, 45²+45² = 4050, 16²+62² = 4100), so
// scaling by speed/64 keeps the ball's speed constant across zones.
const AK_DIRS = [
  [-56, -31], [-45, -45], [-31, -56], [-16, -62],
  [16, -62], [31, -56], [45, -45], [56, -31],
];

// Six office floors, 14 columns × up to 12 rows. '.' empty, '1'..'6' a colour
// brick of that band (1 hit), 'H' a segregator (2 hits), 'S' a safe (3 hits),
// 'X' a load-bearing concrete wall: it never breaks, scores nothing and does
// not count towards clearing the floor — it is there to make the ball ricochet
// and to hide bricks behind it. Every breakable brick must stay reachable
// around the walls, and no wall pocket may hold a ball away from the paddle
// for long; scripts/arkanoid-balance.mjs asserts both.
const AK_LEVELS = [
  [ // Open Space — rows of desks, an aisle, two pillars
    '66666666666666',
    '55555555555555',
    '..............',
    '444.444444.444',
    '333.3HHHH3.333',
    '..............',
    '.X.22222222.X.',
  ],
  [ // Piramida korporacyjna — concrete flanks, a safe at the apex
    '......SS......',
    '.....6666.....',
    '....555555....',
    '...X444444X...',
    '..X33333333X..',
    '.X2222222222X.',
    '..............',
    'HH....11....HH',
  ],
  [ // Ściana segregatorów — shelves you have to get around
    'H6H6H6H6H6H6H6',
    '55555555555555',
    '.....XXXX.....',
    '..............',
    '44H44H44H44H44',
    '..............',
    'XX...XXXX...XX',
    '..33......33..',
  ],
  [ // Boksy — four cubicles, open only from below
    '55555555555555',
    'X44X44XX44X44X',
    'X44X44XX44X44X',
    'X33X33XX33X33X',
    'XHHX..XX..XHHX',
    '..............',
    '.2222.22.2222.',
  ],
  [ // Szachownica biurek — a checkerboard with concrete in it
    '6.6.6.6.6.6.6.',
    '.5.5.5.5.5.5.5',
    '4.X.4.X.4.X.4.',
    '.3.3.3.3.3.3.3',
    'H.H.X.H.H.X.H.',
    '.2.2.2.2.2.2.2',
    '1.1.1.1.1.1.1.',
  ],
  [ // Sejf Prezesa — a concrete vault: a door of bricks below, a slot on top
    '..............',
    '.XXX......XXX.',
    '.XSS666666SSX.',
    '.X5555555555X.',
    '.X44HHSSHH44X.',
    '..3333333333..',
  ],
];

function akRng(st) {
  st.rng = (Math.imul(st.rng, 1103515245) + 12345) >>> 0;
  return st.rng >>> 16;
}

function akBrickHp(ch) {
  if (ch === 'H') return 2;
  if (ch === 'S') return 3;
  if (ch === 'X') return -1;           // wall: never breaks
  if (ch >= '1' && ch <= '6') return 1;
  return 0;
}

function akLoadLevel(st) {
  const rows = AK_LEVELS[st.level % AK_LEVELS.length];
  st.hp = new Array(AK_COLS * AK_ROWS).fill(0);
  st.kind = new Array(AK_COLS * AK_ROWS).fill('.');
  st.left = 0;
  for (let r = 0; r < rows.length && r < AK_ROWS; r += 1) {
    for (let c = 0; c < AK_COLS; c += 1) {
      const ch = rows[r].charAt(c) || '.';
      const hp = akBrickHp(ch);
      const i = r * AK_COLS + c;
      st.hp[i] = hp;
      st.kind[i] = hp !== 0 ? ch : '.';
      if (hp > 0) st.left += 1;
    }
  }
  st.levelTicks = 0;
  st.levelHits = 0;
  st.drought = 0;
  st.capsules = [];
  st.wide = 0;
  st.slow = 0;
  akServe(st);
}

function akPaddleW(st) {
  return st.wide > 0 ? AK_PADDLE_WIDE_W : AK_PADDLE_W;
}

function akClampPaddle(st) {
  const half = (akPaddleW(st) * AK_FP) >> 1;
  if (st.pc < half) st.pc = half;
  if (st.pc > AK_W * AK_FP - half) st.pc = AK_W * AK_FP - half;
}

// One ball, held on the paddle until launched.
function akServe(st) {
  st.balls = [{ x: 0, y: (AK_PADDLE_Y - AK_BALL) * AK_FP, vx: 0, vy: 0, stuck: true, idle: 0 }];
  st.stuckTicks = 0;
  akStickBall(st);
}

function akStickBall(st) {
  for (const b of st.balls) {
    if (!b.stuck) continue;
    b.x = st.pc - ((AK_BALL * AK_FP) >> 1);
    b.y = (AK_PADDLE_Y - AK_BALL) * AK_FP;
  }
}

function akInitState(seed) {
  const st = {
    rng: (seed >>> 0) || 1,
    tick: 0,
    level: 0,
    score: 0,
    lives: AK_LIVES,
    over: false,
    pc: (AK_W * AK_FP) >> 1,       // paddle CENTRE, FP
    target: AK_W >> 1,             // paddle target centre, units
    launchQueued: false,
    bricks: 0,                     // bricks destroyed, all levels
    cleared: 0,                    // levels cleared
    capsulesCaught: 0,
    livesLost: 0,
    paddleHits: 0,
    hp: null, kind: null, left: 0,
    levelTicks: 0, levelHits: 0, drought: 0,
    balls: [], capsules: [], wide: 0, slow: 0, stuckTicks: 0,
  };
  akLoadLevel(st);
  return st;
}

function akSpeed(st) {
  let s = AK_SPD_BASE + st.level * AK_SPD_PER_LEVEL + Math.floor(st.levelHits / AK_SPD_HITS);
  if (s > AK_SPD_MAX) s = AK_SPD_MAX;
  if (st.slow > 0) s -= AK_SPD_SLOW;
  return s;
}

function akAim(b, zone, spd) {
  const d = AK_DIRS[zone];
  b.vx = Math.trunc(d[0] * spd / 64);
  b.vy = Math.trunc(d[1] * spd / 64);
}

function akLaunch(st) {
  let any = false;
  for (const b of st.balls) {
    if (!b.stuck) continue;
    b.stuck = false;
    akAim(b, 3 + (akRng(st) & 1), akSpeed(st));
    any = true;
  }
  st.stuckTicks = 0;
  return any;
}

// The first live brick or wall the ball's box overlaps, row-major, or -1.
function akBrickAt(st, b) {
  const x0 = Math.floor(b.x / AK_FP);
  const x1 = Math.floor((b.x + AK_BALL * AK_FP - 1) / AK_FP);
  const y0 = Math.floor(b.y / AK_FP);
  const y1 = Math.floor((b.y + AK_BALL * AK_FP - 1) / AK_FP);
  let r0 = Math.floor((y0 - AK_TOP) / AK_BRICK_H);
  let r1 = Math.floor((y1 - AK_TOP) / AK_BRICK_H);
  if (r1 < 0 || r0 >= AK_ROWS) return -1;
  if (r0 < 0) r0 = 0;
  if (r1 >= AK_ROWS) r1 = AK_ROWS - 1;
  let c0 = Math.floor(x0 / AK_BRICK_W);
  let c1 = Math.floor(x1 / AK_BRICK_W);
  if (c0 < 0) c0 = 0;
  if (c1 >= AK_COLS) c1 = AK_COLS - 1;
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const i = r * AK_COLS + c;
      if (st.hp[i] !== 0) return i;
    }
  }
  return -1;
}

// Returns false for a wall, which only bounces the ball.
function akHitBrick(st, i) {
  if (st.hp[i] < 0) return false;
  st.hp[i] -= 1;
  st.levelHits += 1;
  st.drought = 0;
  if (st.hp[i] > 0) { st.score += AK_PTS_CHIP; return true; }
  const k = st.kind[i];
  st.score += k === 'S' ? AK_PTS_SAFE : k === 'H' ? AK_PTS_HARD : AK_PTS_BAND * (k.charCodeAt(0) - 48);
  st.left -= 1;
  st.bricks += 1;
  if (akRng(st) % AK_CAPSULE_ODDS === 0 && st.capsules.length < 3) {
    const c = i % AK_COLS;
    const r = (i - c) / AK_COLS;
    st.capsules.push({
      x: (c * AK_BRICK_W + ((AK_BRICK_W - AK_CAPSULE_W) >> 1)) * AK_FP,
      y: (AK_TOP + r * AK_BRICK_H) * AK_FP,
      kind: akRng(st) % 4,
    });
  }
  return true;
}

// A stalled ball (see AK_STALL_TICKS) leaves its bounce in a random table
// direction, keeping the sign the bounce just gave each axis so it never turns
// back into what it hit.
function akUnstall(st, b) {
  if (b.idle < AK_STALL_TICKS && st.drought < AK_DROUGHT_TICKS) return;
  const d = AK_DIRS[akRng(st) & 7];
  const spd = akSpeed(st);
  const vx = Math.abs(Math.trunc(d[0] * spd / 64));
  const vy = Math.abs(Math.trunc(d[1] * spd / 64));
  b.vx = b.vx < 0 ? -vx : vx;
  b.vy = b.vy < 0 ? -vy : vy;
  if (b.idle >= AK_STALL_TICKS) b.idle = AK_STALL_TICKS - AK_STALL_RETRY;
  if (st.drought >= AK_DROUGHT_TICKS) st.drought = AK_DROUGHT_TICKS - AK_STALL_RETRY;
}

// One sub-step of one ball, axis by axis: move X, resolve; move Y, resolve.
// Returns false when the ball has fallen out of the field.
function akStepBall(st, b) {
  const BF = AK_BALL * AK_FP;
  const WF = AK_W * AK_FP;

  const ox = b.x;
  b.x += b.vx;
  if (b.x < 0) { b.x = 0; b.vx = Math.abs(b.vx); akUnstall(st, b); }
  else if (b.x + BF > WF) { b.x = WF - BF; b.vx = -Math.abs(b.vx); akUnstall(st, b); }
  else {
    const i = akBrickAt(st, b);
    if (i >= 0) {
      b.x = ox; b.vx = -b.vx;
      if (akHitBrick(st, i)) b.idle = 0; else akUnstall(st, b);
    }
  }

  const oy = b.y;
  b.y += b.vy;
  if (b.y < 0) { b.y = 0; b.vy = Math.abs(b.vy); akUnstall(st, b); return true; }
  const i = akBrickAt(st, b);
  if (i >= 0) {
    b.y = oy; b.vy = -b.vy;
    if (akHitBrick(st, i)) b.idle = 0; else akUnstall(st, b);
    return true;
  }

  const pw = akPaddleW(st) * AK_FP;
  const pl = st.pc - (pw >> 1);
  const pt = AK_PADDLE_Y * AK_FP;
  if (b.vy > 0 && b.y + BF >= pt && oy + BF <= pt + AK_PADDLE_H * AK_FP
      && b.x + BF > pl && b.x < pl + pw) {
    b.y = pt - BF;
    let zone = Math.floor((b.x + (BF >> 1) - pl) * 8 / pw);
    if (zone < 0) zone = 0;
    if (zone > 7) zone = 7;
    akAim(b, zone, akSpeed(st));
    b.idle = 0;
    st.paddleHits += 1;
    return true;
  }
  return b.y < AK_H * AK_FP;
}

function akCatch(st, kind) {
  st.capsulesCaught += 1;
  st.score += AK_PTS_CAPSULE;
  if (kind === AK_CAP_WIDE) { st.wide = AK_WIDE_TICKS; akClampPaddle(st); }
  else if (kind === AK_CAP_SLOW) st.slow = AK_SLOW_TICKS;
  else if (kind === AK_CAP_LIFE) { if (st.lives < AK_MAX_LIVES) st.lives += 1; }
  else if (kind === AK_CAP_MULTI) {
    const free = st.balls.find(b => !b.stuck);
    if (!free) return;
    const spd = akSpeed(st);
    while (st.balls.length < AK_MAX_BALLS) {
      const nb = { x: free.x, y: free.y, vx: 0, vy: 0, stuck: false, idle: 0 };
      akAim(nb, st.balls.length === 1 ? 1 : 6, spd);
      st.balls.push(nb);
    }
  }
}

// Input for the CURRENT tick, applied before akTick runs it. value -1 is a
// launch; 0..AK_W is a new paddle target (a centre, in units).
function akInput(st, value) {
  if (value === -1) { st.launchQueued = true; return true; }
  if (!Number.isInteger(value) || value < 0 || value > AK_W) return false;
  st.target = value;
  return true;
}

function akTick(st) {
  if (st.over) return;

  // Paddle chases its target.
  const d = st.target * AK_FP - st.pc;
  st.pc += d > AK_PADDLE_SPEED ? AK_PADDLE_SPEED : d < -AK_PADDLE_SPEED ? -AK_PADDLE_SPEED : d;
  akClampPaddle(st);
  akStickBall(st);

  if (st.balls.some(b => b.stuck)) {
    st.stuckTicks += 1;
    if (st.launchQueued || st.stuckTicks >= AK_AUTO_LAUNCH_TICKS) akLaunch(st);
  }
  st.launchQueued = false;

  // Balls.
  if (st.balls.some(b => !b.stuck)) st.drought += 1;
  const kept = [];
  for (const b of st.balls) {
    let alive = true;
    if (!b.stuck) {
      b.idle += 1;
      for (let s = 0; s < AK_SUBSTEPS && alive; s += 1) {
        alive = akStepBall(st, b);
        if (st.left === 0) break;
      }
    }
    if (alive) kept.push(b);
    if (st.left === 0) break;
  }
  st.balls = kept;

  // Capsules fall; the paddle catches them.
  const pw = akPaddleW(st) * AK_FP;
  const pl = st.pc - (pw >> 1);
  const pt = AK_PADDLE_Y * AK_FP;
  const falling = [];
  for (const c of st.capsules) {
    c.y += AK_CAPSULE_FALL;
    const hit = c.y + AK_CAPSULE_H * AK_FP >= pt && c.y <= pt + AK_PADDLE_H * AK_FP
      && c.x + AK_CAPSULE_W * AK_FP > pl && c.x < pl + pw;
    if (hit) akCatch(st, c.kind);
    else if (c.y < AK_H * AK_FP) falling.push(c);
  }
  st.capsules = falling;

  if (st.wide > 0) { st.wide -= 1; if (st.wide === 0) akClampPaddle(st); }
  if (st.slow > 0) st.slow -= 1;
  st.levelTicks += 1;
  st.tick += 1;

  if (st.left === 0) {
    const t = AK_CLEAR_TIME_BONUS - Math.floor(st.levelTicks / AK_CLEAR_TIME_DECAY);
    st.score += AK_CLEAR_BONUS + (t > 0 ? t : 0);
    st.cleared += 1;
    st.level += 1;
    akLoadLevel(st);
  } else if (st.balls.length === 0) {
    st.lives -= 1;
    st.livesLost += 1;
    st.capsules = [];
    st.wide = 0;
    st.slow = 0;
    if (st.lives <= 0) st.over = true;
    else akServe(st);
  }
  if (st.tick >= AK_MAX_TICKS) st.over = true;
}

// Server-side replay. `inputs` is a FLAT array [tick, value, tick, value, …]:
// half the bytes of an array of objects, and a busy mouse logs a lot of them.
function akReplay(seed, inputs) {
  const st = akInitState(seed);
  let i = 0;
  while (!st.over) {
    while (i < inputs.length && inputs[i] === st.tick) {
      if (!akInput(st, inputs[i + 1])) return { ok: false, atInput: i >> 1 };
      i += 2;
    }
    if (i < inputs.length && inputs[i] < st.tick) return { ok: false, atInput: i >> 1 };
    akTick(st);
  }
  // Inputs left over claim a tick the round never reached.
  if (i < inputs.length) return { ok: false, atInput: i >> 1 };
  return {
    ok: true,
    score: Math.min(AK_MAX_SCORE, st.score),
    rawScore: st.score,
    ticks: st.tick,
    level: st.level,
    cleared: st.cleared,
    bricks: st.bricks,
    capsules: st.capsulesCaught,
    livesLost: st.livesLost,
    paddleHits: st.paddleHits,
    over: st.over,
  };
}
// ── PARITY BLOCK END ────────────────────────────────────────────────────────

const ROUND_EXPIRES_SECONDS = 1800;
const PRIZES = [1000, 500, 200];

// THE anti-cheat guard, same shape as „Saper Maraton"'s: a submitted round must
// have taken at least as much WALL CLOCK as the ticks it claims to simulate, so
// a forged full-length log costs the same five real minutes an honest round
// does. The client treats a long frame gap (a backgrounded tab) as a pause,
// which only ever makes a round take LONGER than its ticks — always accepted.
const AK_TIME_GRACE_MS = 2500;

// Hero score_bonus items are worth this many Arkanoid points each. A good round
// lands near 9 500, so ×80 makes a +5 item worth 400 — visible, not decisive.
const AK_ITEM_SCORE_PER_POINT = 80;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function gameError(message) {
  const err = new Error(message);
  err.isGame = true;
  return err;
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// The client sends a FLAT array [tick, value, tick, value, …]. Ticks are
// non-decreasing (one tick can hold a target change and a launch), values are
// -1 (launch) or a paddle target 0..AK_W. akReplay() re-checks every entry as
// it applies it; this only rejects garbage before a replay is spent on it.
function parseInputs(value) {
  if (!Array.isArray(value)) throw gameError("Brak zapisu ruchów rundy.");
  if (value.length % 2 !== 0) throw gameError("Uszkodzony zapis ruchów.");
  if (value.length > AK_MAX_INPUTS * 2) throw gameError("Za dużo ruchów w rundzie.");
  const out = new Array(value.length);
  let previousTick = 0;
  for (let i = 0; i < value.length; i += 2) {
    const tick = asInt(value[i], NaN);
    const v = asInt(value[i + 1], NaN);
    if (!Number.isFinite(tick) || tick < 0 || tick > AK_MAX_TICKS) throw gameError("Nieprawidłowy ruch.");
    if (tick < previousTick) throw gameError("Ruchy poza kolejnością.");
    if (!Number.isFinite(v) || v < -1 || v > AK_W) throw gameError("Nieprawidłowy ruch.");
    previousTick = tick;
    out[i] = tick;
    out[i + 1] = v;
  }
  return out;
}

async function requireUser(req) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) throw gameError("Musisz być zalogowany.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) throw new Error("Missing Supabase environment.");

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) throw gameError("Sesja wygasła. Zaloguj się ponownie.");
  return data.user;
}

async function getStrongestHeroEffect(tx, userId, game) {
  try {
    const rows = await tx`
      select d.slug, d.name, d.emoji, d.effect_game, d.effect_type, d.effect_value
      from public.hero_item_instances i
      join public.hero_item_defs d on d.id = i.item_def_id
      where i.owner_id = ${userId}
        and d.is_active = true
        and (i.expires_at is null or i.expires_at > now())
        and (
          d.effect_game = ${game}
          or (
            ${game} in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic', 'tetris', 'bubble_breaker', 'saper', 'arkanoid')
            and d.effect_type = 'score_bonus'
            and d.effect_game in ('whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic', 'tetris', 'bubble_breaker', 'saper', 'arkanoid')
          )
        )
      order by d.effect_value desc, d.price desc, d.slug
      limit 1
    `;
    return rows[0] ?? null;
  } catch (err) {
    console.warn("Hero item effects unavailable:", err?.message ?? err);
    return null;
  }
}

function mapRows(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    base_score: asInt(row.base_score, asInt(row.score)),
    item_bonus: asInt(row.item_bonus),
    levels_cleared: asInt(row.levels_cleared),
    bricks: asInt(row.bricks),
    capsules: asInt(row.capsules),
    lives_lost: asInt(row.lives_lost),
    ticks: asInt(row.ticks),
    duration_ms: asInt(row.duration_ms),
    rounds_played: asInt(row.rounds_played),
    accuracy: asNumber(row.accuracy),
  }));
}

function mapAwards(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    duration_ms: asInt(row.duration_ms),
    prize_coins: asInt(row.prize_coins),
  }));
}

async function loadState(userId) {
  if (!db) throw new Error("Database is not configured.");

  const [profile] = await db`
    select id, nick, coins from public.profiles where id = ${userId}
  `;
  if (!profile) throw gameError("Profil nie istnieje.");

  const [weekRow] = await db`select public.arkanoid_week_start(now()) as week_start`;
  const weekly = await db`select * from public.arkanoid_current_week order by rank limit 20`;
  const allTime = await db`select * from public.arkanoid_all_time order by rank limit 20`;
  const awards = await db`
    select * from public.arkanoid_recent_awards order by week_start desc, rank asc limit 12
  `;
  const [myWeekly] = await db`select * from public.arkanoid_current_week where user_id = ${userId}`;
  const [myAllTime] = await db`select * from public.arkanoid_all_time where user_id = ${userId}`;

  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    weekStart: weekRow?.week_start,
    prizes: PRIZES,
    weekly: mapRows(weekly),
    allTime: mapRows(allTime),
    awards: mapAwards(awards),
    myWeekly: myWeekly ? mapRows([myWeekly])[0] : null,
    myAllTime: myAllTime ? mapRows([myAllTime])[0] : null,
  };
}

async function startRound(userId) {
  if (!db) throw new Error("Database is not configured.");

  const [profile] = await db`
    select id, nick, coins from public.profiles where id = ${userId}
  `;
  if (!profile) throw gameError("Profil nie istnieje.");

  const seed = Math.floor(Math.random() * 2147483647) + 1;
  const [round] = await db`
    insert into public.arkanoid_rounds
      (user_id, nick_snapshot, seed, expires_at)
    values
      (${userId}, ${profile.nick}, ${seed}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
    returning id, seed, started_at, expires_at
  `;

  return {
    ...(await loadState(userId)),
    round: {
      id: round.id,
      seed: asInt(round.seed),
      startedAt: round.started_at,
      serverNow: new Date().toISOString(),
      expiresAt: round.expires_at,
    },
  };
}

async function submitRound(userId, body) {
  if (!db) throw new Error("Database is not configured.");
  const roundId = String(body.roundId ?? "");
  if (!roundId) throw gameError("Brak rundy do zapisania.");
  const inputs = parseInputs(body.inputs);

  const effect = await getStrongestHeroEffect(db, userId, "arkanoid");

  const score = await db.begin(async (tx) => {
    const [round] = await tx`
      select r.*, p.nick
      from public.arkanoid_rounds r
      join public.profiles p on p.id = r.user_id
      where r.id = ${roundId}
        and r.user_id = ${userId}
      for update
    `;
    if (!round) throw gameError("Runda nie istnieje.");
    if (round.submitted_at) throw gameError("Ta runda została już zapisana.");
    if (new Date(round.expires_at).getTime() < Date.now()) throw gameError("Runda wygasła.");

    const replay = akReplay(asInt(round.seed), inputs);
    if (!replay.ok) throw gameError("Niepoprawny ruch w zapisie rundy.");
    // akReplay always plays to the end, so `over` is true for any valid log;
    // the check stays as documentation of the rule: a round is only a result
    // once it is finished.
    if (!replay.over) throw gameError("Runda jeszcze trwa.");

    const elapsedMs = Date.now() - new Date(round.started_at).getTime();
    if (elapsedMs + AK_TIME_GRACE_MS < replay.ticks * AK_TICK_MS) {
      throw gameError("Runda rozegrana za szybko.");
    }

    const baseScore = Math.max(0, Math.min(AK_MAX_SCORE, replay.score));
    const bonus = effect?.effect_type === "score_bonus"
      ? Math.max(0, asInt(effect.effect_value, 0)) * AK_ITEM_SCORE_PER_POINT
      : 0;
    const scoreValue = Math.min(AK_MAX_SCORE, baseScore + bonus);
    const itemEffect = bonus > 0 && scoreValue > baseScore ? {
      slug: effect.slug,
      name: effect.name,
      type: effect.effect_type,
      value: Number(effect.effect_value),
      bonus: scoreValue - baseScore,
    } : null;
    // "accuracy" carries the SAVE RATE — paddle returns / (returns + balls
    // lost). Every seasonal scores table has the column and index.html
    // tiebreaks the live podium on it, so the name is fixed even though the
    // quantity is game-specific.
    const chances = replay.paddleHits + replay.livesLost;
    const saveRate = chances > 0
      ? Math.min(100, Math.round((replay.paddleHits / chances) * 10000) / 100)
      : 0;

    await tx`update public.arkanoid_rounds set submitted_at = now() where id = ${round.id}`;

    const [inserted] = await tx`
      insert into public.arkanoid_scores
        (round_id, user_id, nick_snapshot, week_start, score, levels_cleared, bricks, capsules, lives_lost, paddle_hits, inputs, ticks, duration_ms, accuracy, client_meta)
      values
        (
          ${round.id},
          ${userId},
          ${round.nick_snapshot},
          public.arkanoid_week_start(now()),
          ${scoreValue},
          ${replay.cleared},
          ${replay.bricks},
          ${replay.capsules},
          ${replay.livesLost},
          ${replay.paddleHits},
          ${inputs.length / 2},
          ${replay.ticks},
          ${Math.max(0, Math.min(2147483647, elapsedMs))},
          ${saveRate},
          ${JSON.stringify({
            seed: asInt(round.seed),
            client_score: asInt(body.score, 0),
            server_validated: true,
            base_score: baseScore,
            item_effect: itemEffect,
          })}::jsonb
        )
      returning *
    `;

    return { inserted, itemEffect };
  });

  return {
    ...(await loadState(userId)),
    score: {
      id: score.inserted.id,
      score: asInt(score.inserted.score),
      levels_cleared: asInt(score.inserted.levels_cleared),
      bricks: asInt(score.inserted.bricks),
      capsules: asInt(score.inserted.capsules),
      lives_lost: asInt(score.inserted.lives_lost),
      submitted_at: score.inserted.submitted_at,
      itemEffect: score.itemEffect,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    let result;
    if (action === "state") result = await loadState(user.id);
    else if (action === "start") result = await startRound(user.id);
    else if (action === "submit") result = await submitRound(user.id, body);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
