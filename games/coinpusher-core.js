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
      halfWidth: 15,          // playfield is 30 cm wide (≈11 coins across)
      bedBackZ: -26,          // lower bed runs under the pusher to here
      bedFrontZ: 12,          // the prize edge
      bedThickness: 1.5,
      wallHeight: 32,
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
      y: 17,
      z: -11,
      minX: -13.2,
      maxX: 13.2,
      tiltJitter: 0.14,       // rad of random tilt on release
      spinJitter: 3,          // rad/s
      downSpeed: 25,          // cm/s the coin leaves the slot with
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
      coin:    { r: 1.3, h: 0.3, border: 0.05 },
      jackpot: { r: 1.9, h: 0.5, border: 0.08 },
    },
  };

  // How a server coin row is simulated (shape) and drawn (look).
  function cpShapeFor(kind) { return kind === 'jackpot' ? 'jackpot' : 'coin'; }
  function cpLookFor(kind, value) {
    if (kind === 'gold' || kind === 'jackpot' || kind === 'house') return kind;
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
      coin.spawnTick = sim.ticks;
      coin.ccd = false;
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
      const q = cpQuatYXZ((r() - 0.5) * 2 * D.tiltJitter, Math.PI / 2 + tilt, (r() - 0.5) * 2 * D.tiltJitter);
      return spawnCoin({
        ...c,
        x: cx + (r() - 0.5) * 0.3, y: D.y, z: D.z + (r() - 0.5) * 0.6, q,
        v: { x: (r() - 0.5) * 4, y: -D.downSpeed, z: (r() - 0.5) * 6 },
        w: { x: (r() - 0.5) * D.spinJitter, y: (r() - 0.5) * D.spinJitter, z: (r() - 0.5) * D.spinJitter },
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

      // Remember where every awake coin was, for render interpolation.
      for (const coin of sim.coins.values()) {
        if (coin.body.isSleeping()) continue;
        const t = coin.body.translation(), q = coin.body.rotation();
        coin.prev.x = t.x; coin.prev.y = t.y; coin.prev.z = t.z; coin.prev.q = q;
      }

      world.step(events);
      sim.ticks++;

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
        const where = classify(t, coin.R);
        if (where) done.push([coin, where]);
      }
      sim.stats.awake = awake;
      for (const [coin, where] of done) {
        if (coin.collected) continue;
        if (!sim.collecting) { repile(coin); continue; }
        coin.collected = true;
        sim.stats[where]++;
        if (sim.onCollect) sim.onCollect(coin, where);
        recycleCoin(coin);
      }
    }

    // While settling (hidden, before the machine is shown) nothing may be
    // claimed: a coin that would leave goes back onto the top of tier 1. This
    // is the only place a coin is ever moved by hand, and it never happens
    // while anyone is watching — it exists so reloading can't shake coins out.
    function repile(coin) {
      const b = coin.body;
      b.setTranslation({ x: (Math.random() - 0.5) * 2 * (M.halfWidth - 2), y: P.height + 4,
        z: P.wiperZ + 2 + Math.random() * 3 }, true);
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
            let ok = true;
            for (const p of pts) { const dx = p.x - x, dz = p.z - z; if (dx * dx + dz * dz < minD * minD) { ok = false; break; } }
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
          spawnCoin({ ...c,
            x: (rnd() - 0.5) * 2 * (M.halfWidth - 1.6),
            y: (onTop ? P.height : 0) + 3 + (i % 12) * 0.5,
            z, q: cpQuatYXZ(rnd() * Math.PI * 2, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3) });
        });
      }
      return missing.length;
    }

    Object.assign(sim, {
      spawnCoin, recycleCoin, dropCoin, step, settle, settleSteps, layoutPile, awakeCount, restlessCount,
      snapshotLayout, restore, classify, placePusher,
      dispose() { try { world.free(); } catch (_) {} try { events.free(); } catch (_) {} },
    });
    return sim;
  }

  root.CoinPusherCore = {
    CP_CONFIG, cpCreateSim, cpPusherOffset, cpPusherPhase, cpShapeFor, cpLookFor, cpMergeConfig, cpRng, cpQuatXZ, cpQuatYXZ,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
