// ════════════════════════════════════════════════════════════════════════════
//  „Automat Monet G6" — physics core (no DOM, no network, no three.js)
// ════════════════════════════════════════════════════════════════════════════
//  Every coin is a Rapier rigid body. The pusher is a kinematic body moved
//  only by setNextKinematicTranslation, so it moves coins only through contact.
//  Nothing in here ever sets a coin's position after it has been spawned —
//  what falls off the front edge is decided by the solver, full stop.
//
//  This file is loaded twice: by tabs/coinpusher.js in the browser, and by
//  scripts/coinpusher-sim.mjs in Node (via vm) to stress-test the pile and
//  measure how much of what goes in comes out at the front. Tuning is always
//  measured on this exact code — never re-transcribe it into the harness.
//
//  Units: centimetres, seconds, grams. +x right, +y up, +z towards the player.
//
//  ⚠️ The money is NOT here. A collected coin is reported as {id, where}; the
//  server pays each id once, and only if it is a coin it put in this player's
//  machine (see supabase/functions/coinpusher-action). Physics decides what
//  falls; the server decides whether that coin existed.
// ════════════════════════════════════════════════════════════════════════════
(function (root) {
  'use strict';

  // ── Configuration ─────────────────────────────────────────────────────────
  // Every number that shapes the machine lives here. The debug tuning panel
  // edits a copy of this object; nothing below hard-codes a dimension.
  const CP_CONFIG = {
    machine: {
      halfWidth: 24,          // playfield is 48 cm wide: a big, casino-floor cabinet
      bedBackZ: -26,          // lower bed runs under the pusher to here
      bedFrontZ: 12,          // the prize edge
      bedThickness: 1.5,
      wallHeight: 44,
      gutterStartZ: 1,        // side walls stop here; beyond it the bed edge is open
      gutterWidth: 3.2,       // lane between the open bed edge and the cabinet wall
      chuteDepth: 4,          // front chute, from bedFrontZ to the glass
      separatorZ: 12,         // wall dividing each gutter lane from the prize chute
      collectDepth: 2.5,      // a coin must be fully this far below the bed to count
      lostY: -45,
    },
    pusher: {
      height: 3.2,            // top of the block is tier 1
      depth: 20,
      backZ: -6.5,            // front face at the back of the stroke
      travel: 8,              // cm of stroke
      forwardTime: 1.45,      // s, crank-driven (sinusoidal) stroke
      returnTime: 1.45,
      pauseFront: 0.25,
      pauseBack: 0.35,
      wiperZ: -15,            // fixed wiper that scrapes tier 1 as the block retracts
      wiperGap: 0.05,         // well under the thinnest coin (0.28)
      speed: 1,               // turbo multiplies this, never the physics dt
    },
    drop: {
      y: 31.5,                // above the top row of pins
      z: -11,                 // = pins.z: the coin falls inside the pin board's slot
      zJitter: 0.06,          // the slot is only 0.8 cm deep
      minX: -21.6,
      maxX: 21.6,
      tiltJitter: 0.1,        // rad of random tilt on release
      spinJitter: 3,          // rad/s, in the board's plane
      downSpeed: 140,         // cm/s the coin leaves the slot with — fired in, so spammed coins land fast
    },
    physics: {
      // 120 Hz, not 60: a coin is 3 mm thick, and at 1/60 s a pile of tilted
      // coins leaning on each other never stops rocking (measured: mean
      // angular speed 0.035 rad/s after 8 s at 60 Hz vs 0.008 at 120 Hz). With
      // the solver iterations dropped to 4 it costs LESS per simulated second,
      // because contacts converge instead of fighting.
      dt: 1 / 120,
      maxStepsPerFrame: 8,
      gravity: -981,
      // Rapier's tolerances and sleep thresholds are relative to lengthUnit.
      // The world is in cm, so the default (1) makes a settled coin twitching
      // at 0.002 cm/s count as "moving" and the pile never sleeps.
      lengthUnit: 5,
      solverIterations: 4,
      pgsIterations: 1,
      coinFriction: 0.32,
      bedFriction: 0.28,
      pusherFriction: 0.35,
      wallFriction: 0.12,
      coinRestitution: 0.08,
      bedRestitution: 0.05,
      linearDamping: 0.15,
      angularDamping: 0.6,
      density: 8.9,           // g/cm³, brass-ish
      ccdSpeed: 40,           // cm/s above which a coin keeps CCD on
      impactDv: 35,           // cm/s of velocity change in one step that counts as a clink
      maxSpeed: 450,          // safety net only — an honest pile never gets near it
    },
    // PHYSICAL shapes. ⚠️ Every ordinary coin — 1 🪙 house coin, any stake,
    // gold — is the SAME body: same size, same mass. If a 50 🪙 coin were
    // bigger than a 5 🪙 one, the machine's return would depend on the stake.
    // Coins differ only in how they look (see cpLookFor). The jackpot token is
    // the one deliberately different object: big, heavy, and slow to push.
    shapes: {
      coin:    { r: 1.65, h: 0.36, border: 0.06 },   // ~33 mm: a big, chunky arcade token
      jackpot: { r: 2.3, h: 0.55, border: 0.09 },
    },
    // ── Cabinet features (all physical: static or kinematic colliders) ──────
    // Pachinko-style pin board: every thrown coin falls through a 0.8 cm slot
    // between two panes, bouncing off staggered pins, before it lands on tier 1.
    // ⚠️ The gap that matters is DIAGONAL (a pin to its neighbours in the next
    // row), not the same-row one: a coin deflected by a pin must pass between it
    // and the pin diagonally above. 4.6 × 2.8 spacing left 3.06 cm there — less
    // than the 3.3 cm coin — and 243 of 250 test coins jammed. 5.0 × 3.7 leaves
    // ≥ 3.9 cm everywhere.
    pins: {
      enabled: true,
      z: -11,
      slot: 0.8,
      yTop: 29,
      rows: 5,
      rowGap: 3.7,
      spacingX: 5.0,
      radius: 0.28,
      // A coin at rest in the pin field this long gets a small nudge (a
      // cabinet's vibrator). ~1 in 60 rapid drops wedges for good otherwise,
      // and a shared machine never resets, so the board would slowly fill.
      unjamAfter: 2,
      // Pockets: a coin whose centre passes this band below the last row, inside
      // a pocket's x-range, triggers it once. Rewards are issued by the SERVER
      // from the machine's bank; the host only reports the pass.
      pocketTop: 12.4,
      pocketBottom: 10.0,
      pockets: [
        { name: 'rain', x: -15, w: 3.4 },
        { name: 'gold', x: 15, w: 3.4 },
        { name: 'tower', x: 0, w: 4.4 },   // the jackpot tower's mouth
      ],
    },
    // A slowly turning disc set into the bed: coins riding it are carried round
    // and shoved into their neighbours.
    turntable: { enabled: true, x: 0, z: 6.8, r: 4.8, speed: 0.45, friction: 0.45 },
    // Guard gates along the open side edges: they rise out of the bed for part
    // of every cycle and hold the pile back from the gutters.
    gates: { enabled: true, z0: 3.5, z1: 10.5, thick: 0.5, height: 2.2, period: 7, upFraction: 0.45 },
    // Jackpot tower: a bucket under the centre pocket. It catches coins; when it
    // holds `capacity` of them it tips forward and pours them onto tier 1, and
    // the server adds a bank-funded shower on top.
    tower: { enabled: true, floorY: 6.0, w: 4.6, d: 3.2, h: 3.0, wall: 0.25,
             capacity: 6, tipAngle: 1.95, tipTime: 1.1, holdTime: 0.9, returnTime: 1.2 },
  };

  // How a server coin row is simulated (shape) and drawn (look).
  function cpShapeFor(kind) { return kind === 'jackpot' ? 'jackpot' : 'coin'; }
  function cpLookFor(kind, value) {
    if (kind === 'gold' || kind === 'jackpot') return kind;
    if (kind === 'house' && value < 100) return 'house';
    if (value >= 100) return 'coin100';
    if (value >= 50) return 'coin50';
    if (value >= 25) return 'coin25';
    if (value >= 10) return 'coin10';
    return 'coin5';
  }

  function cpMergeConfig(base, over) {
    const out = {};
    for (const k of Object.keys(base)) {
      const b = base[k];
      const o = over && over[k];
      if (b && typeof b === 'object' && !Array.isArray(b)) out[k] = cpMergeConfig(b, o);
      else out[k] = (o !== undefined && typeof o === typeof b) ? o : b;
    }
    return out;
  }

  // Pusher front-face offset (0 … travel) at machine time t. A crank drives
  // the block, so each stroke is a half-cosine: it eases out of and into the
  // pauses instead of snapping, which is what a real motor-and-crank does.
  // The cycle STARTS in the back pause, so t = 0 is "parked": a machine that
  // has never been started (or was just restored) doesn't move until a coin
  // goes in.
  function cpPusherOffset(p, t) {
    const cycle = p.pauseBack + p.forwardTime + p.pauseFront + p.returnTime;
    let u = t % cycle;
    if (u < 0) u += cycle;
    if (u < p.pauseBack) return 0;
    u -= p.pauseBack;
    if (u < p.forwardTime) return p.travel * (1 - Math.cos(Math.PI * u / p.forwardTime)) / 2;
    u -= p.forwardTime;
    if (u < p.pauseFront) return p.travel;
    u -= p.pauseFront;
    return p.travel * (1 + Math.cos(Math.PI * Math.min(u, p.returnTime) / p.returnTime)) / 2;
  }

  function cpPusherPhase(p, t) {
    const cycle = p.pauseBack + p.forwardTime + p.pauseFront + p.returnTime;
    let u = t % cycle;
    if (u < 0) u += cycle;
    if (u < p.pauseBack) return 'pause-back';
    u -= p.pauseBack;
    if (u < p.forwardTime) return 'forward';
    u -= p.forwardTime;
    if (u < p.pauseFront) return 'pause-front';
    return 'return';
  }

  // Small seeded PRNG so a test seed reproduces the same starting pile.
  function cpRng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  // Quaternion for a tilt of `ax` about X then `az` about Z (small-angle use).
  function cpQuatXZ(ax, az) {
    const cx = Math.cos(ax / 2), sx = Math.sin(ax / 2);
    const cz = Math.cos(az / 2), sz = Math.sin(az / 2);
    // q = qz * qx
    return { w: cz * cx, x: cz * sx, y: sz * sx, z: sz * cx };
  }

  // The same tilt, then turned by `yaw` about the vertical — so the faces of
  // a pile don't all read the same way up like a printed sheet.
  function cpQuatYXZ(yaw, ax, az) {
    const t = cpQuatXZ(ax, az);
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
    // q = qy * t
    return { w: cy * t.w - sy * t.y, x: cy * t.x + sy * t.z, y: cy * t.y + sy * t.w, z: cy * t.z - sy * t.x };
  }

  // ── The simulation ────────────────────────────────────────────────────────
  function cpCreateSim(RAPIER, options) {
    const opts = options || {};
    const cfg = cpMergeConfig(CP_CONFIG, opts.config || {});
    const M = cfg.machine, P = cfg.pusher, PH = cfg.physics;

    const world = new RAPIER.World({ x: 0, y: PH.gravity, z: 0 });
    world.timestep = PH.dt;
    const ip = world.integrationParameters;
    if ('lengthUnit' in ip) ip.lengthUnit = PH.lengthUnit;
    ip.numSolverIterations = PH.solverIterations;
    if ('numInternalPgsIterations' in ip) ip.numInternalPgsIterations = PH.pgsIterations;
    const events = new RAPIER.EventQueue(true);

    const sim = {
      RAPIER, cfg, world, events,
      time: 0,              // machine (pusher) time — turbo speeds this up
      ticks: 0,
      coins: new Map(),     // id → coin
      byCollider: new Map(),// collider handle → coin
      pools: {},            // kind → [coin]
      statics: [],          // {name, hx, hy, hz, x, y, z, glass} for the renderer
      pusherBody: null,
      pusherOffset: 0,
      onCollect: null,      // (coin, where) → void
      onImpact: null,       // (coin, dv cm/s) → void — for audio/sparks only
      onPocket: null,       // (coin, pocketName) → void — a coin passed a pin-board pocket
      onTowerTip: null,     // (coinsInside) → void — the jackpot tower just started tipping
      movers: [],           // kinematic features for the renderer: {name, body, parts}
      mtime: 0,             // mechanism time (turntable/gates/tower) — frozen with the motor
      tower: null,
      collecting: true,     // false while settling: nothing may be claimed then
      motorOn: true,        // false = finish the stroke, then park at the back
      stats: { prize: 0, gutter: 0, lost: 0, stepMs: 0, contacts: 0 },
    };

    function fixedBox(name, hx, hy, hz, x, y, z, friction, glass) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
      const col = world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setFriction(friction)
          .setRestitution(PH.bedRestitution),
        body);
      sim.statics.push({ name, hx, hy, hz, x, y, z, glass: !!glass, handle: col.handle });
      return body;
    }

    // Lower bed (tier 2). Runs from under the back of the pusher to the prize edge.
    const bedLen = M.bedFrontZ - M.bedBackZ;
    fixedBox('bed', M.halfWidth, M.bedThickness / 2, bedLen / 2,
      0, -M.bedThickness / 2, M.bedBackZ + bedLen / 2, PH.bedFriction);

    // Side walls hold the pile until gutterStartZ; past it the bed edge is open.
    const wallLen = M.gutterStartZ - M.bedBackZ;
    for (const s of [-1, 1]) {
      fixedBox(s < 0 ? 'wallL' : 'wallR', 0.5, M.wallHeight / 2, wallLen / 2,
        s * (M.halfWidth + 0.5), M.wallHeight / 2 - 1, M.bedBackZ + wallLen / 2, PH.wallFriction, true);
      // Outer cabinet wall of the gutter lane, from the wall's end to the glass.
      const outerLen = (M.bedFrontZ + M.chuteDepth) - M.gutterStartZ + 1;
      fixedBox(s < 0 ? 'gutterOuterL' : 'gutterOuterR', 0.5, (M.wallHeight + 30) / 2, outerLen / 2,
        s * (M.halfWidth + M.gutterWidth + 0.5), (M.wallHeight - 30) / 2 - 1,
        M.gutterStartZ - 1 + outerLen / 2, PH.wallFriction, true);
      // Separator between the gutter lane and the prize chute.
      fixedBox(s < 0 ? 'sepL' : 'sepR', M.gutterWidth / 2, 14, 0.15,
        s * (M.halfWidth + M.gutterWidth / 2), -14 - 0.05, M.separatorZ + 0.15, PH.wallFriction);
    }

    // Front glass (chute front) and the catch floor far below.
    const outerHalf = M.halfWidth + M.gutterWidth + 1;
    fixedBox('glassFront', outerHalf, (M.wallHeight + 30) / 2, 0.3,
      0, (M.wallHeight - 30) / 2 - 1, M.bedFrontZ + M.chuteDepth + 0.3, PH.wallFriction, true);
    fixedBox('catch', outerHalf + 2, 1, 30, 0, -32, 0, 0.5);

    // Wiper: a fixed plate hanging just above the pusher top, so tier-1 coins
    // are held back as the block slides out from under them.
    // ⚠️ Keep its lower edge SQUARE. A rounded (capsule) edge was tried: it
    // presses every coin it touches DOWN onto the moving block, friction then
    // locks the coin to the block, and tier 1 stops feeding tier 2 — measured,
    // the upper tier hoarded ~200 coins and only ~35% of exits went over the
    // front (vs ~86% with this edge).
    const pTop = P.height;
    fixedBox('wiper', M.halfWidth, M.wallHeight / 2, 0.5,
      0, pTop + P.wiperGap + M.wallHeight / 2, P.wiperZ - 0.5, PH.wallFriction);

    // The pusher block — kinematic, driven by position only.
    const pusherHz = P.depth / 2;
    const pusherZ0 = P.backZ - pusherHz;
    const pBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, P.height / 2, pusherZ0));
    const pCol = world.createCollider(
      RAPIER.ColliderDesc.cuboid(M.halfWidth - 0.02, P.height / 2, pusherHz)
        .setFriction(PH.pusherFriction)
        .setRestitution(PH.bedRestitution),
      pBody);
    sim.pusherBody = pBody;
    sim.pusherHandle = pCol.handle;
    sim.pusherShape = { hx: M.halfWidth - 0.02, hy: P.height / 2, hz: pusherHz, z0: pusherZ0 };

    // ── Pin board ──────────────────────────────────────────────────────────
    const PN = cfg.pins;
    if (PN.enabled) {
      const paneTop = cfg.drop.y + 3, paneBottom = PN.pocketTop + 0.5;
      const paneH = paneTop - paneBottom;
      for (const s of [-1, 1]) {
        fixedBox(s < 0 ? 'pinBack' : 'pinGlass', M.halfWidth, paneH / 2, 0.1,
          0, paneBottom + paneH / 2, PN.z + s * (PN.slot / 2 + 0.1), PH.wallFriction, s > 0);
      }
      const rot = { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };   // cylinder axis Y → Z
      const pinBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      sim.pins = [];
      for (let r = 0; r < PN.rows; r++) {
        const y = PN.yTop - r * PN.rowGap;
        const off = (r % 2) * PN.spacingX / 2;
        // Keep ≥ 4 cm between the outermost pin and the wall, or a coin wedges
        // there (it did: every jam in the first test sat against a wall).
        for (let x = -M.halfWidth + PN.spacingX / 2 + off; x < M.halfWidth - 1; x += PN.spacingX) {
          if (Math.abs(x) > M.halfWidth - 4.4) continue;
          world.createCollider(RAPIER.ColliderDesc.cylinder(PN.slot / 2 + 0.1, PN.radius)
            .setTranslation(x, y, PN.z).setRotation(rot)
            .setFriction(0.2).setRestitution(0.35), pinBody);
          sim.pins.push({ x, y, z: PN.z });
        }
      }
    }

    // ── Turntable ──────────────────────────────────────────────────────────
    const TT = cfg.turntable;
    if (TT.enabled) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(TT.x, 0.02, TT.z));
      world.createCollider(RAPIER.ColliderDesc.cylinder(0.1, TT.r).setTranslation(0, -0.08, 0)
        .setFriction(TT.friction).setRestitution(PH.bedRestitution), body);
      sim.movers.push({ name: 'turntable', body, parts: [{ cyl: true, r: TT.r, hh: 0.1, x: 0, y: -0.08, z: 0 }] });
    }

    // ── Side gates ─────────────────────────────────────────────────────────
    const GT = cfg.gates;
    if (GT.enabled) {
      const hz = (GT.z1 - GT.z0) / 2;
      for (const s of [-1, 1]) {
        const x = s * (M.halfWidth - GT.thick / 2 - 0.05);
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(x, -GT.height / 2 - 0.3, GT.z0 + hz));
        world.createCollider(RAPIER.ColliderDesc.cuboid(GT.thick / 2, GT.height / 2, hz)
          .setFriction(PH.wallFriction).setRestitution(PH.bedRestitution), body);
        sim.movers.push({ name: 'gate', body, x, zc: GT.z0 + hz,
          parts: [{ hx: GT.thick / 2, hy: GT.height / 2, hz, x: 0, y: 0, z: 0 }] });
      }
    }

    // ── Jackpot tower (a tipping bucket, hinged at its front-bottom edge) ───
    const TW = cfg.tower;
    if (TW.enabled && PN.enabled) {
      const hingeZ = PN.z + TW.d / 2, hingeY = TW.floorY;
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(0, hingeY, hingeZ));
      const w = TW.wall, parts = [
        { hx: TW.w / 2, hy: w / 2, hz: TW.d / 2, x: 0, y: -w / 2, z: -TW.d / 2 },              // floor
        { hx: TW.w / 2, hy: TW.h / 2, hz: w / 2, x: 0, y: TW.h / 2, z: -TW.d + w / 2 },       // back
        { hx: TW.w / 2, hy: TW.h * 0.35, hz: w / 2, x: 0, y: TW.h * 0.35, z: -w / 2 },        // low front lip
        { hx: w / 2, hy: TW.h / 2, hz: TW.d / 2, x: -TW.w / 2 + w / 2, y: TW.h / 2, z: -TW.d / 2 },
        { hx: w / 2, hy: TW.h / 2, hz: TW.d / 2, x: TW.w / 2 - w / 2, y: TW.h / 2, z: -TW.d / 2 },
      ];
      for (const p of parts) {
        world.createCollider(RAPIER.ColliderDesc.cuboid(p.hx, p.hy, p.hz).setTranslation(p.x, p.y, p.z)
          .setFriction(0.3).setRestitution(PH.bedRestitution), body);
      }
      sim.movers.push({ name: 'tower', body, parts });
      sim.tower = { body, hingeY, hingeZ, phase: 'idle', t: 0, angle: 0, count: 0, checkIn: 0 };
    }

    // Is (x, y, z) inside the space the tower occupies (for spawn placement)?
    function inTowerZone(x, y, z, margin) {
      if (!sim.tower) return false;
      const m = margin || 0;
      return Math.abs(x) < TW.w / 2 + m && y > TW.floorY - m - 0.3 && y < TW.floorY + TW.h + m &&
             z > sim.tower.hingeZ - TW.d - m && z < sim.tower.hingeZ + m;
    }
    sim.inTowerZone = inTowerZone;

    // ── Coins ───────────────────────────────────────────────────────────────
    function makeBody(shape) {
      const k = cfg.shapes[shape] || cfg.shapes.coin;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(0, -100, 0)
          .setLinearDamping(PH.linearDamping)
          .setAngularDamping(PH.angularDamping)
          .setCanSleep(true)
          .setEnabled(false));
      const hh = Math.max(0.01, k.h / 2 - k.border);
      const rr = Math.max(0.05, k.r - k.border);
      const col = world.createCollider(
        RAPIER.ColliderDesc.roundCylinder(hh, rr, k.border)
          .setDensity(PH.density)
          .setFriction(PH.coinFriction)
          .setRestitution(PH.coinRestitution),
        body);
      return { body, collider: col, shape, r: k.r, h: k.h, R: Math.hypot(k.r, k.h / 2),
               pv: { x: 0, y: 0, z: 0 } };
    }

    // Spawn a coin (or recycle one from the pool). `c` = {id, kind, value, x,y,z,
    // q:{x,y,z,w}, v:{x,y,z}, w:{x,y,z}, falling}. `kind` is the SERVER kind
    // (house/standard/gold/jackpot/rain).
    function spawnCoin(c) {
      const shape = cpShapeFor(c.kind);
      const pool = sim.pools[shape] || (sim.pools[shape] = []);
      const coin = pool.pop() || makeBody(shape);
      coin.id = c.id;
      coin.value = c.value || 0;
      coin.kind = c.kind;
      coin.look = cpLookFor(c.kind, coin.value);
      coin.collected = false;
      coin.pocketed = !!c.falling ? false : true;   // only freshly dropped coins can hit a pocket
      coin.spawnTick = sim.ticks;
      coin.ccd = false;
      coin.jam = 0;
      const b = coin.body;
      b.setEnabled(true);
      b.setTranslation({ x: c.x, y: c.y, z: c.z }, true);
      b.setRotation(c.q || { x: 0, y: 0, z: 0, w: 1 }, true);
      b.setLinvel(c.v || { x: 0, y: 0, z: 0 }, true);
      b.setAngvel(c.w || { x: 0, y: 0, z: 0 }, true);
      if (c.falling) { b.enableCcd(true); coin.ccd = true; }
      const v0 = c.v || { x: 0, y: 0, z: 0 };
      coin.pv.x = v0.x; coin.pv.y = v0.y; coin.pv.z = v0.z;
      b.wakeUp();
      coin.prev = { x: c.x, y: c.y, z: c.z, q: c.q || { x: 0, y: 0, z: 0, w: 1 } };
      sim.coins.set(coin.id, coin);
      sim.byCollider.set(coin.collider.handle, coin);
      return coin;
    }

    function recycleCoin(coin) {
      sim.coins.delete(coin.id);
      sim.byCollider.delete(coin.collider.handle);
      const b = coin.body;
      b.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.setAngvel({ x: 0, y: 0, z: 0 }, false);
      b.setTranslation({ x: 0, y: -100, z: 0 }, false);
      b.enableCcd(false);
      b.setEnabled(false);
      coin.id = null; coin.value = 0; coin.kind = null; coin.look = null;
      coin.collected = false; coin.ccd = false;
      (sim.pools[coin.shape] || (sim.pools[coin.shape] = [])).push(coin);
    }

    // A player's drop: the coin leaves the slot standing on its edge (face to
    // the player), with a little random tilt and spin — then it is on its own.
    function dropCoin(c, x, rnd) {
      const r = rnd || Math.random;
      const D = cfg.drop;
      const cx = Math.max(D.minX, Math.min(D.maxX, x));
      const tilt = (r() - 0.5) * 2 * D.tiltJitter;
      const q = cpQuatYXZ((r() - 0.5) * 0.04, Math.PI / 2 + tilt * 0.3, (r() - 0.5) * 2 * D.tiltJitter);
      return spawnCoin({
        ...c,
        x: cx + (r() - 0.5) * 0.3, y: D.y, z: D.z + (r() - 0.5) * 2 * (D.zJitter || 0), q,
        v: { x: (r() - 0.5) * 4, y: -D.downSpeed, z: 0 },
        // Spin mostly in the board's plane: out-of-plane spin would just grind
        // the coin against the panes.
        w: { x: (r() - 0.5) * 0.3, y: (r() - 0.5) * 0.3, z: (r() - 0.5) * D.spinJitter },
        falling: true,
      });
    }

    // Where a coin is, fully: a region only counts once the WHOLE coin (its
    // bounding sphere) is below the bed by collectDepth. A coin hanging over
    // the edge, however far, is still in play.
    function classify(t, R) {
      if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.z)) return 'lost';
      if (t.y < M.lostY || Math.abs(t.x) > M.halfWidth + M.gutterWidth + 6 ||
          t.z < M.bedBackZ - 6 || t.z > M.bedFrontZ + M.chuteDepth + 6) return 'lost';
      if (t.y + R > -M.collectDepth) return null;
      // Fully below the bed: in front of the separator it went over the prize
      // edge; anywhere else (a side gutter, the rear return behind the block,
      // or a gutter coin that bounced under the bed) it is the house's.
      return t.z > M.separatorZ ? 'prize' : 'gutter';
    }

    const _pusherT = { x: 0, y: 0, z: 0 };
    let lastOffset = NaN;
    function step() {
      // With the motor off the block finishes its stroke and parks at the back.
      if (sim.motorOn || cpPusherPhase(P, sim.time) !== 'pause-back') sim.time += PH.dt * P.speed;
      sim.pusherOffset = cpPusherOffset(P, sim.time);
      // Only drive the block when it actually moves: re-issuing an unchanged
      // kinematic target still wakes every coin touching it, so a parked
      // pusher would keep the whole pile awake.
      if (sim.pusherOffset !== lastOffset) {
        lastOffset = sim.pusherOffset;
        _pusherT.x = 0; _pusherT.y = P.height / 2; _pusherT.z = pusherZ0 + sim.pusherOffset;
        pBody.setNextKinematicTranslation(_pusherT);
      }

      driveMechanisms();

      // Remember where every awake coin was, for render interpolation.
      for (const coin of sim.coins.values()) {
        if (coin.body.isSleeping()) continue;
        const t = coin.body.translation(), q = coin.body.rotation();
        coin.prev.x = t.x; coin.prev.y = t.y; coin.prev.z = t.z; coin.prev.q = q;
      }

      world.step(events);
      sim.ticks++;
      if (PN.enabled && PN.unjamAfter && sim.ticks % 30 === 0) unjamPins();

      const done = [];
      const maxS2 = PH.maxSpeed * PH.maxSpeed;
      const dv2 = PH.impactDv * PH.impactDv;
      let awake = 0;
      for (const coin of sim.coins.values()) {
        const b = coin.body;
        if (b.isSleeping()) continue;
        awake++;
        const t = b.translation();
        const v = b.linvel();
        const s2 = v.x * v.x + v.y * v.y + v.z * v.z;
        // A clink is a sudden change of velocity (what the ear hears), not a
        // contact force — every resting coin carries its own weight in force.
        const ddx = v.x - coin.pv.x, ddy = v.y - coin.pv.y, ddz = v.z - coin.pv.z;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 > dv2 && sim.onImpact && coin.spawnTick + 1 < sim.ticks) sim.onImpact(coin, Math.sqrt(d2));
        coin.pv.x = v.x; coin.pv.y = v.y; coin.pv.z = v.z;
        if (s2 > maxS2) {
          const k = PH.maxSpeed / Math.sqrt(s2);
          b.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
          sim.stats.clamped = (sim.stats.clamped || 0) + 1;
        }
        if (coin.ccd && coin.spawnTick + 20 < sim.ticks && s2 < PH.ccdSpeed * PH.ccdSpeed) {
          b.enableCcd(false); coin.ccd = false;
        }
        if (!coin.pocketed && PN.enabled && t.y < PN.pocketTop && t.y > PN.pocketBottom &&
            Math.abs(t.z - PN.z) < 1.2) {
          for (const pk of PN.pockets) {
            if (Math.abs(t.x - pk.x) < pk.w / 2) {
              coin.pocketed = true;
              if (sim.collecting && sim.onPocket) sim.onPocket(coin, pk.name);
              break;
            }
          }
        }
        const where = classify(t, coin.R);
        if (where) done.push([coin, where]);
      }
      sim.stats.awake = awake;
      if (sim.tower) towerTick();
      for (const [coin, where] of done) {
        if (coin.collected) continue;
        if (!sim.collecting) { repile(coin); continue; }
        coin.collected = true;
        sim.stats[where]++;
        if (sim.onCollect) sim.onCollect(coin, where);
        recycleCoin(coin);
      }
    }

    // Mechanisms run on their own clock, which (like the pusher's) only advances
    // while the motor runs, so a parked machine is perfectly still.
    const _q = { x: 0, y: 0, z: 0, w: 1 }, _t = { x: 0, y: 0, z: 0 };
    function driveMechanisms() {
      const moving = sim.motorOn && P.speed > 0;
      if (moving) sim.mtime += PH.dt * P.speed;
      const t = sim.mtime;
      for (const m of sim.movers) {
        if (m.name === 'turntable') {
          if (!moving) continue;
          const a = t * TT.speed;
          _q.x = 0; _q.y = Math.sin(a / 2); _q.z = 0; _q.w = Math.cos(a / 2);
          m.body.setNextKinematicRotation(_q);
        } else if (m.name === 'gate') {
          if (!moving) continue;
          // Smooth up/down: up for `upFraction` of the period, eased in and out.
          const u = (t % GT.period) / GT.period;
          const up = u < GT.upFraction ? Math.sin(Math.PI * u / GT.upFraction) : 0;
          const lo = -GT.height / 2 - 0.3, hi = GT.height / 2 - 0.35;
          _t.x = m.x; _t.y = lo + (hi - lo) * Math.min(1, up * 1.6); _t.z = m.zc;
          m.body.setNextKinematicTranslation(_t);
        }
      }
    }

    // Pin-board vibrator: every 30 ticks, over ALL coins (a wedged coin may
    // well be asleep, and the main loop skips sleepers). A coin that has sat
    // still in the pin field for `unjamAfter` s is flicked sideways and a
    // little up. Only the pin field: nothing on the beds is ever touched, so
    // what falls off the front is still decided by the pusher alone.
    const jamRnd = cpRng(97);
    function unjamPins() {
      const checks = Math.max(1, Math.round(PN.unjamAfter / PH.dt / 30));
      for (const coin of sim.coins.values()) {
        const b = coin.body, t = b.translation();
        if (Math.abs(t.z - PN.z) > 1.2 || t.y < PN.pocketTop) { coin.jam = 0; continue; }
        const v = b.linvel();
        if (v.x * v.x + v.y * v.y + v.z * v.z > 4) { coin.jam = 0; continue; }   // still moving (> 2 cm/s)
        coin.jam = (coin.jam || 0) + 1;
        if (coin.jam < checks) continue;
        coin.jam = 0;
        // A wedged coin is almost always tilted out of the board's plane, its
        // diameter spanning the 0.8 cm slot between the panes: square it back
        // into the plane (centred in the slot, 3 mm up) before the flick, or
        // it just wedges again in the same place.
        b.setTranslation({ x: t.x, y: t.y + 0.3, z: PN.z }, true);
        b.setRotation(cpQuatYXZ(0, Math.PI / 2, jamRnd() * Math.PI * 2), true);
        b.setLinvel({ x: (jamRnd() < 0.5 ? -1 : 1) * (10 + jamRnd() * 15), y: 12, z: 0 }, true);
        b.setAngvel({ x: 0, y: 0, z: (jamRnd() - 0.5) * 6 }, true);
        sim.stats.unjammed = (sim.stats.unjammed || 0) + 1;
      }
    }

    // Tower: count the coins sitting in the bucket; tip when full.
    function towerTick() {
      const T = sim.tower;
      if (T.phase === 'idle') {
        if (--T.checkIn > 0) return;
        T.checkIn = 30;
        let n = 0;
        for (const coin of sim.coins.values()) {
          const p = coin.body.translation();
          if (Math.abs(p.x) < TW.w / 2 && p.y > TW.floorY && p.y < TW.floorY + TW.h &&
              p.z > T.hingeZ - TW.d && p.z < T.hingeZ) n++;
        }
        T.count = n;
        if (n >= TW.capacity && sim.motorOn) {
          T.phase = 'tip'; T.t = 0;
          if (sim.collecting && sim.onTowerTip) sim.onTowerTip(n);
        }
        return;
      }
      T.t += PH.dt;
      if (T.phase === 'tip') {
        T.angle = TW.tipAngle * Math.min(1, T.t / TW.tipTime) ** 2;
        if (T.t >= TW.tipTime) { T.phase = 'hold'; T.t = 0; }
      } else if (T.phase === 'hold') {
        if (T.t >= TW.holdTime) { T.phase = 'back'; T.t = 0; }
      } else if (T.phase === 'back') {
        const k = Math.min(1, T.t / TW.returnTime);
        T.angle = TW.tipAngle * (1 - k * k * (3 - 2 * k));
        if (k >= 1) { T.phase = 'idle'; T.angle = 0; T.checkIn = 60; T.count = 0; }
      }
      _q.x = Math.sin(T.angle / 2); _q.y = 0; _q.z = 0; _q.w = Math.cos(T.angle / 2);
      T.body.setNextKinematicRotation(_q);
    }

    // While settling (hidden, before the machine is shown) nothing may be
    // claimed: a coin that would leave goes back onto the top of tier 1. This
    // is the only place a coin is ever moved by hand, and it never happens
    // while anyone is watching — it exists so reloading can't shake coins out.
    function repile(coin) {
      const b = coin.body;
      let x;
      do { x = (Math.random() - 0.5) * 2 * (M.halfWidth - 2); } while (Math.abs(x) < 4);
      b.setTranslation({ x, y: P.height + 4, z: P.wiperZ + 2 + Math.random() * 3 }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      sim.stats.repiled = (sim.stats.repiled || 0) + 1;
    }

    // Put the block exactly where machine time says it is, without sweeping
    // through the pile (used after restoring a saved machine time).
    function placePusher() {
      sim.pusherOffset = cpPusherOffset(P, sim.time);
      lastOffset = sim.pusherOffset;
      pBody.setTranslation({ x: 0, y: P.height / 2, z: pusherZ0 + sim.pusherOffset }, true);
    }

    // Build a starting pile: layers of randomly scattered coins (no two in a
    // layer overlap, layers are far enough apart that tilted coins can't
    // interpenetrate), every coin turned and tilted at random, on tier 1 and
    // tier 2, clear of every edge. Then the caller settles it — hidden, with
    // the pusher parked and collection off — so gravity makes the pile.
    function layoutPile(list, seed) {
      const rnd = cpRng(seed || 1);
      const minD = 2 * cfg.shapes.coin.r + 0.12;
      const layerGap = 0.82;
      const tiers = [
        { x: M.halfWidth - 1.5, z0: P.backZ + 1.6, z1: M.bedFrontZ - 3.4, y: 0.3 },           // tier 2 (bed)
        { x: M.halfWidth - 1.5, z0: P.wiperZ + 1.7, z1: P.backZ - 1.5, y: P.height + 0.3 },   // tier 1 (block top)
      ];
      const layers = [];
      for (let L = 0; L < 4; L++) {
        for (const t of tiers) {
          const pts = [];
          for (let tries = 0; tries < 900; tries++) {
            const x = (rnd() * 2 - 1) * t.x;
            const z = t.z0 + rnd() * (t.z1 - t.z0);
            let ok = !inTowerZone(x, t.y + L * layerGap, z, 1.8);
            for (const p of pts) { if (!ok) break; const dx = p.x - x, dz = p.z - z; if (dx * dx + dz * dz < minD * minD) { ok = false; break; } }
            if (ok) pts.push({ x, z, y: t.y + L * layerGap });
          }
          layers.push(pts);
        }
      }
      // Fill layer by layer, alternating tiers, so any count gives both tiers
      // a sensible share and the bottom layers fill first.
      const order = [];
      for (const pts of layers) order.push(...pts);
      for (let i = 0; i < list.length; i++) {
        const s0 = order[i % order.length];
        const extra = Math.floor(i / order.length) * layerGap * 4;
        const tilt = 0.12;
        spawnCoin({
          ...list[i],
          x: s0.x, y: s0.y + extra, z: s0.z,
          q: cpQuatYXZ(rnd() * Math.PI * 2, (rnd() - 0.5) * 2 * tilt, (rnd() - 0.5) * 2 * tilt),
        });
      }
    }

    // Settle without moving the pusher: step physics with the block parked and
    // collection off. `settleSteps` runs one chunk (so a browser can yield to
    // its loading screen between chunks) and returns how many coins still move.
    function settleSteps(n) {
      const keepTime = sim.time;
      const keepSpeed = P.speed;
      const keepCollecting = sim.collecting;
      P.speed = 0;
      sim.collecting = false;
      for (let i = 0; i < n; i++) step();
      P.speed = keepSpeed;
      sim.time = keepTime;
      sim.collecting = keepCollecting;
      return sim.restlessCount();
    }

    function settle(maxSeconds) {
      const steps = Math.round((maxSeconds || 4) / PH.dt);
      for (let done = 0; done < steps; done += 15) {
        if (settleSteps(15) === 0 && done > 30) break;
      }
    }

    function awakeCount() {
      let n = 0;
      for (const coin of sim.coins.values()) if (!coin.body.isSleeping()) n++;
      return n;
    }

    // Coins still moving. Not the same as awake: tier-1 coins touching the
    // kinematic block never sleep (Rapier keeps contacts with a kinematic
    // body active), but they can be perfectly still.
    function restlessCount(eps) {
      const e = (eps || 0.05) * (eps || 0.05);
      let n = 0;
      for (const coin of sim.coins.values()) {
        const b = coin.body;
        if (b.isSleeping()) continue;
        const v = b.linvel(), w = b.angvel();
        if (v.x * v.x + v.y * v.y + v.z * v.z > e || w.x * w.x + w.y * w.y + w.z * w.z > e * 4) n++;
      }
      return n;
    }

    // Cosmetic snapshot so the pile survives a reload. Quantised to keep it small.
    function snapshotLayout() {
      const out = [];
      const q2 = v => Math.round(v * 100) / 100;
      const q4 = v => Math.round(v * 10000) / 10000;
      for (const coin of sim.coins.values()) {
        const t = coin.body.translation(), q = coin.body.rotation();
        out.push([coin.id, q2(t.x), q2(t.y), q2(t.z), q4(q.x), q4(q.y), q4(q.z), q4(q.w)]);
      }
      return { v: 1, t: Math.round(sim.time * 1000) / 1000, coins: out };
    }

    // Rebuild from a snapshot: coins the server knows and the snapshot has go
    // back where they were; everything else is laid out fresh.
    function restore(layout, serverCoins, seed) {
      const known = new Map();
      if (layout && layout.v === 1 && Array.isArray(layout.coins)) {
        for (const row of layout.coins) if (Array.isArray(row) && row.length === 8) known.set(String(row[0]), row);
      }
      const missing = [];
      for (const c of serverCoins) {
        const row = known.get(String(c.id));
        const ok = row && row.slice(1).every(Number.isFinite) &&
          row[2] > -0.5 && row[2] < 20 && Math.abs(row[1]) < M.halfWidth;
        if (ok) {
          const q = { x: row[4], y: row[5], z: row[6], w: row[7] };
          const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
          spawnCoin({ ...c, x: row[1], y: row[2] + 0.02, z: row[3],
            q: { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n } });
        } else missing.push(c);
      }
      // Always come back PARKED (t = 0), never mid-stroke: finishing a stroke
      // on load would push the pile with nobody having paid for it.
      sim.time = 0;
      placePusher();
      if (missing.length) {
        // Missing coins are laid on top of whatever is there, higher up, so
        // they never start inside a restored coin.
        const rnd = cpRng(seed || 7);
        missing.forEach((c, i) => {
          const onTop = i % 3 === 0;
          const z = onTop ? P.wiperZ + 1.5 + rnd() * (P.backZ - P.wiperZ - 3)
                          : P.backZ + P.travel + 1.5 + rnd() * (M.bedFrontZ - P.backZ - P.travel - 5);
          let x = (rnd() - 0.5) * 2 * (M.halfWidth - 1.6);
          if (onTop && Math.abs(x) < 4) x = (x < 0 ? -1 : 1) * (4 + rnd() * 3);   // clear of the tower
          spawnCoin({ ...c,
            x,
            y: (onTop ? P.height : 0) + 3 + (i % 12) * 0.5,
            z, q: cpQuatYXZ(rnd() * Math.PI * 2, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3) });
        });
      }
      return missing.length;
    }

    // Viewers don't simulate: they pose the mechanisms from the host's
    // snapshot so the renderer can read them exactly as it does on the host.
    function poseMechanics(time, mtime, towerAngle) {
      sim.time = time; sim.mtime = mtime;
      sim.pusherOffset = cpPusherOffset(P, time);
      pBody.setTranslation({ x: 0, y: P.height / 2, z: pusherZ0 + sim.pusherOffset }, false);
      for (const m of sim.movers) {
        if (m.name === 'turntable') {
          const a = mtime * TT.speed;
          m.body.setRotation({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }, false);
        } else if (m.name === 'gate') {
          const u = (mtime % GT.period) / GT.period;
          const up = u < GT.upFraction ? Math.sin(Math.PI * u / GT.upFraction) : 0;
          const lo = -GT.height / 2 - 0.3, hi = GT.height / 2 - 0.35;
          m.body.setTranslation({ x: m.x, y: lo + (hi - lo) * Math.min(1, up * 1.6), z: m.zc }, false);
        } else if (m.name === 'tower' && sim.tower) {
          sim.tower.angle = towerAngle || 0;
          const a = sim.tower.angle;
          m.body.setRotation({ x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) }, false);
        }
      }
    }

    // A viewer taking over as host: carry on from the old host's last
    // snapshot — the block, the discs, the gates and the tower exactly where
    // the pile was last seen against them, so nothing is shoved on takeover.
    function resumeAt(time, mtime, towerAngle) {
      poseMechanics(time, mtime, towerAngle);
      placePusher();
      const T = sim.tower;
      if (T) {
        const a = Math.max(0, Math.min(TW.tipAngle, towerAngle || 0));
        if (a > 0.01) { T.phase = 'back'; T.t = (1 - a / TW.tipAngle) * TW.returnTime; T.angle = a; }
        else { T.phase = 'idle'; T.t = 0; T.angle = 0; T.checkIn = 60; }
      }
    }

    // Empty the machine (every coin back to the pool) — a client switching
    // between host and viewer keeps its world and only swaps the coins.
    function clearCoins() {
      for (const coin of [...sim.coins.values()]) recycleCoin(coin);
    }

    Object.assign(sim, {
      poseMechanics, resumeAt, clearCoins,
      spawnCoin, recycleCoin, dropCoin, step, settle, settleSteps, layoutPile, awakeCount, restlessCount,
      snapshotLayout, restore, classify, placePusher,
      dispose() { try { world.free(); } catch (_) {} try { events.free(); } catch (_) {} },
    });
    return sim;
  }

  // ── Snapshot codec (host → viewers, over Realtime) ───────────────────────
  // 19 bytes a coin: uint32 id · 3 × int16 position (1/100 cm) · 4 × int16
  // quaternion (× 32767) · uint8 look. Base64 so it rides a JSON broadcast.
  const CP_LOOKS_ORDER = ['house', 'coin5', 'coin10', 'coin25', 'coin50', 'coin100', 'gold', 'jackpot'];
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function cpB64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function cpUnB64(str) {
    const clean = str.replace(/=+$/, '');
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) |
                ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
      if (o < out.length) out[o++] = (n >> 16) & 255;
      if (o < out.length) out[o++] = (n >> 8) & 255;
      if (o < out.length) out[o++] = n & 255;
    }
    return out;
  }
  function cpSnapEncode(entries) {
    const buf = new ArrayBuffer(entries.length * 19);
    const dv = new DataView(buf);
    let o = 0;
    for (const e of entries) {
      dv.setUint32(o, Number(e.id) >>> 0); o += 4;
      for (const v of [e.x, e.y, e.z]) { dv.setInt16(o, Math.max(-32767, Math.min(32767, Math.round(v * 100)))); o += 2; }
      for (const v of [e.qx, e.qy, e.qz, e.qw]) { dv.setInt16(o, Math.round(Math.max(-1, Math.min(1, v)) * 32767)); o += 2; }
      dv.setUint8(o, Math.max(0, CP_LOOKS_ORDER.indexOf(e.look))); o += 1;
    }
    return cpB64(new Uint8Array(buf));
  }
  function cpSnapDecode(str) {
    const bytes = cpUnB64(str || '');
    const dv = new DataView(bytes.buffer);
    const out = [];
    for (let o = 0; o + 19 <= bytes.length; o += 19) {
      out.push({
        id: String(dv.getUint32(o)),
        x: dv.getInt16(o + 4) / 100, y: dv.getInt16(o + 6) / 100, z: dv.getInt16(o + 8) / 100,
        qx: dv.getInt16(o + 10) / 32767, qy: dv.getInt16(o + 12) / 32767, qz: dv.getInt16(o + 14) / 32767, qw: dv.getInt16(o + 16) / 32767,
        look: CP_LOOKS_ORDER[dv.getUint8(o + 18)] || 'coin100',
      });
    }
    return out;
  }

  root.CoinPusherCore = {
    cpSnapEncode, cpSnapDecode,
    CP_CONFIG, cpCreateSim, cpPusherOffset, cpPusherPhase, cpShapeFor, cpLookFor, cpMergeConfig, cpRng, cpQuatXZ, cpQuatYXZ,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
