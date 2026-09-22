// ── „Arkanoid G6" (arkanoid) — Breakout with office bricks ─────────────────
// Paddle, ball, a wall of bricks. Six hand-built office floors (Open Space,
// the corporate pyramid, the filing wall, …) that loop faster once cleared,
// three lives, and capsules that fall out of broken bricks.
//
// Debuts as a full seasonal game on the week starting 2026-09-28, and runs in
// two modes exactly like „Saper Maraton":
//
//   seasonal  — supabase/functions/arkanoid-action issues the seed and owns the
//               score. The client logs every paddle-target change and launch,
//               with the tick it happened on; the server replays seed + log.
//   arcade    — „Wszystkie Gry" (allGamesMode): a local seed, no round row,
//               score client-reported through record_arcade_score() and
//               guarded only by the cap in supabase/arcade.sql.
//
// DETERMINISM. Everything inside the PARITY BLOCK is integer arithmetic on
// 1/16-unit fixed point. No Math.sin/cos (engines may round them differently),
// no floats that carry state between ticks: bounce directions come from a
// fixed integer table whose vectors all have length ≈ 64. That is what lets
// Safari's JavaScriptCore and the Edge Function's V8 agree to the tick.
//
// INPUT is a TARGET, not a position: the paddle chases the pointer at
// AK_PADDLE_SPEED per tick. A mouse, a finger and the arrow keys therefore all
// feed the same one-number input, the log only grows when the target changes,
// and a replayed log can never teleport the paddle.
//
// ⚠️ PARITY CONTRACT: everything between the PARITY BLOCK fences below must
// stay byte-for-byte equivalent to the same block in
// supabase/functions/arkanoid-action/index.ts. Verified by
// `node scripts/arkanoid-parity.mjs`.

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

// Six office floors, 14 columns each. '.' empty, '1'..'6' a colour brick of
// that band (1 hit), 'H' a segregator (2 hits), 'S' a safe (3 hits).
const AK_LEVELS = [
  [ // Open Space
    '66666666666666',
    '55555555555555',
    '44444444444444',
    '33333333333333',
  ],
  [ // Piramida korporacyjna
    '......66......',
    '.....5555.....',
    '....444444....',
    '...33333333...',
    '..2222222222..',
    '.111111111111.',
    'HHHH......HHHH',
  ],
  [ // Ściana segregatorów
    'H6H6H6H6H6H6H6',
    'H5H5H5H5H5H5H5',
    'H4H4H4H4H4H4H4',
    '..............',
    '33333333333333',
  ],
  [ // Boksy
    '66666..6666666',
    '6....5..5....6',
    '6.44.5..5.44.6',
    '6.44.5..5.44.6',
    '6....5..5....6',
    '33333HHHH33333',
  ],
  [ // Szachownica biurek
    '6.5.4.3.2.1.6.',
    '.6.5.4.3.2.1.6',
    '6.5.4.3.2.1.6.',
    '.6.5.4.3.2.1.6',
    'HH..HH..HH..HH',
    '1.2.3.4.5.6.1.',
    '.1.2.3.4.5.6.1',
  ],
  [ // Sejf Prezesa
    '..SSSSSSSSSS..',
    '..6666666666..',
    '..55HHSSHH55..',
    '..4444444444..',
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
      st.kind[i] = hp > 0 ? ch : '.';
      if (hp > 0) st.left += 1;
    }
  }
  st.levelTicks = 0;
  st.levelHits = 0;
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
  st.balls = [{ x: 0, y: (AK_PADDLE_Y - AK_BALL) * AK_FP, vx: 0, vy: 0, stuck: true }];
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
    levelTicks: 0, levelHits: 0,
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

// The first live brick the ball's box overlaps, row-major, or -1.
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
      if (st.hp[i] > 0) return i;
    }
  }
  return -1;
}

function akHitBrick(st, i) {
  st.hp[i] -= 1;
  st.levelHits += 1;
  if (st.hp[i] > 0) { st.score += AK_PTS_CHIP; return; }
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
}

// One sub-step of one ball, axis by axis: move X, resolve; move Y, resolve.
// Returns false when the ball has fallen out of the field.
function akStepBall(st, b) {
  const BF = AK_BALL * AK_FP;
  const WF = AK_W * AK_FP;

  const ox = b.x;
  b.x += b.vx;
  if (b.x < 0) { b.x = 0; b.vx = Math.abs(b.vx); }
  else if (b.x + BF > WF) { b.x = WF - BF; b.vx = -Math.abs(b.vx); }
  else {
    const i = akBrickAt(st, b);
    if (i >= 0) { b.x = ox; b.vx = -b.vx; akHitBrick(st, i); }
  }

  const oy = b.y;
  b.y += b.vy;
  if (b.y < 0) { b.y = 0; b.vy = Math.abs(b.vy); return true; }
  const i = akBrickAt(st, b);
  if (i >= 0) { b.y = oy; b.vy = -b.vy; akHitBrick(st, i); return true; }

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
      const nb = { x: free.x, y: free.y, vx: 0, vy: 0, stuck: false };
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
  const kept = [];
  for (const b of st.balls) {
    let alive = true;
    if (!b.stuck) {
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

// Rendering-only constants, deliberately below the fence (the Edge Function
// has no canvas). The field is drawn at 2× under a 36-px HUD strip.
const AK_SCALE = 2;
const AK_HUD_H = 36;
const AK_CS_W = AK_W * AK_SCALE;
const AK_CS_H = AK_HUD_H + AK_H * AK_SCALE;
const AK_MAX_DPR = 2;
const AK_MAX_CATCHUP_TICKS = 10;   // a longer gap is treated as a pause (see arkanoidLoop)
const AK_LEVEL_NAMES = ['Open Space', 'Piramida korporacyjna', 'Ściana segregatorów', 'Boksy', 'Szachownica biurek', 'Sejf Prezesa'];
const AK_BAND_COLORS = ['', '#38bdf8', '#34d399', '#a3e635', '#facc15', '#fb923c', '#f472b6'];
const AK_CAPSULE_LOOK = [
  { color: '#38bdf8', icon: '⌨️', label: 'Szersza klawiatura' },
  { color: '#a78bfa', icon: '☕', label: 'Wolniej' },
  { color: '#f43f5e', icon: '❤️', label: '+1 życie' },
  { color: '#facc15', icon: '✨', label: 'Trzy piłki' },
];

// The panel's DOM. This file owns these names; index.html must not declare them.
const akArena     = document.getElementById('ak-arena');
const akStartBtn  = document.getElementById('ak-start-btn');
const akStatus    = document.getElementById('ak-status');
const akScoreEl   = document.getElementById('ak-score');
const akLevelEl   = document.getElementById('ak-level');
const akLivesEl   = document.getElementById('ak-lives');
const akBricksEl  = document.getElementById('ak-bricks');

// Panel CSS lives here, not in index.html, which is up against its payload
// budget. Injected once, the first time the game is fetched.
(function akInjectCss() {
  if (document.getElementById('ak-css')) return;
  const s = document.createElement('style');
  s.id = 'ak-css';
  s.textContent = `
    .ak-arena { position: relative; width: 100%; max-width: 460px; margin: 0 auto;
      aspect-ratio: ${AK_CS_W} / ${AK_CS_H}; overflow: hidden; border-radius: 10px;
      border: 2px solid #1e293b; background: #0b1120;
      box-shadow: 0 0 0 1px rgba(56,189,248,.25), 0 14px 36px rgba(2,6,23,.45);
      user-select: none; -webkit-user-select: none; touch-action: none; cursor: none; }
    .ak-arena canvas { display: block; width: 100%; height: 100%; }
    .ak-keys { font-size: 12px; color: var(--muted); text-align: center; margin-top: 6px; }
  `;
  document.head.appendChild(s);
})();

function newArkanoidRuntime() {
  return {
    playing: false, submitting: false, settled: false, archiveMode: false,
    seed: 1,
    roundId: null,
    inputLog: [],          // flat [tick, value, …] — the replay payload
    sim: akInitState(1),
    pendingTarget: null,   // latest pointer target, applied at the next tick
    pendingLaunch: false,
    keys: { left: false, right: false },
    prev: null,            // positions one tick ago, for render interpolation
    lastTickAt: 0,
    particles: [],
    floats: [],
    clock: 0,              // ms of simulated wall time (pauses excluded)
    lastFrame: 0,
    raf: null,
  };
}

let akCtx = null;

function arkanoidInitCanvas() {
  const canvas = document.getElementById('ak-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const DPR = Math.min(window.devicePixelRatio || 1, AK_MAX_DPR);
  const w = Math.round((rect.width || AK_CS_W) * DPR);
  const h = Math.round((rect.height || AK_CS_H) * DPR);
  if (!akCtx || canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    akCtx = canvas.getContext('2d');
  }
  akCtx.setTransform(w / AK_CS_W, 0, 0, h / AK_CS_H, 0, 0);
}

function arkanoidResetBoard(seed = 1) {
  const rt = arkanoidRuntime || newArkanoidRuntime();
  rt.seed = seed;
  rt.sim = akInitState(seed);
  rt.inputLog = [];
  rt.pendingTarget = null;
  rt.pendingLaunch = false;
  rt.prev = null;
  rt.particles = [];
  rt.floats = [];
  rt.roundId = null;
  rt.settled = false;
  arkanoidRuntime = rt;
  return rt;
}

// ── Drawing ─────────────────────────────────────────────────────────────────

function akRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function akBrickColor(kind, hp) {
  if (kind === 'S') return hp >= 3 ? '#94a3b8' : hp === 2 ? '#a8b4c4' : '#cbd5e1';
  if (kind === 'H') return hp >= 2 ? '#c2410c' : '#ea7a3b';
  return AK_BAND_COLORS[kind.charCodeAt(0) - 48] || '#94a3b8';
}

function akDrawBackground(ctx) {
  const g = ctx.createLinearGradient(0, AK_HUD_H, 0, AK_CS_H);
  g.addColorStop(0, '#0b1120');
  g.addColorStop(1, '#111c34');
  ctx.fillStyle = g;
  ctx.fillRect(0, AK_HUD_H, AK_CS_W, AK_CS_H - AK_HUD_H);
  // Open-space carpet tiles.
  ctx.strokeStyle = 'rgba(148,163,184,.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= AK_CS_W; x += 32) {
    ctx.beginPath(); ctx.moveTo(x + 0.5, AK_HUD_H); ctx.lineTo(x + 0.5, AK_CS_H); ctx.stroke();
  }
  for (let y = AK_HUD_H; y <= AK_CS_H; y += 32) {
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(AK_CS_W, y + 0.5); ctx.stroke();
  }
}

function akDrawBricks(ctx, st) {
  const S = AK_SCALE;
  for (let i = 0; i < st.hp.length; i += 1) {
    const hp = st.hp[i];
    if (hp <= 0) continue;
    const c = i % AK_COLS;
    const r = (i - c) / AK_COLS;
    const x = c * AK_BRICK_W * S + 1;
    const y = AK_HUD_H + (AK_TOP + r * AK_BRICK_H) * S + 1;
    const w = AK_BRICK_W * S - 2;
    const h = AK_BRICK_H * S - 2;
    const kind = st.kind[i];
    const base = akBrickColor(kind, hp);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, base);
    g.addColorStop(1, 'rgba(15,23,42,.35)');
    ctx.fillStyle = base;
    akRoundRect(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.fillRect(x + 3, y + 2, w - 6, 2);
    if (kind === 'H' || kind === 'S') {
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(kind === 'S' ? '🔒' : '📁', x + w / 2, y + h / 2 + 1);
      if (hp < akBrickHp(kind)) {
        ctx.strokeStyle = 'rgba(15,23,42,.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 5, y + 3); ctx.lineTo(x + 11, y + h - 3); ctx.lineTo(x + 16, y + 5);
        ctx.stroke();
      }
    }
  }
}

function akLerp(a, b, k) { return a + (b - a) * k; }

function arkanoidDraw(now = performance.now()) {
  const ctx = akCtx;
  if (!ctx) return;
  const rt = arkanoidRuntime;
  const st = rt?.sim;
  const S = AK_SCALE;
  const k = rt?.playing && rt.lastTickAt ? Math.max(0, Math.min(1, (now - rt.lastTickAt) / AK_TICK_MS)) : 1;

  akDrawBackground(ctx);
  if (st) {
    akDrawBricks(ctx, st);

    // Capsules.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    st.capsules.forEach(c => {
      const look = AK_CAPSULE_LOOK[c.kind] || AK_CAPSULE_LOOK[0];
      const x = c.x / AK_FP * S;
      const y = AK_HUD_H + c.y / AK_FP * S;
      ctx.fillStyle = look.color;
      akRoundRect(ctx, x, y, AK_CAPSULE_W * S, AK_CAPSULE_H * S, 6);
      ctx.fill();
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(look.icon, x + AK_CAPSULE_W * S / 2, y + AK_CAPSULE_H * S / 2 + 1);
    });

    // Paddle — a keyboard.
    const prevPc = rt?.prev ? rt.prev.pc : st.pc;
    const pc = akLerp(prevPc, st.pc, k) / AK_FP * S;
    const pw = akPaddleW(st) * S;
    const px = pc - pw / 2;
    const py = AK_HUD_H + AK_PADDLE_Y * S;
    ctx.shadowColor = st.wide > 0 ? '#38bdf8' : '#60a5fa';
    ctx.shadowBlur = 12;
    const pg = ctx.createLinearGradient(0, py, 0, py + AK_PADDLE_H * S);
    pg.addColorStop(0, '#e2e8f0');
    pg.addColorStop(1, '#64748b');
    ctx.fillStyle = pg;
    akRoundRect(ctx, px, py, pw, AK_PADDLE_H * S, 4);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(15,23,42,.45)';
    for (let kx = px + 5; kx < px + pw - 6; kx += 6) ctx.fillRect(kx, py + 3, 4, 3);

    // Balls.
    st.balls.forEach((b, i) => {
      const pb = rt?.prev?.balls?.[i];
      const bx = (pb && !b.stuck ? akLerp(pb.x, b.x, k) : b.x) / AK_FP * S;
      const by = AK_HUD_H + (pb && !b.stuck ? akLerp(pb.y, b.y, k) : b.y) / AK_FP * S;
      const r = AK_BALL * S / 2;
      ctx.shadowColor = '#fde68a';
      ctx.shadowBlur = 14;
      const bg = ctx.createRadialGradient(bx + r - 2, by + r - 2, 1, bx + r, by + r, r);
      bg.addColorStop(0, '#ffffff');
      bg.addColorStop(1, '#fbbf24');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(bx + r, by + r, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    });
  }

  // Particles & floating text (cosmetic, runtime-only).
  if (rt) {
    rt.particles = rt.particles.filter(p => p.until > now);
    rt.particles.forEach(p => {
      const t = 1 - (p.until - now) / p.life;
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x + p.vx * t * 30, p.y + p.vy * t * 30 + t * t * 20, 3, 3);
    });
    ctx.globalAlpha = 1;
    rt.floats = rt.floats.filter(f => f.until > now);
    rt.floats.forEach(f => {
      const t = 1 - (f.until - now) / 900;
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = f.color;
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(f.text, f.x, f.y - t * 26);
    });
    ctx.globalAlpha = 1;
  }

  // HUD.
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, AK_CS_W, AK_HUD_H);
  ctx.fillStyle = 'rgba(56,189,248,.35)';
  ctx.fillRect(0, AK_HUD_H - 1, AK_CS_W, 1);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.fillText(String(st ? Math.min(AK_MAX_SCORE, st.score) : 0), 12, AK_HUD_H / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#93c5fd';
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.fillText(st ? 'PIĘTRO ' + (st.level + 1) + ' · ' + AK_LEVEL_NAMES[st.level % AK_LEVELS.length] : '', AK_CS_W / 2, AK_HUD_H / 2);
  ctx.textAlign = 'right';
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillText(st ? '❤️'.repeat(Math.max(0, st.lives)) : '', AK_CS_W - 10, AK_HUD_H / 2);

  if (st && rt?.playing && st.balls.some(b => b.stuck)) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(226,232,240,.8)';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillText('Kliknij / spacja, żeby wystrzelić', AK_CS_W / 2, AK_HUD_H + 330 * S / 2);
  }

  if (!rt?.playing) {
    ctx.fillStyle = 'rgba(2,6,23,.74)';
    ctx.fillRect(0, AK_HUD_H, AK_CS_W, AK_CS_H - AK_HUD_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (st && st.over) {
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.fillText(st.tick >= AK_MAX_TICKS ? 'KONIEC ZMIANY!' : 'KONIEC GRY', AK_CS_W / 2, AK_HUD_H + 170);
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 46px system-ui, sans-serif';
      ctx.fillText(String(Math.min(AK_MAX_SCORE, st.score)), AK_CS_W / 2, AK_HUD_H + 225);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Pięter: ' + st.cleared + ' · cegieł: ' + st.bricks + ' · kapsułek: ' + st.capsulesCaught, AK_CS_W / 2, AK_HUD_H + 268);
    } else {
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 30px system-ui, sans-serif';
      ctx.fillText('ARKANOID G6', AK_CS_W / 2, AK_HUD_H + 180);
      ctx.font = '30px system-ui, sans-serif';
      ctx.fillText('🧱 ⌨️ ✨', AK_CS_W / 2, AK_HUD_H + 228);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Kliknij, żeby zacząć. Trzy życia, sześć pięter.', AK_CS_W / 2, AK_HUD_H + 272);
    }
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function arkanoidSetStats() {
  const st = arkanoidRuntime?.sim;
  if (!st) return;
  if (akScoreEl)  akScoreEl.textContent  = String(Math.min(AK_MAX_SCORE, st.score));
  if (akLevelEl)  akLevelEl.textContent  = String(st.level + 1);
  if (akLivesEl)  akLivesEl.textContent  = String(Math.max(0, st.lives));
  if (akBricksEl) akBricksEl.textContent = String(st.bricks);
}

// ── Loop ────────────────────────────────────────────────────────────────────
// Fixed 20 ms ticks paced by wall time. A gap longer than AK_MAX_CATCHUP_TICKS
// (a backgrounded tab, a debugger) is treated as a PAUSE rather than caught up:
// running two seconds of Breakout unattended would just drop the ball. The
// server's guard (elapsed wall clock ≥ ticks × 20 ms) is satisfied by pausing,
// since a paused round only ever takes LONGER than its ticks.

function akTickOnce(rt) {
  const st = rt.sim;
  // Inputs go into the log exactly as the replay will apply them: stamped with
  // the tick they precede, and only when they change something.
  const target = akCurrentTarget(rt);
  if (target !== null && target !== st.target) {
    akInput(st, target);
    rt.inputLog.push(st.tick, target);
  }
  if (rt.pendingLaunch) {
    rt.pendingLaunch = false;
    if (st.balls.some(b => b.stuck)) {
      akInput(st, -1);
      rt.inputLog.push(st.tick, -1);
    }
  }
  rt.prev = { pc: st.pc, balls: st.balls.map(b => ({ x: b.x, y: b.y })) };
  const before = { score: st.score, bricks: st.bricks, lives: st.lives, level: st.level, caps: st.capsulesCaught, hp: st.hp.slice() };
  akTick(st);
  akFx(rt, before);
}

function akCurrentTarget(rt) {
  const st = rt.sim;
  if (rt.keys.left || rt.keys.right) {
    return rt.keys.left && !rt.keys.right ? 0 : rt.keys.right && !rt.keys.left ? AK_W : Math.round(st.pc / AK_FP);
  }
  return rt.pendingTarget;
}

function akFx(rt, before) {
  const st = rt.sim;
  const now = performance.now();
  const S = AK_SCALE;
  if (st.level === before.level) {
    for (let i = 0; i < st.hp.length; i += 1) {
      if (before.hp[i] > 0 && st.hp[i] === 0) {
        const c = i % AK_COLS;
        const r = (i - c) / AK_COLS;
        const cx = (c + 0.5) * AK_BRICK_W * S;
        const cy = AK_HUD_H + (AK_TOP + (r + 0.5) * AK_BRICK_H) * S;
        const color = akBrickColor(st.kind[i], 1);
        for (let n = 0; n < 7; n += 1) {
          rt.particles.push({ x: cx, y: cy, vx: Math.random() * 2 - 1, vy: Math.random() * 2 - 1.4, color, life: 520, until: now + 520 });
        }
      }
    }
  } else {
    rt.floats.push({ x: AK_CS_W / 2, y: AK_HUD_H + 300, color: '#86efac', text: 'Piętro zaliczone! +' + (st.score - before.score), until: now + 900 });
  }
  if (st.capsulesCaught > before.caps) {
    rt.floats.push({ x: st.pc / AK_FP * S, y: AK_HUD_H + AK_PADDLE_Y * S - 12, color: '#fde68a', text: 'bonus!', until: now + 900 });
  }
  if (st.lives < before.lives) {
    rt.floats.push({ x: AK_CS_W / 2, y: AK_HUD_H + 320, color: '#fca5a5', text: '−1 życie', until: now + 900 });
  }
}

function arkanoidLoop(now) {
  const rt = arkanoidRuntime;
  if (!rt?.playing) return;
  now = now || performance.now();
  let dt = now - rt.lastFrame;
  rt.lastFrame = now;
  if (dt > AK_MAX_CATCHUP_TICKS * AK_TICK_MS) dt = AK_TICK_MS;   // pause, don't catch up
  rt.clock += dt;
  let n = 0;
  while (rt.sim.tick < Math.floor(rt.clock / AK_TICK_MS) && !rt.sim.over && n < AK_MAX_CATCHUP_TICKS) {
    akTickOnce(rt);
    rt.lastTickAt = now;
    n += 1;
  }
  arkanoidSetStats();
  arkanoidDraw(now);
  if (rt.sim.over) { finishArkanoidRound(); return; }
  rt.raf = requestAnimationFrame(arkanoidLoop);
}

function stopArkanoidRound() {
  const rt = arkanoidRuntime;
  if (rt?.raf) cancelAnimationFrame(rt.raf);
  const wasArchive = rt?.archiveMode || false;
  arkanoidRuntime = newArkanoidRuntime();
  arkanoidResetBoard(1);
  arkanoidRuntime.archiveMode = wasArchive;
  if (akStartBtn) { akStartBtn.disabled = false; akStartBtn.textContent = 'Start rundy'; }
  arkanoidSetStats();
  arkanoidInitCanvas();
  arkanoidDraw();
}

function beginArkanoidRound(seed, options = {}) {
  stopArkanoidRound();
  const rt = arkanoidResetBoard(seed);
  rt.playing = true;
  rt.archiveMode = !!options.archiveMode;
  rt.roundId = options.roundId || null;
  rt.clock = 0;
  rt.lastFrame = performance.now();
  rt.lastTickAt = rt.lastFrame;
  if (akStartBtn) { akStartBtn.disabled = true; akStartBtn.textContent = 'Runda trwa'; }
  if (akStatus) akStatus.textContent = 'Myszka, palec albo ← →. Kliknięcie lub spacja wystrzeliwuje piłkę.';
  arkanoidSetStats();
  arkanoidInitCanvas();
  rt.raf = requestAnimationFrame(arkanoidLoop);
}

async function startArkanoidRound() {
  const rt = arkanoidRuntime;
  if (rt?.playing || rt?.submitting) return;

  if (allGamesMode) {
    try { await payArcadeEntry(allGamesSelectedGame); }
    catch (e) { showToast('❌ Nie udało się wejść do gry.'); return; }
    beginArkanoidRound((Math.floor(Math.random() * 0xfffffff) + 1) >>> 0, { archiveMode: true });
    return;
  }

  if (akStartBtn) { akStartBtn.disabled = true; akStartBtn.textContent = 'Ładuję...'; }
  if (akStatus) akStatus.textContent = 'Przygotowuję rundę...';
  try {
    const data = await invokeArkanoid({ action: 'start' });
    renderArkanoidState(data);
    beginArkanoidRound(Number(data.round.seed) || 1, { roundId: data.round.id });
  } catch (err) {
    showToast('❌ ' + err.message);
    if (akStatus) akStatus.textContent = 'Nie udało się wystartować rundy.';
    if (akStartBtn) { akStartBtn.disabled = false; akStartBtn.textContent = 'Start rundy'; }
  }
}

async function finishArkanoidRound() {
  const rt = arkanoidRuntime;
  // `settled` is the one-way latch (see finishSaperRound): only a new round
  // clears it, so a second call can never resubmit the same round.
  if (!rt || rt.submitting || rt.settled) return;
  rt.playing = false;
  rt.submitting = true;
  rt.settled = true;
  if (rt.raf) cancelAnimationFrame(rt.raf);
  rt.floats = [];        // a „−1 życie" must not float over the result card
  rt.particles = [];
  arkanoidSetStats();
  arkanoidDraw();

  const score = Math.min(AK_MAX_SCORE, rt.sim.score);

  if (rt.archiveMode || !rt.roundId) {
    if (!allGamesMode) {
      rt.submitting = false;
      if (akStartBtn) { akStartBtn.disabled = false; akStartBtn.textContent = 'Zagraj ponownie'; }
      if (akStatus) akStatus.textContent = 'Demo — wynik: ' + score + ' (nie zapisano).';
      return;
    }
    if (akStartBtn) { akStartBtn.disabled = true; akStartBtn.textContent = 'Zapisuję...'; }
    try {
      await recordArcadeScore('arkanoid', score);
      if (akStatus) akStatus.textContent = 'Wynik: ' + score + ' · zapisano w rankingu arcade!';
      showToast('✅ Wynik zapisany: ' + score);
      loadArcadeScores('arkanoid');
    } catch (err) {
      if (akStatus) akStatus.textContent = 'Wynik: ' + score + ' (błąd zapisu).';
      showToast('❌ Nie udało się zapisać wyniku.');
    } finally {
      rt.submitting = false;
      if (akStartBtn) { akStartBtn.disabled = false; akStartBtn.textContent = 'Zagraj ponownie'; }
    }
    return;
  }

  if (akStartBtn) { akStartBtn.disabled = true; akStartBtn.textContent = 'Zapisuję...'; }
  if (akStatus) akStatus.textContent = 'Zapisuję wynik...';
  try {
    const data = await invokeArkanoid({
      action: 'submit',
      roundId: rt.roundId,
      inputs: rt.inputLog,
      score,
    });
    renderArkanoidState(data);
    showToast('✅ Wynik zapisany: ' + data.score.score);
    if (akStatus) {
      akStatus.textContent = 'Ostatni wynik: ' + data.score.score
        + ' (piętro ' + (data.score.levels_cleared + 1) + ', ' + data.score.bricks + ' cegieł).';
    }
  } catch (err) {
    showToast('❌ ' + err.message);
    if (akStatus) akStatus.textContent = 'Nie udało się zapisać wyniku: ' + err.message;
  } finally {
    rt.submitting = false;
    if (akStartBtn) { akStartBtn.disabled = false; akStartBtn.textContent = 'Zagraj ponownie'; }
  }
}

// ── Seasonal networking + leaderboards ──────────────────────────────────────

async function invokeArkanoid(payload) {
  const { data, error } = await sb.functions.invoke('arkanoid-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z Arkanoidem.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd Arkanoida.');
  return data;
}

async function loadArkanoidState(showSpinner = true) {
  if (!arkanoidRuntime) arkanoidResetBoard(1);
  arkanoidSetStats();
  arkanoidInitCanvas();
  arkanoidDraw();
  const weeklyWrap  = document.getElementById('ak-weekly-board');
  const allTimeWrap = document.getElementById('ak-alltime-board');
  const awardsWrap  = document.getElementById('ak-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeArkanoid({ action: 'state' });
    renderArkanoidState(data);
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
    if (akStatus) akStatus.textContent = 'Arkanoid nie jest jeszcze aktywny.';
  }
}

function renderArkanoidState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('ak-week-label');
  if (weekLabel) {
    const range = whackBossWeekRange(data.weekStart);
    weekLabel.textContent = range ? range.short : '';
  }
  renderArkanoidTable(document.getElementById('ak-weekly-board'), data.weekly || [], 'weekly');
  renderArkanoidTable(document.getElementById('ak-alltime-board'), data.allTime || [], 'allTime');
  renderArkanoidAwards(document.getElementById('ak-awards'), data.awards || []);
  if (!arkanoidRuntime?.playing && akStatus) {
    akStatus.textContent = data.myWeekly
      ? 'Twój najlepszy wynik w tym tygodniu: ' + data.myWeekly.score + '.'
      : 'Trzy życia — najlepszy wynik tygodnia trafia do rankingu.';
  }
}

function renderArkanoidTable(wrap, rows, mode) {
  if (!wrap) return;
  rows = rows.filter(r => r.nick !== 'admin');
  if (!rows.length) {
    wrap.replaceChildren(el('p', { className: 'bj-empty' }, mode === 'weekly' ? 'Jeszcze nikt nie zagrał w tym tygodniu.' : 'Brak rekordów.'));
    return;
  }
  const bodyRows = rows.slice(0, 10).map(row => el('tr', {},
    el('td', { className: 'lb-rank' + (row.rank === 1 ? ' gold' : '') }, whackBossRankLabel(row.rank)),
    el('td', { className: 'lb-nick' + (row.user_id === me?.id ? ' me' : '') }, row.nick + (row.user_id === me?.id ? ' (Ty)' : '')),
    el('td', { className: 'lb-num', title: 'Najwyższe piętro' }, String((row.levels_cleared ?? 0) + 1)),
    lbScoreCell(row)
  ));
  wrap.replaceChildren(
    el('table', { className: 'lb-table-compact' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'),
        el('th', {}, 'Nick'),
        el('th', { title: 'Najwyższe piętro' }, '🏢'),
        el('th', { title: 'Najwyższy wynik' }, 'Wynik')
      )),
      el('tbody', {}, ...bodyRows)
    )
  );
}

function renderArkanoidAwards(wrap, awards) {
  if (!wrap) return;
  if (!awards.length) {
    wrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Pierwsze nagrody pojawią się po zakończeniu tygodnia.'));
    return;
  }
  wrap.replaceChildren(...awards.slice(0, 6).map(row => {
    const label = whackBossWeekRange(row.week_start)?.short || '';
    return el('div', { className: 'bj-award-row' },
      el('span', {}, whackBossRankLabel(row.rank) + ' ' + row.nick + (label ? ' · ' + label : '')),
      el('strong', {}, '+' + row.prize_coins + ' 🪙')
    );
  }));
}

// ── Input ───────────────────────────────────────────────────────────────────

function akTargetFromEvent(evt) {
  const canvas = document.getElementById('ak-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return null;
  const x = (evt.clientX - rect.left) * (AK_W / rect.width);
  return Math.max(0, Math.min(AK_W, Math.round(x)));
}

function akGameVisible() {
  return !!akArena && akArena.offsetParent !== null;
}

if (akArena) {
  akArena.addEventListener('contextmenu', evt => evt.preventDefault());
  akArena.addEventListener('pointerdown', evt => {
    const rt = arkanoidRuntime;
    if (!rt?.playing) {
      if (!rt?.submitting) startArkanoidRound();
      return;
    }
    evt.preventDefault();
    const t = akTargetFromEvent(evt);
    if (t !== null) rt.pendingTarget = t;
    rt.pendingLaunch = true;
  });
  akArena.addEventListener('pointermove', evt => {
    const rt = arkanoidRuntime;
    if (!rt?.playing) return;
    const t = akTargetFromEvent(evt);
    if (t !== null) rt.pendingTarget = t;
  });
}

document.addEventListener('keydown', evt => {
  const rt = arkanoidRuntime;
  if (!rt?.playing || !akGameVisible()) return;
  if (evt.key === 'ArrowLeft' || evt.key === 'a' || evt.key === 'A') { rt.keys.left = true; rt.pendingTarget = null; evt.preventDefault(); }
  else if (evt.key === 'ArrowRight' || evt.key === 'd' || evt.key === 'D') { rt.keys.right = true; rt.pendingTarget = null; evt.preventDefault(); }
  else if (evt.key === ' ' || evt.key === 'ArrowUp') { rt.pendingLaunch = true; evt.preventDefault(); }
});
document.addEventListener('keyup', evt => {
  const rt = arkanoidRuntime;
  if (!rt) return;
  const wasHeld = rt.keys.left || rt.keys.right;
  if (evt.key === 'ArrowLeft' || evt.key === 'a' || evt.key === 'A') rt.keys.left = false;
  if (evt.key === 'ArrowRight' || evt.key === 'd' || evt.key === 'D') rt.keys.right = false;
  // Releasing the key parks the paddle where it is instead of letting it glide
  // on to the wall it was heading for.
  if (wasHeld && !rt.keys.left && !rt.keys.right && rt.sim) rt.pendingTarget = Math.round(rt.sim.pc / AK_FP);
});

if (akStartBtn) akStartBtn.addEventListener('click', startArkanoidRound);

arkanoidInitCanvas();
if (!arkanoidRuntime) arkanoidResetBoard(1);
arkanoidDraw();
