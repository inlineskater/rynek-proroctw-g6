// ════════════════════════════════════════════════════════════════════════════
//  🌪️ Random farm events — lazy module (TAB_MODULES.farmevents)
// ════════════════════════════════════════════════════════════════════════════
//  Backend: supabase/farm-world-events.sql. The server decides everything (when,
//  what, which plots, how many hours) and writes one farm_world_events row; this
//  file only PLAYS it: a full-screen canvas animation over the board for anyone
//  on the Ogródek when it fires (realtime INSERT), the same animation once more
//  for anyone who opens the farm within FEV_FRESH_MS and has not seen it on this
//  device, and a banner with a replay button in the sky band.
//
//  Not a tab: loadFarm() calls withTabModule('farmevents', () => fevRefresh()).

const FEV_FRESH_MS = 3 * 3600000;     // banner + auto-play window after an event
const FEV_DURATION = 7.0;             // seconds of animation
let fevLast = null;                   // latest farm_world_events row (≤ FEV_FRESH_MS old)
let fevChannel = null;
let fevPlaying = null;                // { stop() } while an animation runs

(function farmEventsInjectCss() {
  if (document.getElementById('farm-events-css')) return;
  const s = document.createElement('style');
  s.id = 'farm-events-css';
  s.textContent = `
    .fev-layer { position: fixed; inset: 0; z-index: 90; pointer-events: auto; cursor: pointer; }
    .fev-layer canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .fev-card { position: absolute; left: 50%; top: 14%; transform: translate(-50%, 0) scale(.6); opacity: 0;
      max-width: min(560px, calc(100vw - 32px)); box-sizing: border-box; padding: 18px 22px; border-radius: 18px;
      text-align: center; color: #fff; background: rgba(20, 16, 12, .72); backdrop-filter: blur(6px);
      border: 2px solid var(--fev-c, #f97316); box-shadow: 0 0 40px var(--fev-c, #f97316), inset 0 0 24px rgba(255,255,255,.08);
      animation: fevCardIn .55s cubic-bezier(.2, 1.4, .4, 1) .35s forwards, fevCardOut .5s ease-in forwards;
      animation-delay: .35s, ${FEV_DURATION - 0.6}s; }
    .fev-card .fev-ic { font-size: 56px; line-height: 1; filter: drop-shadow(0 0 14px var(--fev-c, #f97316));
      animation: fevPulse 1.1s ease-in-out infinite; }
    .fev-card .fev-title { margin-top: 6px; font-size: clamp(22px, 4.4vw, 34px); font-weight: 900; letter-spacing: .02em;
      text-transform: uppercase; text-shadow: 0 0 18px var(--fev-c, #f97316), 0 2px 0 rgba(0,0,0,.4); }
    .fev-card .fev-msg { margin-top: 8px; font-size: 13.5px; line-height: 1.5; color: rgba(255,255,255,.9); }
    .fev-card .fev-skip { margin-top: 10px; font-size: 11px; color: rgba(255,255,255,.55); }
    @keyframes fevCardIn { to { transform: translate(-50%, 0) scale(1); opacity: 1; } }
    @keyframes fevCardOut { to { transform: translate(-50%, -20px) scale(.92); opacity: 0; } }
    @keyframes fevPulse { 50% { transform: scale(1.14); } }
    .fev-shake { animation: fevShake .09s linear infinite; }
    @keyframes fevShake { 0% { transform: translate(0,0); } 25% { transform: translate(-3px, 2px); }
      50% { transform: translate(3px, -2px); } 75% { transform: translate(-2px, -3px); } 100% { transform: translate(2px, 3px); } }
    #fev-banner { display: flex; align-items: center; gap: 10px; margin: 0; padding: 7px 12px; border-radius: 12px;
      border: 1px solid var(--fev-c, #f97316); background: rgba(255,255,255,.9); box-shadow: 0 2px 10px rgba(15,23,42,.08);
      color: #1f2937; font-size: 12.5px; line-height: 1.4; min-width: 0; }
    #fev-banner .fev-b-ic { font-size: 22px; flex: 0 0 auto; }
    #fev-banner .fev-b-txt { flex: 1 1 auto; min-width: 0; }
    #fev-banner .fev-b-txt b { display: block; font-size: 13px; }
    #fev-banner .fev-b-txt span { color: #4b5563; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    #fev-banner button { flex: 0 0 auto; border: 1px solid #d1d5db; background: #fff; border-radius: 8px; padding: 4px 9px;
      font: inherit; font-size: 12px; cursor: pointer; }
    #fev-banner .fev-b-x { border: 0; background: none; color: #6b7280; font-size: 15px; padding: 2px 4px; }
  `;
  document.head.appendChild(s);
})();

const FEV_STYLE = {
  pozar:        { c: '#f97316', tint: [70, 18, 0],    tintA: .45 },
  tornado:      { c: '#94a3b8', tint: [24, 26, 32],   tintA: .66 },
  szarancza:    { c: '#84cc16', tint: [34, 30, 6],    tintA: .55 },
  burza:        { c: '#a5b4fc', tint: [6, 8, 30],     tintA: .74 },
  zloty_deszcz: { c: '#facc15', tint: [70, 50, 0],    tintA: .28 },
  roj:          { c: '#fbbf24', tint: [50, 36, 0],    tintA: .22 },
};
const FEV_EMOJI = { pozar: '🔥', tornado: '🌪️', szarancza: '🦗', burza: '⚡', zloty_deszcz: '🌧️', roj: '🐝' };

function fevSeenKey(id) { return 'fev_seen_' + id; }
function fevSeen(id) { try { return localStorage.getItem(fevSeenKey(id)) === '1'; } catch (e) { return true; } }
function fevMarkSeen(id) { try { localStorage.setItem(fevSeenKey(id), '1'); } catch (e) {} }
function fevDismissed(id) { try { return localStorage.getItem('fev_x_' + id) === '1'; } catch (e) { return false; } }

async function fevRefresh() {
  fevEnsureRealtime();
  try {
    const since = new Date(Date.now() - FEV_FRESH_MS).toISOString();
    const { data, error } = await sb.from('farm_world_events')
      .select('id,kind,good,title,fired_at,plots,players,origin,message')
      .gte('fired_at', since).order('fired_at', { ascending: false }).limit(1);
    if (error) throw error;
    fevLast = (data && data[0]) || null;
  } catch (e) { fevLast = null; }   // not installed yet: nothing to show
  fevRenderBanner();
  if (fevLast && !fevSeen(fevLast.id) && activeTab === 'farm') setTimeout(() => fevPlay(fevLast), 600);
}

function fevEnsureRealtime() {
  if (fevChannel || !sb) return;
  fevChannel = sb.channel('farm-world-events')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'farm_world_events' }, payload => {
      fevLast = payload.new;
      fevRenderBanner();
      // Only animate for someone looking at the board; everyone else gets it
      // from the chat and sees it the next time they open the farm.
      if (activeTab === 'farm' && document.visibilityState === 'visible') setTimeout(() => fevPlay(fevLast), 900);
    })
    .subscribe();
}

function fevRenderBanner() {
  const host = document.getElementById('fw-banner')?.parentElement;
  if (!host) return;
  let b = document.getElementById('fev-banner');
  const ev = fevLast;
  if (!ev || Date.now() - new Date(ev.fired_at).getTime() > FEV_FRESH_MS || fevDismissed(ev.id)) {
    if (b) b.remove();
    return;
  }
  if (!b) { b = el('div', { id: 'fev-banner' }); host.prepend(b); }
  b.style.setProperty('--fev-c', (FEV_STYLE[ev.kind] || {}).c || '#f97316');
  const mins = Math.max(1, Math.round((Date.now() - new Date(ev.fired_at).getTime()) / 60000));
  const replay = el('button', { type: 'button' }, '▶ Zobacz');
  replay.addEventListener('click', () => fevPlay(ev));
  const x = el('button', { type: 'button', className: 'fev-b-x', title: 'Ukryj' }, '✕');
  x.addEventListener('click', () => { try { localStorage.setItem('fev_x_' + ev.id, '1'); } catch (e) {} b.remove(); });
  b.replaceChildren(
    el('span', { className: 'fev-b-ic' }, FEV_EMOJI[ev.kind] || '🌪️'),
    el('div', { className: 'fev-b-txt' },
      el('b', {}, ev.title + ' · ' + (mins < 60 ? mins + ' min temu' : Math.round(mins / 60) + ' h temu')),
      el('span', {}, String(ev.message || '').replace(/^\S+\s+[^!]*!\s*/, ''))),
    replay, x);
}

// ── The show ────────────────────────────────────────────────────────────────
function fevCellCenters(ev) {
  const out = [];
  (ev.plots || []).forEach(p => {
    const cell = document.querySelector('#farm-board .farm-cell[data-xy="' + p.x + ',' + p.y + '"]');
    if (!cell) return;
    const r = cell.getBoundingClientRect();
    if (r.width < 2) return;
    out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, p });
  });
  return out;
}

function fevPlay(ev) {
  if (!ev) return;
  fevMarkSeen(ev.id);
  if (fevPlaying) fevPlaying.stop();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    toast((FEV_EMOJI[ev.kind] || '') + ' ' + ev.message);
    return;
  }
  const style = FEV_STYLE[ev.kind] || FEV_STYLE.pozar;
  const layer = el('div', { className: 'fev-layer', title: 'Kliknij, aby pominąć' });
  const cv = el('canvas', {});
  const card = el('div', { className: 'fev-card' },
    el('div', { className: 'fev-ic' }, FEV_EMOJI[ev.kind] || '🌪️'),
    el('div', { className: 'fev-title' }, ev.title),
    el('div', { className: 'fev-msg' }, String(ev.message || '').replace(/^\S+\s+[^!]*!\s*/, '')),
    el('div', { className: 'fev-skip' }, 'kliknij, aby pominąć'));
  card.style.setProperty('--fev-c', style.c);
  layer.append(cv, card);
  document.body.append(layer);

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const ctx = cv.getContext('2d');
  let W = 0, H = 0;
  const resize = () => {
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  const board = document.getElementById('farm-board');
  const shake = !ev.good && board;
  if (shake) board.classList.add('fev-shake');

  let cells = fevCellCenters(ev);
  let cellsAt = 0;
  const scene = (FEV_SCENES[ev.kind] || FEV_SCENES.pozar)();
  const t0 = performance.now();
  let last = t0, raf = 0, done = false;

  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    if (board) board.classList.remove('fev-shake');
    layer.remove();
    fevPlaying = null;
  };
  layer.addEventListener('click', stop);

  const frame = now => {
    const t = (now - t0) / 1000;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (now - cellsAt > 500) { cells = fevCellCenters(ev); cellsAt = now; }   // board may re-render under us
    if (shake && t > 2.6) board.classList.remove('fev-shake');
    // Envelope: fade in 0.6 s, hold, fade out the last 0.9 s.
    const env = Math.min(1, t / 0.6) * Math.min(1, Math.max(0, (FEV_DURATION - t) / 0.9));
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(' + style.tint.join(',') + ',' + (style.tintA * env) + ')';
    ctx.fillRect(0, 0, W, H);
    scene.step(ctx, { t, dt, W, H, cells, env, ev });
    // Mark the plots that were hit, so it is clear WHOSE crops it was.
    if (t > 1.2) fevDrawRings(ctx, cells, t, env, style.c, ev.good);
    if (t >= FEV_DURATION) { stop(); return; }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  fevPlaying = { stop };
}

function fevDrawRings(ctx, cells, t, env, color, good) {
  ctx.save();
  ctx.globalAlpha = 0.85 * env;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  cells.forEach((c, i) => {
    const pulse = 1 + 0.08 * Math.sin(t * 6 + i);
    const r = Math.max(c.w, c.h) * 0.62 * pulse;
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = good ? '#fef9c3' : '#fee2e2';
    ctx.textAlign = 'center';
    const d = c.p.delta_min;
    const label = d < 0 ? '−' + fevHrs(-d) : '+' + fevHrs(d);
    ctx.fillText(label, c.x, c.y - r - 4);
  });
  ctx.restore();
}

function fevHrs(min) { return min >= 60 ? (Math.round(min / 6) / 10).toString().replace('.', ',') + ' h' : min + ' min'; }

function fevRand(a, b) { return a + Math.random() * (b - a); }
function fevPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Each scene is a factory returning { step(ctx, s) }; s = { t, dt, W, H, cells, env, ev }.
const FEV_SCENES = {
  // 🔥 Flames rise from every burned plot and from the bottom of the screen,
  // embers spiral up, smoke rolls in behind.
  pozar() {
    const P = [];
    const spawn = (x, y, big) => P.push({ x: x + fevRand(-14, 14), y, vx: fevRand(-18, 18), vy: fevRand(-170, -70) * (big ? 1.3 : 1),
      r: fevRand(10, big ? 34 : 22), life: 0, max: fevRand(0.6, 1.3), kind: 'f' });
    return { step(ctx, s) {
      const rate = s.t < FEV_DURATION - 1.2 ? 1 : 0;
      for (let i = 0; i < 14 * rate; i++) spawn(fevRand(0, s.W), s.H + 10, true);
      s.cells.forEach(c => { for (let i = 0; i < 3 * rate; i++) spawn(c.x, c.y + c.h * 0.3, false); });
      if (Math.random() < 0.9 * rate) P.push({ x: fevRand(0, s.W), y: s.H, vx: fevRand(-40, 40), vy: fevRand(-320, -180), r: fevRand(1.5, 3), life: 0, max: fevRand(1, 2.2), kind: 'e' });
      if (Math.random() < 0.5 * rate) P.push({ x: fevRand(0, s.W), y: s.H * fevRand(0.55, 1), vx: fevRand(-20, 20), vy: fevRand(-50, -25), r: fevRand(40, 90), life: 0, max: fevRand(2.5, 4), kind: 's' });
      ctx.save();
      // smoke first (behind)
      P.forEach(p => { if (p.kind !== 's') return;
        const a = Math.sin(Math.PI * p.life / p.max) * 0.25 * s.env;
        ctx.fillStyle = 'rgba(40,36,34,' + a + ')'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + p.life * 0.4), 0, 7); ctx.fill(); });
      ctx.globalCompositeOperation = 'lighter';
      P.forEach(p => {
        if (p.kind === 's') return;
        const k = p.life / p.max;
        if (p.kind === 'e') {
          ctx.fillStyle = 'rgba(255,' + Math.round(200 - 120 * k) + ',60,' + (1 - k) * s.env + ')';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); return;
        }
        const r = p.r * (1 - k * 0.7);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, 'rgba(255,240,170,' + 0.9 * (1 - k) * s.env + ')');
        g.addColorStop(0.35, 'rgba(255,140,20,' + 0.7 * (1 - k) * s.env + ')');
        g.addColorStop(1, 'rgba(200,30,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
      });
      ctx.restore();
      for (let i = P.length - 1; i >= 0; i--) {
        const p = P[i]; p.life += s.dt;
        p.x += (p.vx + Math.sin(p.life * 9 + i) * 22) * s.dt; p.y += p.vy * s.dt;
        if (p.life >= p.max) P.splice(i, 1);
      }
      // heat flicker
      ctx.fillStyle = 'rgba(255,90,0,' + (0.06 + 0.05 * Math.sin(s.t * 23)) * s.env + ')';
      ctx.fillRect(0, 0, s.W, s.H);
    } };
  },

  // 🌪️ A twister crosses the screen through the hit plots, sucking crops up
  // into its spiral and flinging them out.
  tornado() {
    const crops = ['🌽', '🥕', '🍅', '🥔', '🌶️', '🍓', '🎃', '🍇', '🍍', '🍂', '🌾', '🪵'];
    const D = [], dust = [];
    let hitDone = new Set();
    return { step(ctx, s) {
      const ys = s.cells.length ? s.cells.reduce((a, c) => a + c.y, 0) / s.cells.length : s.H * 0.6;
      const baseY = Math.min(s.H - 40, ys + 60);
      const xs = s.cells.map(c => c.x);
      const x0 = -260, x1 = s.W + 260;
      const k = Math.min(1, Math.max(0, (s.t - 0.4) / (FEV_DURATION - 1.4)));
      const cx = x0 + (x1 - x0) * (k * k * (3 - 2 * k)) + Math.sin(s.t * 2.3) * 30;
      const height = Math.min(s.H * 0.85, 560);
      // debris from plots as the funnel passes them
      s.cells.forEach((c, i) => {
        if (!hitDone.has(i) && Math.abs(c.x - cx) < 90) {
          hitDone.add(i);
          for (let j = 0; j < 5; j++) D.push({ a: fevRand(0, 6.28), h: fevRand(0, 30), r: fevRand(30, 70), e: fevPick(crops), life: 0, max: fevRand(1.6, 2.6), sz: fevRand(18, 30) });
        }
      });
      if (Math.random() < 0.6) D.push({ a: fevRand(0, 6.28), h: 0, r: fevRand(40, 90), e: fevPick(crops), life: 0, max: fevRand(1.4, 2.4), sz: fevRand(14, 24) });
      for (let i = 0; i < 6; i++) dust.push({ x: cx + fevRand(-80, 80), y: baseY + fevRand(-10, 10), vx: fevRand(-120, 120), vy: fevRand(-60, -10), r: fevRand(8, 26), life: 0, max: fevRand(0.6, 1.4) });
      ctx.save();
      // dust
      dust.forEach(p => { const a = (1 - p.life / p.max) * 0.35 * s.env;
        ctx.fillStyle = 'rgba(140,120,100,' + a + ')'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); });
      // funnel body: a filled, swaying cone so it reads at a glance
      const body = new Path2D();
      const SEG = 24;
      for (let i = 0; i <= SEG; i++) { const f = i / SEG, y = baseY - f * height;
        const x = cx + Math.sin(s.t * 3 + f * 5) * 40 * f - (18 + Math.pow(f, 1.6) * 190); i ? body.lineTo(x, y) : body.moveTo(x, y); }
      for (let i = SEG; i >= 0; i--) { const f = i / SEG, y = baseY - f * height;
        body.lineTo(cx + Math.sin(s.t * 3 + f * 5) * 40 * f + (18 + Math.pow(f, 1.6) * 190), y); }
      body.closePath();
      const bg = ctx.createLinearGradient(cx - 200, 0, cx + 200, 0);
      bg.addColorStop(0, 'rgba(70,72,80,' + 0.15 * s.env + ')');
      bg.addColorStop(0.5, 'rgba(120,120,128,' + 0.7 * s.env + ')');
      bg.addColorStop(1, 'rgba(70,72,80,' + 0.15 * s.env + ')');
      ctx.fillStyle = bg; ctx.fill(body);
      // rings: stacked rotating ellipses widening upwards
      const layers = 46;
      for (let i = 0; i < layers; i++) {
        const f = i / layers;
        const y = baseY - f * height;
        const rx = 18 + Math.pow(f, 1.6) * 190;
        const sway = Math.sin(s.t * 3 + f * 5) * 40 * f;
        const rot = s.t * 9 + f * 14;
        ctx.strokeStyle = 'rgba(' + (210 - f * 70) + ',' + (212 - f * 70) + ',' + (220 - f * 60) + ',' + (0.9 - f * 0.35) * s.env + ')';
        ctx.lineWidth = 4 + f * 7;
        ctx.beginPath();
        ctx.ellipse(cx + sway, y, rx, rx * 0.22, 0, rot % 6.28, rot % 6.28 + 4.4);
        ctx.stroke();
      }
      // debris orbiting the axis
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      D.forEach(d => {
        const k2 = d.life / d.max;
        const h = Math.min(height * 0.9, d.h + k2 * height * 0.9);
        const r = d.r + h * 0.35 + (k2 > 0.8 ? (k2 - 0.8) * 1600 : 0);
        const x = cx + Math.sin(s.t * 3 + h / height * 5) * 40 * (h / height) + Math.cos(d.a + s.t * 7) * r;
        const y = baseY - h + Math.sin(d.a + s.t * 7) * r * 0.22;
        ctx.globalAlpha = s.env * (1 - Math.max(0, k2 - 0.85) / 0.15);
        ctx.font = d.sz + 'px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
        ctx.fillText(d.e, x, y);
      });
      ctx.restore();
      [D, dust].forEach(arr => { for (let i = arr.length - 1; i >= 0; i--) { const p = arr[i]; p.life += s.dt;
        if (p.x !== undefined) { p.x += p.vx * s.dt; p.y += p.vy * s.dt; }
        if (p.life >= p.max) arr.splice(i, 1); } });
      // wind streaks
      ctx.strokeStyle = 'rgba(220,225,235,' + 0.18 * s.env + ')'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 18; i++) { const y = (i * 97 + s.t * 300) % s.H, x = ((i * 211 + s.t * 900) % (s.W + 300)) - 150;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 120, y - 10); ctx.stroke(); }
      void xs;
    } };
  },

  // 🦗 A swarm pours in from the left, boils over the unprotected plots and
  // leaves to the right.
  szarancza() {
    const N = 560;
    const B = Array.from({ length: N }, (_, i) => ({ x: fevRand(-700, -20), y: fevRand(0, window.innerHeight),
      vx: fevRand(220, 340), vy: 0, big: i % 7 === 0, ph: fevRand(0, 6.28), tgt: null }));
    return { step(ctx, s) {
      const leave = s.t > FEV_DURATION - 2.2;
      B.forEach((b, i) => {
        if (!b.tgt && s.cells.length) b.tgt = s.cells[i % s.cells.length];
        let ax = 0, ay = 0;
        if (b.tgt && !leave) { ax = (b.tgt.x + Math.sin(s.t * 5 + b.ph) * 60 - b.x) * 3.2; ay = (b.tgt.y + Math.cos(s.t * 4 + b.ph) * 45 - b.y) * 3.2; }
        else { ax = 420; ay = Math.sin(s.t * 3 + b.ph) * 120; }
        b.vx += (ax - b.vx * 1.4) * s.dt; b.vy += (ay - b.vy * 1.4) * s.dt;
        b.vx += Math.sin(s.t * 13 + b.ph) * 60 * s.dt; b.vy += Math.cos(s.t * 11 + b.ph) * 60 * s.dt;
        b.x += b.vx * s.dt; b.y += b.vy * s.dt;
      });
      ctx.save();
      ctx.globalAlpha = s.env;
      B.forEach(b => {
        if (b.big) {
          ctx.font = '26px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('🦗', b.x, b.y);
        } else {
          const a = Math.atan2(b.vy, b.vx);
          ctx.fillStyle = 'rgba(52,44,14,.9)';
          ctx.beginPath(); ctx.ellipse(b.x, b.y, 7, 2.8, a, 0, 7); ctx.fill();
          ctx.strokeStyle = 'rgba(160,150,90,.55)'; ctx.lineWidth = 1;
          const w = Math.sin(s.t * 60 + b.ph) * 4;
          ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - Math.sin(a) * w, b.y + Math.cos(a) * w); ctx.stroke();
        }
      });
      ctx.restore();
    } };
  },

  // ⚡ Night falls, rain hammers down and bolts strike every lucky plot, each
  // with a white flash and a shower of sparks.
  burza() {
    const R = Array.from({ length: 260 }, () => ({ x: fevRand(0, window.innerWidth + 200), y: fevRand(-window.innerHeight, window.innerHeight), l: fevRand(12, 26), v: fevRand(900, 1300) }));
    const strikes = [], sparks = [];
    let flash = 0, next = 0.9, idx = 0;
    const bolt = (x0, y0, x1, y1) => {
      const pts = [[x0, y0]]; const n = 14;
      for (let i = 1; i < n; i++) { const f = i / n; pts.push([x0 + (x1 - x0) * f + fevRand(-28, 28), y0 + (y1 - y0) * f]); }
      pts.push([x1, y1]); return pts;
    };
    return { step(ctx, s) {
      ctx.save();
      ctx.strokeStyle = 'rgba(170,190,255,' + 0.45 * s.env + ')'; ctx.lineWidth = 1.2;
      R.forEach(r => { r.y += r.v * s.dt; r.x -= r.v * 0.18 * s.dt; if (r.y > s.H) { r.y = -20; r.x = fevRand(0, s.W + 200); }
        ctx.beginPath(); ctx.moveTo(r.x, r.y); ctx.lineTo(r.x - r.l * 0.18, r.y + r.l); ctx.stroke(); });
      if (s.cells.length && s.t >= next && idx < s.cells.length + 2) {
        const c = s.cells[idx % s.cells.length];
        strikes.push({ pts: bolt(c.x + fevRand(-120, 120), -10, c.x, c.y), life: 0 });
        for (let i = 0; i < 30; i++) sparks.push({ x: c.x, y: c.y, vx: fevRand(-260, 260), vy: fevRand(-320, 60), life: 0, max: fevRand(0.4, 0.9) });
        flash = 1; idx++; next = s.t + fevRand(0.35, 0.7);
      }
      if (flash > 0) { ctx.fillStyle = 'rgba(235,240,255,' + 0.75 * flash * s.env + ')'; ctx.fillRect(0, 0, s.W, s.H); flash = Math.max(0, flash - s.dt * 6); }
      ctx.globalCompositeOperation = 'lighter';
      strikes.forEach(b => {
        const a = Math.max(0, 1 - b.life / 0.45);
        [[10, 'rgba(130,150,255,' + 0.35 * a + ')'], [3, 'rgba(240,245,255,' + a + ')']].forEach(([w, col]) => {
          ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath();
          b.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); });
        b.life += s.dt;
      });
      sparks.forEach(p => { const k = p.life / p.max; ctx.fillStyle = 'rgba(255,240,160,' + (1 - k) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, 7); ctx.fill(); });
      ctx.restore();
      for (let i = sparks.length - 1; i >= 0; i--) { const p = sparks[i]; p.life += s.dt; p.vy += 700 * s.dt;
        p.x += p.vx * s.dt; p.y += p.vy * s.dt; if (p.life > p.max) sparks.splice(i, 1); }
    } };
  },

  // 🌧️ Molten-gold rain over the whole farm, a warm sun breaking through and
  // sparkles bursting on every watered plot.
  zloty_deszcz() {
    const R = Array.from({ length: 220 }, () => ({ x: fevRand(0, window.innerWidth), y: fevRand(-window.innerHeight, 0), l: fevRand(14, 30), v: fevRand(520, 820) }));
    const S = [];
    return { step(ctx, s) {
      ctx.save();
      const g = ctx.createRadialGradient(s.W * 0.5, -s.H * 0.1, 0, s.W * 0.5, -s.H * 0.1, s.H * 0.9);
      g.addColorStop(0, 'rgba(255,230,120,' + 0.45 * s.env + ')'); g.addColorStop(1, 'rgba(255,200,40,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, s.W, s.H);
      ctx.globalCompositeOperation = 'lighter';
      R.forEach(r => {
        r.y += r.v * s.dt; if (r.y > s.H) { r.y = fevRand(-80, -10); r.x = fevRand(0, s.W); }
        const lg = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.l);
        lg.addColorStop(0, 'rgba(255,215,80,0)'); lg.addColorStop(1, 'rgba(255,225,120,' + 0.85 * s.env + ')');
        ctx.strokeStyle = lg; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(r.x, r.y); ctx.lineTo(r.x, r.y + r.l); ctx.stroke();
      });
      if (s.t > 0.8) s.cells.forEach(c => { if (Math.random() < 0.35) S.push({ x: c.x + fevRand(-c.w / 2, c.w / 2), y: c.y + fevRand(-c.h / 2, c.h / 2), life: 0, max: fevRand(0.4, 0.9), r: fevRand(2, 5) }); });
      S.forEach(p => { const k = p.life / p.max, r = p.r * (1 - k);
        ctx.fillStyle = 'rgba(255,245,180,' + (1 - k) * s.env + ')';
        ctx.beginPath(); ctx.moveTo(p.x, p.y - r * 3); ctx.lineTo(p.x + r, p.y); ctx.lineTo(p.x, p.y + r * 3); ctx.lineTo(p.x - r, p.y); ctx.fill();
        ctx.beginPath(); ctx.moveTo(p.x - r * 3, p.y); ctx.lineTo(p.x, p.y + r); ctx.lineTo(p.x + r * 3, p.y); ctx.lineTo(p.x, p.y - r); ctx.fill(); });
      ctx.restore();
      for (let i = S.length - 1; i >= 0; i--) { S[i].life += s.dt; if (S[i].life > S[i].max) S.splice(i, 1); }
    } };
  },

  // 🐝 Bees stream in on wavy paths, buzz around each pollinated plot leaving
  // pollen, and flowers pop up under them.
  roj() {
    const bees = [], pollen = [], flowers = [];
    let made = false;
    return { step(ctx, s) {
      if (!made && s.cells.length) {
        made = true;
        s.cells.slice(0, 40).forEach((c, i) => { for (let j = 0; j < 2; j++) bees.push({ c, x: s.W + fevRand(20, 400), y: fevRand(0, s.H),
          ph: fevRand(0, 6.28), delay: i * 0.05 + j * 0.2, arrived: false }); });
      }
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '22px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
      flowers.forEach(f => { const k = Math.min(1, f.life / 0.4); ctx.globalAlpha = s.env;
        ctx.font = Math.round(10 + 14 * k) + 'px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
        ctx.fillText(f.e, f.x, f.y); f.life += s.dt; });
      ctx.font = '22px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
      bees.forEach(b => {
        if (s.t < b.delay) return;
        const leaving = s.t > FEV_DURATION - 1.6;
        const tx = leaving ? -200 : b.c.x + Math.cos(s.t * 6 + b.ph) * b.c.w * 0.45;
        const ty = leaving ? b.y - 80 : b.c.y + Math.sin(s.t * 8 + b.ph) * b.c.h * 0.4;
        b.x += (tx - b.x) * Math.min(1, s.dt * (leaving ? 1.6 : 2.4));
        b.y += (ty - b.y) * Math.min(1, s.dt * 2.4) + Math.sin(s.t * 14 + b.ph) * 1.4;
        if (!b.arrived && Math.hypot(b.x - b.c.x, b.y - b.c.y) < 40) {
          b.arrived = true;
          flowers.push({ x: b.c.x + fevRand(-b.c.w / 3, b.c.w / 3), y: b.c.y + b.c.h * 0.3, e: fevPick(['🌼', '🌸', '🌻', '🌷']), life: 0 });
        }
        if (Math.random() < 0.5) pollen.push({ x: b.x, y: b.y, life: 0, max: 0.8 });
        ctx.globalAlpha = s.env;
        ctx.save(); ctx.translate(b.x, b.y); ctx.scale(tx < b.x ? 1 : -1, 1); ctx.fillText('🐝', 0, 0); ctx.restore();
      });
      pollen.forEach(p => { const k = p.life / p.max; ctx.globalAlpha = (1 - k) * 0.8 * s.env;
        ctx.fillStyle = '#fde047'; ctx.beginPath(); ctx.arc(p.x, p.y + k * 10, 1.8, 0, 7); ctx.fill(); p.life += s.dt; });
      ctx.restore();
      for (let i = pollen.length - 1; i >= 0; i--) if (pollen[i].life > pollen[i].max) pollen.splice(i, 1);
    } };
  },
};
