// ════════════════════════════════════════════════════════════════════════════
//  „Wieżowiec G6" — stack floors, cash out before it falls (tab module, lazy)
// ════════════════════════════════════════════════════════════════════════════
//  Scope rules (see CLAUDE.md „Lazy tab modules"): this file owns its top-level
//  names — index.html must NOT also declare them — and its function
//  declarations overwrite the no-op stub index.html keeps for switchTab().
//
//  The client is a renderer. It never rolls a landing, never computes a payout
//  and never decides a win: tower-action decides the drop the moment `build`
//  is called, and the animation below only plays that result out — including
//  where the block settles (`offset`), which the server rolls too, so the tower
//  you see is the tower in the feed.
//
//  Its CSS is injected from here; index.html is up against its payload budget.
// ════════════════════════════════════════════════════════════════════════════

let towerState = null;
let towerBusy = false;
let towerBet = null;
let towerTier = 'wide';
let towerFeed = [];
let towerLeaders = [];
let towerPollTimer = null;
let towerRaf = null;
let towerCtx = null;
// Animation state: the blocks already standing, plus what is happening now.
let towerAnim = { blocks: [], falling: null, debris: [], coins: [], shake: 0, camY: 0, t0: 0, message: null };

const TOWER_W = 360;
const TOWER_H = 460;
const TOWER_GROUND = 432;
const TOWER_BLOCK_H = 24;
const TOWER_WIDTHS = { wide: 132, normal: 100, narrow: 70 };
const TOWER_LOOK = {
  wide:   { icon: '🧱', name: 'Szeroki',  color: '#60a5fa', edge: '#1d4ed8' },
  normal: { icon: '🏢', name: 'Normalny', color: '#fbbf24', edge: '#b45309' },
  narrow: { icon: '🗼', name: 'Wąski',    color: '#f472b6', edge: '#be185d' },
};
const TOWER_TIERS = ['wide', 'normal', 'narrow'];
const TOWER_DROP_MS = 420;
const TOWER_MIN_SWING_MS = 380;   // the crane always swings a moment, even on a fast network
const TOWER_POLL_MS = 20000;

(function towerInjectCss() {
  if (document.getElementById('tower-css')) return;
  const s = document.createElement('style');
  s.id = 'tower-css';
  s.textContent = `
    .tw-wrap { max-width: 980px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; align-items: start; }
    @media (max-width: 860px) { .tw-wrap { grid-template-columns: minmax(0, 1fr); } }
    .tw-hero { grid-column: 1 / -1; text-align: center; }
    .tw-title { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 0 0 4px; font-size: 24px; }
    .tw-sub { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .tw-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .tw-stage { position: relative; width: 100%; max-width: 420px; margin: 0 auto; aspect-ratio: ${TOWER_W} / ${TOWER_H};
      border-radius: 14px; overflow: hidden; border: 1px solid var(--border); background: #0b1224;
      box-shadow: 0 16px 40px rgba(2,6,23,.35); }
    .tw-stage canvas { display: block; width: 100%; height: 100%; }
    .tw-meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; max-width: 420px; margin: 0 auto; width: 100%; }
    .tw-meta > div { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 8px; text-align: center; }
    .tw-meta b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
    .tw-meta span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
    .tw-meta .tw-pot b { color: #16a34a; }
    .tw-tiers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; max-width: 420px; margin: 0 auto; width: 100%; }
    .tw-tier { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 10px 6px; border-radius: 12px;
      border: 2px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
    .tw-tier:hover:not(:disabled) { transform: translateY(-1px); }
    .tw-tier.sel { border-color: var(--tw-c); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tw-c) 25%, transparent); }
    .tw-tier:disabled { opacity: .45; cursor: not-allowed; }
    .tw-tier-ico { font-size: 22px; line-height: 1; }
    .tw-tier-name { font-weight: 800; font-size: 13px; }
    .tw-tier-odds { font-size: 12px; font-variant-numeric: tabular-nums; }
    .tw-tier-next { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .tw-actions { display: flex; gap: 8px; max-width: 420px; margin: 0 auto; width: 100%; }
    .tw-btn { flex: 1; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--border); font: inherit; font-weight: 800;
      cursor: pointer; background: var(--surface); color: var(--text); }
    .tw-btn:disabled { opacity: .5; cursor: not-allowed; }
    .tw-btn.is-primary { background: #2563eb; border-color: #1d4ed8; color: #fff; }
    .tw-btn.is-gold { background: linear-gradient(180deg, #fcd34d, #f59e0b); border-color: #d97706; color: #422006; }
    .tw-bet { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 420px; margin: 0 auto; width: 100%; }
    .tw-bet-label { font-weight: 700; font-size: 13px; }
    .tw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .tw-bet-input { width: 90px; padding: 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); font: inherit; }
    .tw-note { max-width: 420px; margin: 0 auto; font-size: 12px; color: var(--muted); text-align: center; }
    .tw-luck { max-width: 420px; margin: 0 auto; padding: 8px 12px; border-radius: 10px; background: #dcfce7; color: #14532d; font-size: 13px; text-align: center; }
    .tw-side { display: flex; flex-direction: column; gap: 14px; }
    .tw-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; }
    .tw-card-title { font-weight: 800; font-size: 14px; margin-bottom: 8px; }
    .tw-row { display: grid; grid-template-columns: 22px 1fr auto auto; gap: 8px; align-items: center; font-size: 13px; padding: 4px 0; border-top: 1px solid var(--border); }
    .tw-row:first-of-type { border-top: 0; }
    .tw-row .tw-n { color: var(--muted); font-variant-numeric: tabular-nums; }
    .tw-row b { font-variant-numeric: tabular-nums; }
    .tw-row.won b { color: #16a34a; }
    .tw-row.lost b { color: #dc2626; }
    .tw-row.me .tw-nick { font-weight: 800; }
    .tw-empty { color: var(--muted); font-size: 13px; }
    .tw-rules { max-width: 420px; margin: 0 auto; width: 100%; box-sizing: border-box; }
    .tw-rules summary { cursor: pointer; font-weight: 700; }
    .tw-rules p { font-size: 13px; line-height: 1.55; color: var(--muted); margin: 8px 0 0; }
  `;
  document.head.appendChild(s);
})();

function towerCoins(n) { return Math.round(Number(n) || 0).toLocaleString('pl-PL'); }
function towerMult(m) {
  const v = Number(m) || 0;
  return '×' + (v >= 100 ? v.toFixed(0) : v.toFixed(2)).replace('.', ',');
}
function towerPct(p) { return Math.round(Number(p) * 100) + '%'; }
function towerReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

async function invokeTower(action, body = {}) {
  const { data, error } = await sb.functions.invoke('tower-action', { body: { action, ...body } });
  if (error) {
    // A 400 carries the real message in the body; supabase-js hides it behind a
    // generic FunctionsHttpError, so dig it out (same as tabs/hilo.js).
    let msg = error.message || 'Błąd połączenia.';
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch (e) { /* keep msg */ }
    throw new Error(msg);
  }
  if (data && data.ok === false) throw new Error(data.error || 'Nie udało się.');
  return data;
}

// ── Tower geometry ──────────────────────────────────────────────────────────
// Each standing block is { tier, x (centre), w }. A landing's server-rolled
// `offset` shifts it relative to the block below: a safe landing by up to 30%
// of half the narrower of the two, a failed one past the edge of the one below.

function towerPlace(prev, tier, offset, won) {
  const w = TOWER_WIDTHS[tier] || TOWER_WIDTHS.normal;
  const baseX = prev ? prev.x : TOWER_W / 2;
  const baseW = prev ? prev.w : 180;
  if (won) return { tier, w, x: baseX + offset * 0.5 * Math.min(w, baseW) };
  const sign = offset < 0 ? -1 : 1;
  return { tier, w, x: baseX + sign * (baseW / 2 + (Math.abs(offset) - 0.5) * w) };
}

function towerRebuild(history) {
  const blocks = [];
  (history || []).forEach(h => {
    if (!h.won) return;
    blocks.push(towerPlace(blocks[blocks.length - 1], h.tier, Number(h.offset) || 0, true));
  });
  return blocks;
}

// ── Drawing ─────────────────────────────────────────────────────────────────

function towerInitCanvas() {
  const canvas = document.getElementById('tower-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round((rect.width || TOWER_W) * dpr);
  const h = Math.round((rect.height || TOWER_H) * dpr);
  if (!towerCtx || canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    towerCtx = canvas.getContext('2d');
  }
  towerCtx.setTransform(w / TOWER_W, 0, 0, h / TOWER_H, 0, 0);
}

// A deterministic skyline, so it does not flicker between frames.
const TOWER_SKYLINE = (() => {
  let s = 20260928;
  const r = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 16777216; };
  const out = [];
  for (let x = -10; x < TOWER_W + 10;) {
    const w = 26 + Math.floor(r() * 34);
    const h = 70 + Math.floor(r() * 170);
    const lit = [];
    for (let wy = 0; wy < h - 14; wy += 12) for (let wx = 5; wx < w - 6; wx += 9) if (r() < 0.32) lit.push([wx, wy]);
    out.push({ x, w, h, lit, tone: r() });
    x += w + 3;
  }
  return out;
})();

function towerDrawBlock(ctx, x, y, w, tier, rot = 0, alpha = 1) {
  const look = TOWER_LOOK[tier] || TOWER_LOOK.normal;
  const h = TOWER_BLOCK_H;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y + h / 2);
  ctx.rotate(rot);
  const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
  g.addColorStop(0, look.color);
  g.addColorStop(1, look.edge);
  ctx.fillStyle = g;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  // office windows
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  for (let wx = -w / 2 + 6; wx < w / 2 - 8; wx += 12) ctx.fillRect(wx, -h / 2 + 6, 7, 9);
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.fillRect(-w / 2, h / 2 - 3, w, 3);
  ctx.restore();
}

function towerDraw(now = performance.now()) {
  const ctx = towerCtx;
  if (!ctx) return;
  const A = towerAnim;
  const r = towerState?.round;
  const floors = A.blocks.length;

  // Camera: keep the top of the tower in the upper-middle of the frame.
  const topY = TOWER_GROUND - floors * TOWER_BLOCK_H;
  const wantCam = Math.max(0, 250 - topY);
  A.camY += (wantCam - A.camY) * 0.12;
  const shake = A.shake > now ? Math.sin(now / 18) * 3 : 0;

  // Sky + skyline (parallax: slower than the tower).
  const sky = ctx.createLinearGradient(0, 0, 0, TOWER_H);
  sky.addColorStop(0, '#0b1224');
  sky.addColorStop(1, '#1e2a4a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, TOWER_W, TOWER_H);
  ctx.save();
  ctx.translate(0, A.camY * 0.35);
  TOWER_SKYLINE.forEach(b => {
    ctx.fillStyle = b.tone > 0.5 ? '#16213d' : '#131c34';
    ctx.fillRect(b.x, TOWER_GROUND - b.h, b.w, b.h);
    ctx.fillStyle = 'rgba(253,224,71,.28)';
    b.lit.forEach(([wx, wy]) => ctx.fillRect(b.x + wx, TOWER_GROUND - b.h + 8 + wy, 4, 5));
  });
  ctx.restore();

  ctx.save();
  ctx.translate(shake, A.camY);
  // Ground: the building plot.
  ctx.fillStyle = '#334155';
  ctx.fillRect(0, TOWER_GROUND, TOWER_W, 400);
  ctx.fillStyle = '#facc15';
  for (let x = 0; x < TOWER_W; x += 24) ctx.fillRect(x, TOWER_GROUND, 12, 4);
  // Foundation slab.
  ctx.fillStyle = '#64748b';
  ctx.fillRect(TOWER_W / 2 - 95, TOWER_GROUND - 6, 190, 6);

  // Standing floors.
  A.blocks.forEach((b, i) => {
    const y = TOWER_GROUND - 6 - (i + 1) * TOWER_BLOCK_H;
    towerDrawBlock(ctx, b.x, y, b.w, b.tier);
  });

  // Height marks every 5 floors.
  ctx.fillStyle = 'rgba(226,232,240,.55)';
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  for (let f = 5; f <= floors; f += 5) {
    const y = TOWER_GROUND - 6 - f * TOWER_BLOCK_H;
    ctx.fillRect(6, y, 10, 1);
    ctx.fillText(String(f), 18, y + 4);
  }

  // The block in flight, or tipping off the edge.
  const F = A.falling;
  if (F) {
    const k = Math.min(1, (now - F.t0) / TOWER_DROP_MS);
    const landY = TOWER_GROUND - 6 - (F.index + 1) * TOWER_BLOCK_H;
    if (F.phase === 'drop') {
      const e = k * k;
      const y = F.fromY + (landY - F.fromY) * e;
      const x = F.fromX + (F.place.x - F.fromX) * e;
      towerDrawBlock(ctx, x, y, F.place.w, F.place.tier);
    } else if (F.phase === 'tip') {
      const t = (now - F.t0) / 1000;
      const dir = F.place.x > (A.blocks[A.blocks.length - 1]?.x ?? TOWER_W / 2) ? 1 : -1;
      towerDrawBlock(ctx, F.place.x + dir * t * 90, landY + t * t * 520, F.place.w, F.place.tier, dir * Math.min(2.4, t * 4.2));
    }
  }

  // Collapse debris.
  A.debris.forEach(d => {
    const t = (now - d.t0) / 1000;
    if (t < 0) { towerDrawBlock(ctx, d.x, d.y, d.w, d.tier); return; }
    towerDrawBlock(ctx, d.x + d.vx * t, d.y + d.vy * t + 480 * t * t, d.w, d.tier, d.spin * t, Math.max(0, 1 - t / 1.8));
  });
  ctx.restore();

  // Crane (screen-space, always at the top).
  const swing = Math.sin(now / (towerBusy ? 170 : 520)) * (towerBusy ? 0.42 : 0.28);
  const hookX = TOWER_W / 2 + Math.sin(swing) * 70;
  const hookY = 44 + Math.cos(swing) * 20;
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(0, 14, TOWER_W, 8);
  for (let x = 0; x < TOWER_W; x += 16) {
    ctx.fillStyle = '#b45309';
    ctx.beginPath(); ctx.moveTo(x, 22); ctx.lineTo(x + 8, 14); ctx.lineTo(x + 16, 22); ctx.fill();
  }
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(TOWER_W / 2, 22); ctx.lineTo(hookX, hookY); ctx.stroke();
  const showHanging = r && !F && !A.debris.length;
  if (showHanging) towerDrawBlock(ctx, hookX, hookY + 4, TOWER_WIDTHS[towerTier], towerTier, swing * 0.5);
  A.hook = { x: hookX, y: hookY + 4 - A.camY };

  // Coins on a cash-out.
  A.coins = A.coins.filter(c => now - c.t0 < 1600);
  A.coins.forEach(c => {
    const t = (now - c.t0) / 1000;
    ctx.globalAlpha = Math.max(0, 1 - t / 1.6);
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('🪙', c.x + c.vx * t, c.y + c.vy * t + 300 * t * t);
  });
  ctx.globalAlpha = 1;

  // Banner.
  if (A.message && now < A.message.until) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(2,6,23,.72)';
    ctx.fillRect(0, TOWER_H / 2 - 38, TOWER_W, 76);
    ctx.fillStyle = A.message.color;
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.fillText(A.message.title, TOWER_W / 2, TOWER_H / 2 - 6);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(A.message.sub, TOWER_W / 2, TOWER_H / 2 + 20);
  } else if (!r && !A.debris.length && !A.blocks.length) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillText('Plac budowy czeka', TOWER_W / 2, TOWER_H / 2 - 10);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('Wybierz stawkę i postaw pierwsze piętro.', TOWER_W / 2, TOWER_H / 2 + 14);
  }
  ctx.textAlign = 'left';
}

function towerLoop() {
  towerRaf = null;
  if (activeTab !== 'tower') return;
  towerInitCanvas();
  towerDraw();
  towerRaf = requestAnimationFrame(towerLoop);
}

function towerStartLoop() {
  if (!towerRaf) towerRaf = requestAnimationFrame(towerLoop);
}

// ── Animations driven by server results ─────────────────────────────────────

function towerWait(ms) { return new Promise(res => setTimeout(res, ms)); }

async function towerAnimateDrop(place, won) {
  const A = towerAnim;
  const index = A.blocks.length;
  const from = A.hook || { x: TOWER_W / 2, y: 48 };
  if (towerReducedMotion()) {
    if (won) A.blocks.push(place);
    return;
  }
  A.falling = { phase: 'drop', place, index, fromX: from.x, fromY: from.y, t0: performance.now() };
  await towerWait(TOWER_DROP_MS);
  if (won) {
    A.falling = null;
    A.blocks.push(place);
    A.shake = performance.now() + 120;
    return;
  }
  A.falling = { ...A.falling, phase: 'tip', t0: performance.now() };
  A.shake = performance.now() + 260;
  await towerWait(650);
  A.falling = null;
}

function towerCollapse() {
  const A = towerAnim;
  const now = performance.now();
  A.debris = A.blocks.map((b, i) => ({
    ...b,
    y: TOWER_GROUND - 6 - (i + 1) * TOWER_BLOCK_H,
    vx: (Math.random() - 0.5) * 220,
    vy: -40 - Math.random() * 80,
    spin: (Math.random() - 0.5) * 5,
    // Top floors go first, so it reads as the tower folding from where it broke.
    t0: now + (A.blocks.length - 1 - i) * 55,
  }));
  A.blocks = [];
  A.shake = now + 700;
  setTimeout(() => { towerAnim.debris = []; }, 2400 + A.debris.length * 55);
}

function towerCelebrate(payout, floors, mult) {
  const A = towerAnim;
  const now = performance.now();
  for (let i = 0; i < 26; i += 1) {
    A.coins.push({ x: TOWER_W / 2, y: 120, vx: (Math.random() - 0.5) * 320, vy: -120 - Math.random() * 180, t0: now + i * 18 });
  }
  A.message = { title: '+' + towerCoins(payout) + ' 🪙', sub: floors + ' pięter · ' + towerMult(mult), color: '#fbbf24', until: now + 2200 };
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function towerAct(fn) {
  if (towerBusy) return;
  towerBusy = true;
  renderTowerControls();
  try { await fn(); }
  catch (e) { toast(String(e?.message || e)); }
  finally { towerBusy = false; renderTowerControls(); }
}

function towerStart() {
  const bet = Math.trunc(Number(towerBet ?? towerState?.defaultBet ?? 50));
  if (!(bet >= 1)) { toast('Podaj stawkę.'); return; }
  towerAct(async () => {
    const res = await invokeTower('start', { bet });
    towerState = { ...towerState, round: res.round, coins: res.coins };
    towerAnim.blocks = [];
    towerAnim.debris = [];
    towerAnim.message = null;
    if (!res.round.options[towerTier]?.allowed) towerTier = TOWER_TIERS.find(t => res.round.options[t].allowed) || 'wide';
    refreshMeCoins();
  });
}

function towerBuild() {
  const tier = towerTier;
  towerAct(async () => {
    const started = performance.now();
    const res = await invokeTower('build', { tier });
    // Let the crane swing for a beat even if the network was instant — the
    // drop should feel like a release, not a teleport.
    const wait = TOWER_MIN_SWING_MS - (performance.now() - started);
    if (wait > 0) await towerWait(wait);
    const prev = towerAnim.blocks[towerAnim.blocks.length - 1];
    const place = towerPlace(prev, tier, Number(res.offset) || 0, res.won);
    await towerAnimateDrop(place, res.won);

    if (res.result === 'landed') {
      towerState = { ...towerState, round: res.round, coins: res.coins };
      if (!res.round.options[towerTier]?.allowed) {
        const fallback = TOWER_TIERS.find(t => res.round.options[t].allowed);
        if (fallback) towerTier = fallback;
      }
    } else if (res.result === 'collapsed') {
      towerCollapse();
      towerState = { ...towerState, round: null, coins: res.coins };
      towerAnim.message = { title: '💥 Katastrofa budowlana!', sub: 'Zawaliło się przy ' + (res.floors + 1) + '. piętrze.', color: '#f87171', until: performance.now() + 2600 };
      refreshMeCoins();
      loadTowerBoards();
    } else if (res.result === 'capped') {
      towerState = { ...towerState, round: null, coins: res.coins };
      towerCelebrate(res.payout, res.floors, res.multiplier);
      toast('🏙️ Sufit wypłaty! Wieżowiec sam się sprzedał za ' + towerCoins(res.payout) + ' 🪙.');
      refreshMeCoins();
      loadTowerBoards();
    }
  });
}

function towerCashOut() {
  towerAct(async () => {
    const res = await invokeTower('cash_out');
    towerState = { ...towerState, round: null, coins: res.coins };
    towerCelebrate(res.payout, res.floors, res.multiplier);
    refreshMeCoins();
    loadTowerBoards();
  });
}

// ── Loading & rendering ─────────────────────────────────────────────────────

async function loadTowerBoards() {
  try {
    const [feed, week] = await Promise.all([
      sb.from('tower_recent').select('*').limit(12),
      sb.from('tower_week_heights').select('*').order('floors', { ascending: false }).order('multiplier', { ascending: false }).limit(8),
    ]);
    towerFeed = feed.data || [];
    towerLeaders = week.data || [];
  } catch (e) { /* keep what we had */ }
  renderTowerSide();
}

async function loadTower() {
  try {
    towerState = await invokeTower('state');
    if (towerBet == null) towerBet = towerState.defaultBet;
  } catch (e) {
    towerState = null;
    const host = document.getElementById('tower-controls');
    if (host) host.replaceChildren(el('div', { className: 'tw-empty' },
      'Nie udało się wczytać gry: ' + String(e?.message || e)));
    return;
  }
  // Rebuild a tower that was left standing (a reload mid-build).
  towerAnim.blocks = towerRebuild(towerState.round?.history);
  towerAnim.falling = null;
  towerAnim.debris = [];
  towerAnim.coins = [];
  towerAnim.message = null;
  renderTowerControls();
  towerInitCanvas();
  towerStartLoop();
  loadTowerBoards();
  if (towerPollTimer) clearInterval(towerPollTimer);
  towerPollTimer = setInterval(() => {
    if (activeTab === 'tower' && !document.hidden) loadTowerBoards();
  }, TOWER_POLL_MS);
}

function towerTierBtn(tier, opt) {
  const look = TOWER_LOOK[tier];
  const b = el('button', {
    className: 'tw-tier' + (towerTier === tier ? ' sel' : ''),
    onclick: () => { towerTier = tier; renderTowerControls(); },
  },
    el('span', { className: 'tw-tier-ico' }, look.icon),
    el('span', { className: 'tw-tier-name' }, look.name),
    el('span', { className: 'tw-tier-odds' }, towerPct(opt.p) + ' · ' + towerMult(opt.step)),
    el('span', { className: 'tw-tier-next' }, opt.allowed ? 'pula → ' + towerCoins(opt.nextPayout) + ' 🪙' : 'ponad sufit'));
  b.style.setProperty('--tw-c', look.color);
  b.disabled = towerBusy || !opt.allowed;
  if (!opt.allowed) b.title = 'Ten blok przebiłby sufit wypłaty przy tej stawce.';
  return b;
}

function renderTowerControls() {
  const host = document.getElementById('tower-controls');
  if (!host || !towerState) return;
  const r = towerState.round;
  host.replaceChildren();

  if (towerState.casinoLuck) {
    host.append(el('div', { className: 'tw-luck' }, '🍀 Amulet Bezwstydnego Fartu jest aktywny — kasyno oddaje 98% zamiast 95%.'));
  }

  host.append(el('div', { className: 'tw-meta' },
    el('div', {}, el('b', {}, String(r ? r.floors : 0)), el('span', {}, 'pięter')),
    el('div', {}, el('b', {}, towerMult(r ? r.multiplier : 1)), el('span', {}, 'mnożnik')),
    el('div', { className: 'tw-pot' }, el('b', {}, (r ? towerCoins(r.cashOut) : '—') + ' 🪙'), el('span', {}, 'do wypłaty'))));

  if (!r) {
    const row = el('div', { className: 'tw-bet' });
    row.append(el('span', { className: 'tw-bet-label' }, 'Stawka'));
    const chips = el('div', { className: 'tw-chips' });
    (towerState.stakes || []).forEach(v => chips.append(el('button', {
      className: 'casino-chip' + (Number(towerBet) === v ? ' active' : ''),
      onclick: () => { towerBet = v; renderTowerControls(); },
    }, towerCoins(v))));
    row.append(chips);
    row.append(el('input', {
      className: 'tw-bet-input', type: 'number', min: '1', value: String(towerBet ?? ''),
      oninput: e => { towerBet = Math.trunc(Number(e.target.value) || 0); },
    }));
    host.append(row);
    const start = el('button', { className: 'tw-btn is-primary', onclick: towerStart }, '🏗️ Zacznij budowę');
    start.disabled = towerBusy;
    host.append(el('div', { className: 'tw-actions' }, start));
  } else {
    host.append(el('div', { className: 'tw-tiers' }, ...TOWER_TIERS.map(t => towerTierBtn(t, r.options[t]))));
    const build = el('button', { className: 'tw-btn is-primary', onclick: towerBuild },
      towerBusy ? 'Dźwig pracuje…' : TOWER_LOOK[towerTier].icon + ' Postaw piętro');
    build.disabled = towerBusy || !r.options[towerTier]?.allowed;
    const cash = el('button', { className: 'tw-btn is-gold', onclick: towerCashOut },
      'Sprzedaj za ' + towerCoins(r.cashOut) + ' 🪙');
    cash.disabled = towerBusy || r.floors < 1;
    if (r.floors < 1) cash.title = 'Postaw przynajmniej jedno piętro.';
    host.append(el('div', { className: 'tw-actions' }, build, cash));
    host.append(el('div', { className: 'tw-note' },
      'Stawka ' + towerCoins(r.bet) + ' 🪙 · sufit przy tej stawce ' + towerMult(r.maxMultiplier)
      + ' (maks. wypłata ' + towerCoins(r.maxPayout) + ' 🪙). Blok, który przebiłby sufit, nie jest oferowany.'));
  }

  host.append(el('details', { className: 'tw-card tw-rules' },
    el('summary', {}, 'Zasady i szanse'),
    el('p', {}, 'Przed każdym piętrem wybierasz blok. Procent na przycisku to prawdziwa szansa, że blok się utrzyma, a mnożnik to dokładnie jej odwrotność: 🧱 90% · ×1,11, 🏢 70% · ×1,43, 🗼 45% · ×2,22.'),
    el('p', {}, el('b', {}, 'Marża kasyna schodzi raz, przy sprzedaży — nie co piętro.'), ' Dlatego zwrot to równe 95% przy każdej wysokości i każdej mieszance bloków: żadna strategia nie jest lepsza od innej, zmienia się tylko ryzyko.'),
    el('p', {}, 'Wypłata nigdy nie jest mniejsza niż kwota na przycisku — czasem jest o 1 🪙 większa, bo ułamek monety rozliczamy losowo, żeby przy małych stawkach nie ginął na zaokrągleniu.')));
}

function renderTowerSide() {
  const lb = document.getElementById('tower-leaders');
  if (lb) {
    lb.replaceChildren(el('div', { className: 'tw-card-title' }, '🏙️ Najwyższe w tym tygodniu'));
    if (!towerLeaders.length) lb.append(el('div', { className: 'tw-empty' }, 'Nikt jeszcze nie sprzedał wieżowca w tym tygodniu.'));
    towerLeaders.forEach((row, i) => lb.append(el('div', { className: 'tw-row' + (row.user_id === me?.id ? ' me' : '') },
      el('span', { className: 'tw-n' }, String(i + 1)),
      el('span', { className: 'tw-nick' }, row.nick),
      el('span', { className: 'tw-n' }, towerMult(row.multiplier)),
      el('b', {}, row.floors + ' p.'))));
  }
  const fd = document.getElementById('tower-feed');
  if (fd) {
    fd.replaceChildren(el('div', { className: 'tw-card-title' }, '🔥 Ostatnie budowy'));
    if (!towerFeed.length) fd.append(el('div', { className: 'tw-empty' }, 'Jeszcze nikt nie budował.'));
    towerFeed.forEach(f => {
      const won = f.result === 'cashed';
      fd.append(el('div', { className: 'tw-row ' + (won ? 'won' : 'lost') },
        el('span', {}, won ? '🏙️' : '💥'),
        el('span', { className: 'tw-nick' }, f.nick),
        el('span', { className: 'tw-n' }, f.floors + ' p.'),
        el('b', {}, won ? '+' + towerCoins(f.total_won) : '−' + towerCoins(f.bet))));
    });
  }
}

// Overwrites the teardown stub in index.html (switchTab calls it on leaving).
function stopTowerTimer() {
  if (towerRaf) cancelAnimationFrame(towerRaf);
  towerRaf = null;
  if (towerPollTimer) clearInterval(towerPollTimer);
  towerPollTimer = null;
}

window.addEventListener('resize', () => { if (activeTab === 'tower') towerInitCanvas(); });
