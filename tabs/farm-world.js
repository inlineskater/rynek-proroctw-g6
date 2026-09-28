// ════════════════════════════════════════════════════════════════════════════
//  Ogródek „living world" — lazy module (TAB_MODULES.farmworld)
// ════════════════════════════════════════════════════════════════════════════
//  📋 Tablica Zamówień: NPC customers who want a MIX of crops, drawn from the
//  crops the office is not selling, plus one daily 💎 Kolekcjoner order for an
//  NFT crop. Backend: supabase/farm-orders.sql. The server is authoritative for
//  everything — this file only renders farm_orders_state() and calls
//  fill_farm_order(). Design and the anti-inflation argument: docs/farma.md.
//
//  Lives outside index.html for the payload budget. index.html keeps only the
//  hub tab entry and one withTabModule() branch in renderFarmHubBody().

(function farmWorldInjectCss() {
  if (document.getElementById('farm-world-css')) return;
  const s = document.createElement('style');
  s.id = 'farm-world-css';
  s.textContent = `
    .fw-orders { display: flex; flex-direction: column; gap: 12px; color: var(--text); }
    .fw-lead { font-size: 12.5px; line-height: 1.55; color: var(--muted); margin: 2px 2px 0; }
    .fw-lead b { color: var(--text); }
    .fw-week { display: flex; gap: 8px; flex-wrap: wrap; }
    .fw-chip { font-size: 11.5px; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--border);
      background: var(--surface); color: var(--muted); font-variant-numeric: tabular-nums; }
    .fw-chip b { color: var(--text); }
    .fw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
    .fw-card { display: flex; flex-direction: column; gap: 9px; padding: 12px; border-radius: var(--r-md, 12px);
      border: 1px solid var(--border); background: var(--surface); min-width: 0; }
    .fw-card.is-collector { border-color: color-mix(in srgb, #a855f7 55%, var(--border));
      background: linear-gradient(180deg, color-mix(in srgb, #a855f7 8%, var(--surface)), var(--surface)); }
    .fw-card.is-done { opacity: .72; }
    .fw-card-head { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .fw-cust-emoji { font-size: 26px; line-height: 1; flex: 0 0 auto; }
    .fw-cust { min-width: 0; }
    .fw-cust-name { font-weight: 800; font-size: 13.5px; overflow-wrap: anywhere; }
    .fw-cust-sub { font-size: 11px; color: var(--muted); }
    .fw-tag { margin-left: auto; flex: 0 0 auto; font-size: 10.5px; font-weight: 800; padding: 2px 7px; border-radius: 999px;
      background: color-mix(in srgb, #a855f7 18%, transparent); color: #9333ea; text-transform: uppercase; letter-spacing: .04em; }
    .fw-lines { display: flex; flex-direction: column; gap: 6px; }
    .fw-line { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; font-size: 12.5px; }
    .fw-line-ico { font-size: 18px; line-height: 1; }
    .fw-line-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fw-line-qty { font-variant-numeric: tabular-nums; font-weight: 700; }
    .fw-line-qty.ok { color: #16a34a; }
    .fw-line-qty.short { color: #dc2626; }
    .fw-line-bar { grid-column: 2 / 4; height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--muted) 20%, transparent); overflow: hidden; }
    .fw-line-bar > i { display: block; height: 100%; background: #16a34a; border-radius: inherit; }
    .fw-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: auto; }
    .fw-reward { font-weight: 800; font-size: 15px; font-variant-numeric: tabular-nums; }
    .fw-foot .farm-mini-btn { margin-left: auto; }
    .fw-fills { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
    .fw-empty { padding: 18px 12px; text-align: center; color: var(--muted); font-size: 12px; }

    /* Paper notes pinned to a cork board (2026-09-28). The notes keep their own
       ink colours on purpose: paper is paper in dark mode too. */
    .fw-grid { padding: 18px 14px 14px; border-radius: 12px; gap: 16px;
      background-color: #c9a06b;
      background-image: radial-gradient(rgba(92,58,24,.28) 1px, transparent 1.4px), radial-gradient(rgba(255,240,210,.22) 1px, transparent 1.4px);
      background-size: 9px 9px, 13px 13px; background-position: 0 0, 4px 6px;
      box-shadow: inset 0 0 0 6px #8a5a2b, inset 0 0 0 7px rgba(0,0,0,.18), inset 0 3px 10px rgba(0,0,0,.25); }
    .fw-card { position: relative; border: 0; border-radius: 2px; background: #fffdf3; color: #2b2317;
      box-shadow: 0 1px 1px rgba(0,0,0,.12), 0 6px 14px rgba(60,35,10,.28); transform: rotate(var(--tilt, -1deg));
      transition: transform .18s ease, box-shadow .18s ease; padding-top: 16px; }
    .fw-card:nth-child(3n+2) { --tilt: 1.2deg; }
    .fw-card:nth-child(3n) { --tilt: -.4deg; }
    .fw-card:hover { transform: rotate(0) translateY(-2px); box-shadow: 0 2px 2px rgba(0,0,0,.12), 0 12px 22px rgba(60,35,10,.32); }
    .fw-card::before { content: ''; position: absolute; top: -6px; left: 50%; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, #ff8a80, #d32f2f 60%, #8e1b1b); box-shadow: 0 2px 3px rgba(0,0,0,.35); }
    .fw-card .fw-cust-sub, .fw-card .fw-fills { color: #7a6a52; }
    .fw-card .fw-line-bar { background: rgba(60,40,15,.12); }
    .fw-card.is-collector { background: #f6f0ff; }
    .fw-card.is-collector::before { background: radial-gradient(circle at 35% 35%, #d8b4fe, #7e22ce 60%, #3b0764); }
    .fw-card.is-done { opacity: 1; }
    .fw-card.is-done > * { opacity: .55; }
    .fw-card.is-done::after { content: 'ZREALIZOWANE'; position: absolute; right: 10px; top: 42%; padding: 3px 8px;
      border: 2px solid #15803d; border-radius: 4px; color: #15803d; font-weight: 900; font-size: 13px; letter-spacing: .08em;
      transform: rotate(-12deg); opacity: .85; pointer-events: none; }

    /* One-shot effects over a board plot, in a fixed layer so a board re-render
       (which replaces every cell) cannot cut them short. */
    .fw-fx { position: fixed; z-index: 90; pointer-events: none; display: flex; align-items: center; justify-content: center; }
    .fw-fx .fw-drop { position: absolute; top: 0; font-size: 14px; animation: fwDrop .9s ease-in forwards; opacity: 0; }
    .fw-fx .fw-drop:nth-child(2) { left: 30%; animation-delay: .15s; }
    .fw-fx .fw-drop:nth-child(3) { left: 60%; animation-delay: .3s; }
    @keyframes fwDrop { 0% { opacity: 0; transform: translateY(-14px); } 20% { opacity: 1; } 100% { opacity: 0; transform: translateY(26px) scale(.7); } }
    .fw-fx .fw-crow { display: flex; align-items: center; gap: 1px; font-size: 18px; animation: fwCrow 1.7s cubic-bezier(.4,.1,.6,1) forwards; }
    .fw-fx .fw-crow .farm-ico { width: 26px; height: 26px; }
    .fw-fx .fw-crow .fw-loot { font-size: 13px; margin-top: 12px; }
    @keyframes fwCrow { 0% { transform: translate(0, 0) scale(.6); opacity: 0; } 15% { opacity: 1; transform: translate(0, -6px) scale(1); }
      100% { transform: translate(160px, -140px) scale(.8); opacity: 0; } }
  `;
  document.head.appendChild(s);
})();

// Error slugs raised by farm-orders.sql, added to the shared farm map so fmErr()
// can translate them like every other farm RPC error.
Object.assign(FARM_ERR, {
  order_not_found: 'Tego zamówienia już nie ma.',
  order_expired: 'To zamówienie już wygasło.',
  order_already_filled: 'To zamówienie już zrealizowałeś.',
  not_enough_crops: FARM_ERR.not_enough_crops || 'Masz za mało plonów.',
});

// Drops or a crow over plot (x, y). Everyone watching the board sees them —
// the realtime handler fires one for every watering and theft — which is what
// makes the shared field feel inhabited. No-op off the farm tab or with
// reduced motion.
function fwFxAt(x, y, kind, cropType) {
  if (activeTab !== 'farm' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cell = document.querySelector('#farm-board .farm-cell[data-xy="' + x + ',' + y + '"]');
  if (!cell) return;
  const r = cell.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) return;
  const fx = el('div', { className: 'fw-fx', style: 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px' });
  if (kind === 'water') {
    fx.append(el('span', { className: 'fw-drop' }, '💧'), el('span', { className: 'fw-drop' }, '💧'), el('span', { className: 'fw-drop' }, '💧'));
  } else {
    fx.append(el('span', { className: 'fw-crow' }, farmIcon('🐦‍⬛'),
      el('span', { className: 'fw-loot' }, cropType ? farmCropIdentity(cropType).emoji : '🌾')));
  }
  document.body.append(fx);
  setTimeout(() => fx.remove(), kind === 'water' ? 1400 : 1800);
}

const FW_ORDERS_STALE_MS = 20000;
let fwOrders = null;          // last farm_orders_state() payload
let fwOrdersAt = 0;           // when it was fetched (ms)
let fwOrdersLoading = null;   // in-flight promise
let fwFilling = false;
let fwChannel = null;

function fwOrdersVisible() {
  return !!farmModalEl && farmHubTab === 'orders';
}

function loadFarmOrders() {
  if (fwOrdersLoading) return fwOrdersLoading;
  fwOrdersLoading = (async () => {
    try {
      const { data, error } = await sb.rpc('farm_orders_state');
      if (error) throw error;
      fwOrders = data || { orders: [] };
      fwOrdersAt = Date.now();
    } catch (e) {
      console.error('farm_orders_state', e);
      if (!fwOrders) fwOrders = { orders: [], error: true };
    } finally {
      fwOrdersLoading = null;
    }
  })();
  return fwOrdersLoading;
}

// Someone else filling an order only changes the „kto zrealizował" line, so the
// realtime handler just refetches while the board is open; otherwise it marks
// the cache stale for the next open.
function fwEnsureRealtime() {
  if (fwChannel || !sb) return;
  fwChannel = sb.channel('farm-orders')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'farm_order_fills' }, () => {
      fwOrdersAt = 0;
      if (fwOrdersVisible()) loadFarmOrders().then(() => { if (fwOrdersVisible()) renderFarmHubBody(); });
    })
    .subscribe();
}

// Entry point from renderFarmHubBody(). That function runs on every hub refresh
// (including the 60s price poll), so this renders from cache and only refetches
// when the cache is stale — and then re-renders once the data arrives.
function buildFarmOrdersBody(bodyEl) {
  fwEnsureRealtime();
  const stale = Date.now() - fwOrdersAt > FW_ORDERS_STALE_MS;
  if (stale) {
    loadFarmOrders().then(() => { if (fwOrdersVisible()) renderFarmHubBody(); });
  }
  if (!fwOrders) {
    bodyEl.replaceChildren(el('div', { className: 'loading-center' }, el('div', { className: 'spinner' })));
    return;
  }
  fwRenderOrders(bodyEl);
}

// What I hold of a crop right now. The board's own `have` is a snapshot from the
// last fetch; fmInventory is patched live on every harvest and sale, so prefer it
// once the farm data is loaded.
function fwHave(line) {
  if (fmDefs.size && fmInventory) return Number(fmInventory.get(line.crop_type) || 0);
  return Number(line.have || 0);
}

function fwTimeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'wygasło';
  const h = Math.floor(ms / 3600000);
  if (h >= 24) { const d = Math.floor(h / 24); return 'jeszcze ' + d + ' ' + plCount(d, 'dzień', 'dni', 'dni') + ' ' + (h % 24) + ' h'; }
  if (h >= 1) return 'jeszcze ' + h + ' h';
  return 'jeszcze ' + Math.max(1, Math.round(ms / 60000)) + ' min';
}

function fwRenderOrders(bodyEl) {
  const wrap = el('div', { className: 'fw-orders' });
  wrap.append(el('div', { className: 'fw-lead' },
    'Klienci biura zamawiają ', el('b', {}, 'zestawy plonów'),
    ' — zwykle tych, których nikt teraz nie uprawia, i płacą za nie ',
    el('b', {}, 'wyraźnie więcej niż skup'), '. Każde zamówienie możesz zrealizować raz; nikt nikomu go nie zabiera. ',
    'Codziennie o północy przychodzą nowe, a każde wisi 3 dni — jest czas, żeby coś pod nie zasadzić. ',
    el('b', {}, '💎 Kolekcjoner'), ' kupuje plony z kart NFT.'));

  const wk = fwOrders.my_week || {};
  wrap.append(el('div', { className: 'fw-week' },
    el('span', { className: 'fw-chip' }, 'Twoje zamówienia (7 dni): ', el('b', {}, String(wk.fills || 0))),
    el('span', { className: 'fw-chip' }, 'Zarobione: ', el('b', {}, fmtNum(wk.coins || 0) + ' 🪙'))));

  const orders = (fwOrders.orders || []).filter(o => new Date(o.expires_at).getTime() > Date.now());
  if (!orders.length) {
    wrap.append(el('div', { className: 'fw-empty' }, fwOrders.error
      ? 'Nie udało się wczytać zamówień. Spróbuj za chwilę.'
      : 'Dziś nie ma zamówień — zajrzyj jutro.'));
    bodyEl.replaceChildren(wrap);
    return;
  }

  // Open-and-fillable first, then open-but-short, then the ones I already did.
  const rank = o => o.mine ? 2 : (o.lines.every(l => fwHave(l) >= l.qty) ? 0 : 1);
  orders.sort((a, b) => rank(a) - rank(b) || new Date(a.expires_at) - new Date(b.expires_at));

  const grid = el('div', { className: 'fw-grid' });
  orders.forEach(o => grid.append(fwOrderCard(o)));
  wrap.append(grid);
  bodyEl.replaceChildren(wrap);
}

function fwOrderCard(o) {
  const collector = o.kind === 'collector';
  const card = el('div', { className: 'fw-card' + (collector ? ' is-collector' : '') + (o.mine ? ' is-done' : '') });
  const head = el('div', { className: 'fw-card-head' },
    el('span', { className: 'fw-cust-emoji' }, o.emoji || '🧺'),
    el('div', { className: 'fw-cust' },
      el('div', { className: 'fw-cust-name' }, o.customer),
      el('div', { className: 'fw-cust-sub' }, fwTimeLeft(o.expires_at))));
  if (collector) head.append(el('span', { className: 'fw-tag' }, 'NFT'));
  card.append(head);

  const lines = el('div', { className: 'fw-lines' });
  let ready = true;
  (o.lines || []).forEach(l => {
    const id = farmCropIdentity(l.crop_type);
    const have = fwHave(l);
    const ok = have >= l.qty;
    if (!ok) ready = false;
    const pct = Math.min(100, Math.round(have / Math.max(1, l.qty) * 100));
    lines.append(el('div', { className: 'fw-line' },
      el('span', { className: 'fw-line-ico' }, id.emoji),
      el('span', { className: 'fw-line-name', title: id.name }, id.name),
      el('span', { className: 'fw-line-qty ' + (o.mine ? '' : ok ? 'ok' : 'short') },
        (o.mine ? '' : fmtNum(Math.min(have, l.qty)) + ' / ') + fmtNum(l.qty)),
      o.mine ? '' : el('span', { className: 'fw-line-bar' }, el('i', { style: 'width:' + pct + '%' }))));
  });
  card.append(lines);

  const foot = el('div', { className: 'fw-foot' }, el('span', { className: 'fw-reward' }, fmtNum(o.reward) + ' 🪙'));
  if (o.mine) {
    foot.append(el('span', { className: 'fw-chip' }, '✅ Zrealizowane'));
  } else {
    const btn = el('button', { className: 'farm-mini-btn' + (ready ? ' primary' : '') }, ready ? 'Realizuj' : 'Brakuje plonów');
    btn.disabled = !ready;
    btn.addEventListener('click', () => fwFillOrder(o, btn));
    foot.append(btn);
  }
  card.append(foot);

  const fills = o.fills || [];
  if (fills.length) {
    card.append(el('div', { className: 'fw-fills' }, '👥 Zrealizowali: ' + fills.map(f => f.nick).join(', ')));
  }
  return card;
}

async function fwFillOrder(o, btn) {
  if (fwFilling) return;
  const summary = o.lines.map(l => fmtNum(l.qty) + ' ' + farmCropIdentity(l.crop_type).emoji).join(' + ');
  if (!confirm('Oddać ' + summary + ' za ' + fmtNum(o.reward) + ' 🪙?\n\n' + o.customer)) return;
  fwFilling = true;
  if (btn) btn.disabled = true;
  try {
    const { data, error } = await sb.rpc('fill_farm_order', { p_order_id: o.id });
    if (error) { showToast('❌ ' + fmErr(error)); return; }
    if (typeof data.coins === 'number') { me.coins = data.coins; setText(headerCoins, me.coins); }
    const tax = Number(data.tax_paid || 0);
    showToast('📋 ' + o.customer + ': +' + fmtNum(data.reward) + ' 🪙'
      + (tax > 0 ? ' (−' + fmtNum(tax) + ' 🪙 na podatek gruntowy)' : ''));
    o.mine = true;   // instant feedback; the refetch below is authoritative
    scheduleFarmInventoryReconcile();
    fwOrdersAt = 0;
    await loadFarmOrders();
  } finally {
    fwFilling = false;
    if (fwOrdersVisible()) renderFarmHubBody();
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  🌦️ Pogoda z Wrocławia — real weather drives yield (supabase/farm-weather.sql)
// ════════════════════════════════════════════════════════════════════════════
//  The server logs Open-Meteo's hourly Wrocław weather itself and harvest_crop()
//  multiplies the yield by the crop's AVERAGE affinity over the real hours it
//  grew. Here we only render that and PREVIEW it: past hours come from the same
//  log the server will use, forecast hours from Open-Meteo's forecast, and hours
//  beyond the forecast are assumed to look like the recent past.

(function farmWeatherInjectCss() {
  if (document.getElementById('farm-weather-css')) return;
  const s = document.createElement('style');
  s.id = 'farm-weather-css';
  s.textContent = `
    /* One line, the height of the Wspólny Cel bar it sits beside (.farm-strips
       in index.html); the forecast tiles and the crop table open on demand and
       then take the whole row. A container query drops the mini forecast when
       the strip shares its row on a narrow screen. */
    #fw-banner { display: flex; flex-direction: column; gap: 10px; width: 100%; box-sizing: border-box; margin: 0; min-width: 0;
      padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--card); color: var(--text);
      container-type: inline-size; }
    #fw-banner.hidden { display: none; }
    #fw-banner.fw-open { grid-column: 1 / -1; }
    .fw-wx-row { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .fw-wx-ic { font-size: 22px; line-height: 1; flex: 0 0 auto; }
    .fw-wx-main { flex: 1 1 auto; min-width: 0; }
    .fw-wx-title { font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fw-wx-sub { font-size: 12px; color: var(--muted); line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fw-wx-mini { display: flex; gap: 4px; flex: 0 0 auto; }
    .fw-wx-mini > span { display: flex; flex-direction: column; align-items: center; min-width: 38px; padding: 2px 4px; border-radius: 7px;
      background: var(--surface); border: 1px solid var(--border); font-size: 10px; line-height: 1.25; color: var(--muted); font-variant-numeric: tabular-nums; }
    .fw-wx-mini b { font-size: 13px; }
    @container (max-width: 470px) { .fw-wx-mini { display: none; } }
    .fw-wx-sub b { color: var(--text); }
    .fw-wx-good { color: #16a34a; font-weight: 700; }
    .fw-wx-bad { color: #dc2626; font-weight: 700; }
    .fw-wx-btn { flex: 0 0 auto; font: inherit; font-size: 12px; font-weight: 600; color: var(--accent); background: none; border: 0; cursor: pointer; padding: 4px 0; white-space: nowrap; }
    .fw-wx-strip { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
    .fw-wx-strip::-webkit-scrollbar { display: none; }
    .fw-wx-cell { flex: 1 0 44px; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 4px 2px;
      border-radius: 8px; background: var(--surface); border: 1px solid var(--border); font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .fw-wx-cell b { font-size: 16px; line-height: 1.2; }
    .fw-wx-cell.now { border-color: var(--accent); color: var(--text); }
    .fw-wx-details { display: flex; flex-direction: column; gap: 6px; }
    .fw-wx-note { font-size: 11.5px; color: var(--muted); line-height: 1.5; }
    .fw-wx-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .fw-wx-table th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11px; padding: 4px 6px; border-bottom: 1px solid var(--border); }
    .fw-wx-table td { padding: 5px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .fw-wx-table td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 700; }
    .fw-wx-table tr:last-child td { border-bottom: 0; }
    @media (max-width: 560px) { .fw-wx-table .fw-hide-sm { display: none; } }
  `;
  document.head.appendChild(s);
})();

const FW_WX_LABELS = {
  clear:   { ic: '☀️', name: 'Słonecznie' },
  cloudy:  { ic: '☁️', name: 'Pochmurno' },
  fog:     { ic: '🌫️', name: 'Mgła' },
  rain:    { ic: '🌧️', name: 'Deszcz' },
  snow:    { ic: '❄️', name: 'Śnieg' },
  thunder: { ic: '⛈️', name: 'Burza' },
  hot:     { ic: '🔥', name: 'Upał' },
  frost:   { ic: '🥶', name: 'Przymrozek' },
};
const FW_WX_STALE_MS = 10 * 60 * 1000;
let fwWx = null;            // { hours: [{ms, c, t}], byCrop: Map(crop -> Map(cat -> mult)), bounds, current }
let fwWxAt = 0;
let fwWxLoading = null;
let fwWxOpen = false;

function loadFarmWeather() {
  if (fwWxLoading) return fwWxLoading;
  fwWxLoading = (async () => {
    try {
      const { data, error } = await sb.rpc('farm_weather_state');
      if (error) throw error;
      const byCrop = new Map();
      (data.affinity || []).forEach(a => {
        if (!byCrop.has(a.crop_type)) byCrop.set(a.crop_type, new Map());
        byCrop.get(a.crop_type).set(a.category, Number(a.mult));
      });
      fwWx = {
        hours: (data.hours || []).map(h => ({ ms: new Date(h.h).getTime(), c: h.c, t: h.t })).sort((a, b) => a.ms - b.ms),
        byCrop,
        bounds: { lo: Number(data.bounds?.lo ?? 0.75), hi: Number(data.bounds?.hi ?? 1.35) },
        current: data.current || null,
      };
      fwWxAt = Date.now();
    } catch (e) {
      // Not installed yet / offline: the banner stays hidden and every
      // projection keeps the neutral multiplier.
      console.warn('farm_weather_state', e);
    } finally { fwWxLoading = null; }
  })();
  return fwWxLoading;
}

function fwWxMult(cropType, cat) {
  return fwWx?.byCrop.get(cropType)?.get(cat) ?? 1;
}

// Mirror of farm_weather_yield_mult(): mean affinity over each whole hour of
// [from, to), clamped. Unlike the server (which only ever sees the past), a
// preview has to fill future hours: forecast where Open-Meteo has one, and past
// that the average of what is known around now — tomorrow is most likely to
// look like today, and that beats pretending it will be neutral.
function fwWeatherMultWindow(cropType, fromMs, toMs) {
  if (!fwWx || !fwWx.hours.length || !(toMs > fromMs)) return 1;
  const H = 3600000;
  const a = Math.floor(fromMs / H) * H;
  const b = Math.max(a + H, Math.floor(toMs / H) * H);
  const byHour = new Map(fwWx.hours.map(h => [h.ms, h.c]));
  const now = Date.now();
  const recent = fwWx.hours.filter(h => h.ms > now - 24 * H);
  const persist = recent.length ? recent.reduce((s, h) => s + fwWxMult(cropType, h.c), 0) / recent.length : 1;
  let sum = 0, n = 0;
  for (let t = a; t < b; t += H) {
    const c = byHour.get(t);
    sum += c ? fwWxMult(cropType, c) : (t < now ? 1 : persist);
    n++;
  }
  const m = n ? sum / n : 1;
  return Math.min(fwWx.bounds.hi, Math.max(fwWx.bounds.lo, m));
}

// Overrides the index.html stub used by farmPlantIncomeCalc(). `over.wxFrom/
// wxTo` is a planted tile's real window; otherwise it is "plant it now".
function farmWeatherYieldMult(def, over, growMin) {
  if (!fwWx || !def?.crop_type) return 1;
  const from = over?.wxFrom ? new Date(over.wxFrom).getTime() : Date.now();
  const to = over?.wxTo ? new Date(over.wxTo).getTime() : from + (growMin || 1440) * 60000;
  const m = fwWeatherMultWindow(def.crop_type, from, to);
  // An NFT with the weather_shield talent floors it at 1 (farm-neighbours.sql).
  return fwHasTalent('weather_shield') ? Math.max(1, m) : m;
}

// Entry point from loadFarm(): everything the board shows outside the hub.
async function fwRefresh() {
  fwEnsureNbRealtime();
  await Promise.all([fwWeatherRefresh(), fwNbRefresh()]);
}

async function fwWeatherRefresh() {
  const first = !fwWx;
  if (!fwWx || Date.now() - fwWxAt > FW_WX_STALE_MS) await loadFarmWeather();
  fwRenderWeatherBanner();
  // Projections (Mój Majątek ranking, planting picker) read the multiplier
  // lazily; repaint an open hub once so the first load shows up in them.
  if (first && fwWx && farmModalEl && farmHubTab !== 'orders') refreshFarmHub();
}

// The crops worth naming: everything with a market row and a known plant.
function fwWxCrops() {
  const seen = new Set();
  const out = [];
  [...fmDefs.values()].forEach(d => {
    if (!d.crop_type || seen.has(d.crop_type) || !fmMarket.has(d.crop_type)) return;
    seen.add(d.crop_type);
    out.push(d.crop_type);
  });
  return out;
}

function fwWxCropChip(ct, m) {
  const id = farmCropIdentity(ct);
  return el('span', { title: id.name + ' ×' + m.toFixed(2) }, id.emoji);
}

function fwRenderWeatherBanner() {
  const host = document.getElementById('fw-banner');
  if (!host) return;
  const cur = fwWx?.current;
  if (!fwWx || !cur) { host.classList.add('hidden'); return; }
  host.classList.remove('hidden');
  const lab = FW_WX_LABELS[cur.category] || FW_WX_LABELS.cloudy;

  const crops = fwWxCrops();
  const good = crops.map(ct => [ct, fwWxMult(ct, cur.category)]).filter(x => x[1] > 1).sort((a, b) => b[1] - a[1]);
  const bad = crops.map(ct => [ct, fwWxMult(ct, cur.category)]).filter(x => x[1] < 1).sort((a, b) => a[1] - b[1]);

  const sub = el('div', { className: 'fw-wx-sub' });
  if (good.length) {
    sub.append('Lepiej: ');
    good.forEach(([ct, m]) => sub.append(fwWxCropChip(ct, m), ' '));
  }
  if (bad.length) {
    if (good.length) sub.append(' · ');
    sub.append('gorzej: ');
    bad.forEach(([ct, m]) => sub.append(fwWxCropChip(ct, m), ' '));
  }
  if (!good.length && !bad.length) sub.append('Ta pogoda nie sprzyja ani nie szkodzi żadnej uprawie.');

  const btn = el('button', { className: 'fw-wx-btn', type: 'button', title: 'Prognoza i to, jak pogoda działa na uprawy' },
    fwWxOpen ? 'Zwiń ▴' : 'Więcej ▾');
  btn.addEventListener('click', () => { fwWxOpen = !fwWxOpen; fwRenderWeatherBanner(); });

  const temp = cur.temp_c != null ? ', ' + Math.round(cur.temp_c) + '°C' : '';
  host.classList.toggle('fw-open', fwWxOpen);
  const blocks = fwWxBlocks(fwWxOpen ? 8 : 4);
  const mini = el('div', { className: 'fw-wx-mini', 'aria-hidden': 'true' });
  if (!fwWxOpen) blocks.slice(1).forEach(b => mini.append(el('span', { title: b.name }, el('b', {}, b.ic), b.temp, ' ' + b.label)));
  host.replaceChildren(
    el('div', { className: 'fw-wx-row' },
      el('span', { className: 'fw-wx-ic' }, lab.ic),
      el('div', { className: 'fw-wx-main' },
        el('div', { className: 'fw-wx-title', title: 'Pogoda we Wrocławiu' }, 'Wrocław: ' + lab.name + temp),
        sub),
      mini,
      btn));
  if (fwWxOpen) host.append(fwWxStrip(blocks), fwWxDetails(crops));
}

// The next n 6-hour blocks, each shown as its most common condition.
function fwWxBlocks(n) {
  const H = 3600000, now = Date.now();
  const start = Math.floor(now / (6 * H)) * 6 * H;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = start + i * 6 * H, b = a + 6 * H;
    const hs = fwWx.hours.filter(h => h.ms >= a && h.ms < b);
    if (!hs.length) continue;
    const counts = {};
    hs.forEach(h => { counts[h.c] = (counts[h.c] || 0) + 1; });
    const cat = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0];
    const temps = hs.map(h => Number(h.t)).filter(Number.isFinite);
    const lab = FW_WX_LABELS[cat] || FW_WX_LABELS.cloudy;
    out.push({ now: i === 0, ic: lab.ic, name: lab.name,
      temp: temps.length ? Math.round(Math.max(...temps)) + '°' : '',
      label: i === 0 ? 'teraz' : String(new Date(a).getHours()).padStart(2, '0') + ':00' });
  }
  return out;
}

// Next 48 h, shown only while the strip is expanded.
function fwWxStrip(blocks) {
  const strip = el('div', { className: 'fw-wx-strip' });
  blocks.forEach(b => strip.append(el('div', { className: 'fw-wx-cell' + (b.now ? ' now' : ''), title: b.name },
    el('b', {}, b.ic), b.temp, el('span', {}, b.label))));
  return strip;
}

function fwWxDetails(crops) {
  const H = 3600000, now = Date.now();
  const wrap = el('div', { className: 'fw-wx-details' });
  wrap.append(el('div', { className: 'fw-wx-note' },
    'Pogoda jest prawdziwa — serwer co pół godziny pobiera ją dla Wrocławia z Open-Meteo. ',
    'Każda roślina lubi inną pogodę. Przy zbiorze plon mnoży się przez ', el('b', {}, 'średnią z każdej godziny'),
    ', którą roślina spędziła w ziemi (od ×' + fwWx.bounds.lo.toFixed(2) + ' do ×' + fwWx.bounds.hi.toFixed(2) + '). ',
    'Kolumna „Zasadzone teraz" to prognoza na najbliższy dzień wzrostu — rzeczywisty mnożnik wyjdzie z tego, jaka pogoda naprawdę będzie.'));
  const table = el('table', { className: 'fw-wx-table' });
  table.append(el('thead', {}, el('tr', {},
    el('th', {}, 'Uprawa'), el('th', {}, 'Lubi'), el('th', { className: 'fw-hide-sm' }, 'Nie lubi'),
    el('th', {}, 'Ostatnie 3 dni'), el('th', {}, 'Zasadzone teraz'))));
  const tb = el('tbody');
  crops.map(ct => ({ ct, past: fwWeatherMultWindow(ct, now - 72 * H, now), next: fwWeatherMultWindow(ct, now, now + 24 * H) }))
    .sort((a, b) => b.next - a.next)
    .forEach(({ ct, past, next }) => {
      const aff = fwWx.byCrop.get(ct) || new Map();
      const likes = [...aff.entries()].filter(e => e[1] > 1).map(e => (FW_WX_LABELS[e[0]] || {}).ic || e[0]).join(' ');
      const hates = [...aff.entries()].filter(e => e[1] < 1).map(e => (FW_WX_LABELS[e[0]] || {}).ic || e[0]).join(' ');
      const id = farmCropIdentity(ct);
      const cls = m => m > 1.005 ? 'num fw-wx-good' : m < 0.995 ? 'num fw-wx-bad' : 'num';
      tb.append(el('tr', {},
        el('td', {}, id.emoji + ' ' + id.name),
        el('td', {}, likes || '—'),
        el('td', { className: 'fw-hide-sm' }, hates || '—'),
        el('td', { className: cls(past) }, '×' + past.toFixed(2)),
        el('td', { className: cls(next) }, '×' + next.toFixed(2))));
    });
  table.append(tb);
  wrap.append(table);
  return wrap;
}


// ════════════════════════════════════════════════════════════════════════════
//  🤝 Sąsiedzi — combos, NFT talents, watering, theft (farm-neighbours.sql)
// ════════════════════════════════════════════════════════════════════════════
//  The server computes every bonus inside harvest_crop()'s hook; this renders
//  farm_neighbours_state(), decorates the board, offers 💧/🥷 on other players'
//  plots, and previews the bonus in farmPlantIncomeCalc().

(function farmNeighboursInjectCss() {
  if (document.getElementById('farm-nb-css')) return;
  const s = document.createElement('style');
  s.id = 'farm-nb-css';
  s.textContent = `
    .fw-cell-badges { position: absolute; top: 1px; right: 2px; z-index: 9; display: flex; gap: 1px; font-size: 10px; line-height: 1;
      pointer-events: none; filter: drop-shadow(0 1px 1px rgba(0,0,0,.5)); }
    .fw-cell-badges .fw-steal { animation: fw-pulse 1.6s ease-in-out infinite; }
    @keyframes fw-pulse { 50% { transform: scale(1.3); } }
    @media (prefers-reduced-motion: reduce) { .fw-cell-badges .fw-steal { animation: none; } }
    .fw-nb-box { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--r-md, 12px);
      border: 1px solid var(--border); background: var(--surface); font-size: 12.5px; }
    .fw-nb-box b { color: var(--text); }
    .fw-nb-head { font-weight: 800; font-size: 13.5px; }
    .fw-nb-muted { color: var(--muted); font-size: 12px; line-height: 1.5; }
    .fw-nb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .fw-nb-row .farm-mini-btn { margin-left: auto; }
    .fw-nb-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
    .fw-nb-list li { display: flex; gap: 8px; align-items: baseline; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .fw-nb-list li .t { margin-left: auto; color: var(--muted); font-size: 11px; white-space: nowrap; }
    .fw-nb-list li.mine { font-weight: 700; }
    .fw-nb-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
    .fw-tile-act { display: flex; flex-direction: column; gap: 6px; width: 100%; }
    .fw-tile-act .fw-nb-row { font-size: 12px; color: var(--muted); }
  `;
  document.head.appendChild(s);
})();

Object.assign(FARM_ERR, {
  own_tile: 'To twoja działka.',
  already_ripe: 'Ta roślina jest już dojrzała — podlewać można tylko rosnące.',
  water_limit_day: 'Wykorzystałeś dzisiejsze podlewania.',
  water_limit_tile: 'Tę roślinę podlało już dość osób.',
  already_watered: 'Już podlałeś tę roślinę.',
  not_stealable_yet: 'Właściciel ma jeszcze czas na zbiór.',
  protected: 'Tego pola pilnuje strach na wróble.',
  steal_limit_day: 'Wykorzystałeś dzisiejsze podbierania.',
  steal_limit_tile: 'Z tej rośliny podebrało już dość osób.',
  already_stolen: 'Już podbierałeś z tej rośliny.',
  nothing_to_steal: 'Nie ma już czego podbierać.',
  scarecrow_max: 'Strach na wróble jest już opłacony na długo naprzód.',
  insufficient_coins: FARM_ERR.insufficient_coins || 'Za mało monet.',
});

const FW_NB_STALE_MS = 30000;
let fwNb = null;            // farm_neighbours_state()
let fwNbAt = 0;
let fwNbLoading = null;
let fwNbChannel = null;
let fwNbBusy = false;

function loadFarmNeighbours() {
  if (fwNbLoading) return fwNbLoading;
  fwNbLoading = (async () => {
    try {
      const { data, error } = await sb.rpc('farm_neighbours_state');
      if (error) throw error;
      fwNb = data;
      fwNb.tileMap = new Map((data.tiles || []).map(t => [t.x + ',' + t.y, t]));
      fwNb.protectedSet = new Set(data.protected || []);
      fwNbAt = Date.now();
    } catch (e) {
      console.warn('farm_neighbours_state', e);   // not installed yet: board stays plain
    } finally { fwNbLoading = null; }
  })();
  return fwNbLoading;
}

async function fwNbRefresh(force) {
  if (force || !fwNb || Date.now() - fwNbAt > FW_NB_STALE_MS) await loadFarmNeighbours();
  if (activeTab === 'farm' && fwNb) renderFarmBoard();
}

function fwHasTalent(kind) {
  return !!fwNb?.me?.talents?.some(t => t.kind === kind);
}

// A watering or theft anywhere changes someone's badges; a theft from ME is
// worth interrupting for — that is the whole social point of it.
function fwEnsureNbRealtime() {
  if (fwNbChannel || !sb) return;
  fwNbChannel = sb.channel('farm-neighbours')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'farm_tile_events' }, (payload) => {
      const e = payload.new || {};
      // My own actions already animated locally when the RPC returned.
      if (e.user_id !== me?.id) fwFxAt(e.x, e.y, e.kind === 'steal' ? 'steal' : 'water', e.crop_type);
      if (e.owner_id === me?.id && e.user_id !== me?.id) {
        const who = (typeof sidePeople !== 'undefined' && sidePeople?.find?.(p => p.id === e.user_id)?.nick) || 'Ktoś';
        const crop = e.crop_type ? farmCropIdentity(e.crop_type) : null;
        showToast(e.kind === 'steal'
          ? '🥷 ' + who + ' podebrał ' + e.qty + ' ' + (crop ? crop.emoji : '') + ' z twojego pola!'
          : '💧 ' + who + ' podlał twoją roślinę (+' + Math.round((fwNb?.limits?.water_bonus || 0.03) * 100) + '% plonu).');
      }
      fwNbAt = 0;
      fwNbRefresh(true).then(() => { if (farmModalEl && farmHubTab === 'neighbours') renderFarmHubBody(); });
    })
    .subscribe();
}

// ⚠️ Plots are addressed by their fmTiles KEY ('x,y'): the tile rows loadFarm()
// keeps do not carry x/y themselves, so `tile.x + ',' + tile.y` is
// 'undefined,undefined' (that shipped once and hid every badge).
function fwTileStealable(tile, key, now) {
  if (!fwNb || !tile?.planted_species || !tile.ready_at || tile.owner_id === me?.id) return false;
  const launch = fwNb.limits?.steal_launch_at ? new Date(fwNb.limits.steal_launch_at).getTime() : 0;
  const ripeFor = now - Math.max(new Date(tile.ready_at).getTime(), launch);
  if (ripeFor < (fwNb.limits?.steal_grace_hours || 12) * 3600000) return false;
  if (fwNb.protectedSet.has(tile.owner_id)) return false;
  const ev = fwNb.tileMap.get(key);
  if (ev?.stolen_by_me) return false;
  if ((ev?.thieves || 0) >= (fwNb.limits?.steal_thieves_per_cycle || 3)) return false;
  return true;
}

// index.html hook, end of buildFarmDisplayCell() for every owned plot.
function farmWorldDecorateCell(cell, tile, now) {
  if (!fwNb || !tile?.planted_species) return;
  const key = cell.dataset.xy;
  const ev = fwNb.tileMap.get(key);
  const badges = [];
  if (ev?.waters) badges.push(el('span', { title: 'Podlana ' + ev.waters + '×' }, '💧' + (ev.waters > 1 ? ev.waters : '')));
  if (ev?.stolen) badges.push(el('span', { title: 'Podebrano ' + ev.stolen + ' szt.' }, '🧺'));
  if (fwNb.protectedSet.has(tile.owner_id) && tile.ready_at && now >= new Date(tile.ready_at).getTime()) {
    badges.push(el('span', { title: 'Pilnuje strach na wróble' }, '🧑‍🌾'));
  }
  if (fwTileStealable(tile, key, now)) badges.push(el('span', { className: 'fw-steal', title: 'Dojrzała i zapomniana — można podebrać' }, '🥷'));
  if (badges.length) cell.append(el('span', { className: 'fw-cell-badges' }, ...badges));
}

// index.html hook, the planted-crop popup's action row.
function farmWorldTileActions(tile, x, y, actions, close) {
  if (!fwNb || !tile?.planted_species) return;
  const now = Date.now();
  const L = fwNb.limits || {};
  const ev = fwNb.tileMap.get(x + ',' + y) || {};
  const box = el('div', { className: 'fw-tile-act' });
  const ready = tile.ready_at && now >= new Date(tile.ready_at).getTime();

  if (ev.waters || ev.stolen) {
    box.append(el('div', { className: 'fw-nb-row' },
      ev.waters ? '💧 Podlana ' + ev.waters + '× (+' + Math.round(ev.waters * (L.water_bonus || 0.03) * 100) + '% plonu)' : '',
      ev.waters && ev.stolen ? ' · ' : '',
      ev.stolen ? '🥷 Podebrano ' + ev.stolen + ' szt.' : ''));
  }

  if (tile.owner_id === me?.id) {
    const combos = fwCombosFor(tile, x + ',' + y);
    if (combos.length) box.append(el('div', { className: 'fw-nb-row' }, '🤝 ' + combos.map(c => c.name + ' +' + Math.round(c.bonus * 100) + '%').join(', ')));
  } else if (!ready) {
    const left = (L.water_per_day || 3) - (fwNb.me?.water_used || 0);
    const btn = el('button', { className: 'farm-mini-btn primary', type: 'button' }, '💧 Podlej (+' + Math.round((L.water_bonus || 0.03) * 100) + '% plonu)');
    btn.disabled = left <= 0 || !!ev.watered_by_me || (ev.waters || 0) >= (L.water_per_cycle || 3);
    btn.title = ev.watered_by_me ? 'Już podlałeś' : left <= 0 ? 'Brak podlewań na dziś' : 'Zostało dziś: ' + left;
    btn.addEventListener('click', () => fwWater(x, y, btn, close));
    box.append(el('div', { className: 'fw-nb-row' }, 'Podlewania dziś: ' + Math.max(0, left) + '/' + (L.water_per_day || 3), btn));
  } else if (fwTileStealable(tile, x + ',' + y, now)) {
    const left = (L.steal_per_day || 5) - (fwNb.me?.steal_used || 0);
    const btn = el('button', { className: 'farm-mini-btn', type: 'button' }, '🥷 Podbierz ' + Math.round((L.steal_share || 0.1) * 100) + '%');
    btn.disabled = left <= 0;
    btn.addEventListener('click', () => fwSteal(x, y, tile, btn, close));
    box.append(el('div', { className: 'fw-nb-row' }, 'Leży od ponad ' + (L.steal_grace_hours || 12) + ' h · podbierania dziś: ' + Math.max(0, left), btn));
  } else if (ready && fwNb.protectedSet.has(tile.owner_id)) {
    box.append(el('div', { className: 'fw-nb-row' }, '🧑‍🌾 Tego pola pilnuje strach na wróble.'));
  }
  if (box.childNodes.length) actions.prepend(box);
}

// Pairs this plot completes with the owner's OTHER plots right now.
function fwCombosFor(tile, key) {
  const def = fmDefs.get(tile.planted_species);
  if (!def || !fwNb) return [];
  const others = new Set();
  fmTiles.forEach((t, k) => {
    if (k !== key && t.owner_id === tile.owner_id && t.planted_species) {
      const d = fmDefs.get(t.planted_species);
      if (d?.crop_type) others.add(d.crop_type);
    }
  });
  return (fwNb.pairs || []).filter(p => (p.a === def.crop_type && others.has(p.b)) || (p.b === def.crop_type && others.has(p.a)));
}

// Overrides the index.html stub: combos + diversity + talents + watering, the
// same terms and cap as farm_harvest_yield(). Theft is a quantity, not a
// multiplier, so it is not here. `over.tileXY` = an already-planted plot;
// otherwise the preview is "plant this now on a free plot".
function farmNeighbourYieldMult(def, over) {
  if (!fwNb || !def?.crop_type || !me) return 1;
  const key = over?.tileXY || null;
  const mySpecies = new Set();
  const myCrops = new Set();
  fmTiles.forEach((t, k) => {
    if (t.owner_id !== me.id || !t.planted_species || k === key) return;
    mySpecies.add(t.planted_species);
    const d = fmDefs.get(t.planted_species);
    if (d?.crop_type) myCrops.add(d.crop_type);
  });
  mySpecies.add(def.species);
  const combo = (fwNb.pairs || []).reduce((s, p) =>
    s + (((p.a === def.crop_type && myCrops.has(p.b)) || (p.b === def.crop_type && myCrops.has(p.a))) ? Number(p.bonus) : 0), 0);
  const talents = fwNb.me?.talents || [];
  const tCrop = Math.max(0, ...talents.filter(t => t.kind === 'crop_boost' && t.crop_type === def.crop_type).map(t => Number(t.value)));
  const tAll = Math.max(0, ...talents.filter(t => t.kind === 'all_boost').map(t => Number(t.value)));
  const divPlus = Math.max(0, ...talents.filter(t => t.kind === 'diversity_plus').map(t => Number(t.value)));
  const n = mySpecies.size + divPlus;
  const dv = fwNb.limits?.diversity || [0.05, 0.10, 0.15];
  const div = n >= 5 ? +dv[2] : n === 4 ? +dv[1] : n === 3 ? +dv[0] : 0;
  const ev = key ? fwNb.tileMap.get(key) : null;
  const water = (ev?.waters || 0) * (fwNb.limits?.water_bonus || 0.03) * (fwHasTalent('water_double') ? 2 : 1);
  const talent = tCrop > 0 || tAll > 0;
  const cap = talent ? (fwNb.limits?.bonus_cap_talent || 0.35) : (fwNb.limits?.bonus_cap || 0.25);
  return 1 + Math.min(cap, combo + div + tCrop + tAll + water);
}

async function fwWater(x, y, btn, close) {
  if (fwNbBusy) return;
  fwNbBusy = true; if (btn) btn.disabled = true;
  try {
    const { data, error } = await sb.rpc('farm_water_tile', { p_x: x, p_y: y });
    if (error) { showToast('❌ ' + fmErr(error)); return; }
    showToast('💧 Podlane! Zostało dziś: ' + data.left_today + '.');
    if (close) close();
    fwFxAt(x, y, 'water');
    await fwNbRefresh(true);
  } finally { fwNbBusy = false; }
}

async function fwSteal(x, y, tile, btn, close) {
  if (fwNbBusy) return;
  if (!confirm('Podebrać ' + Math.round((fwNb?.limits?.steal_share || 0.1) * 100) + '% plonu? Pole: ' + (tile.nick || '?') + '. Właściciel dostanie powiadomienie.')) return;
  fwNbBusy = true; if (btn) btn.disabled = true;
  try {
    const { data, error } = await sb.rpc('farm_steal_crop', { p_x: x, p_y: y });
    if (error) { showToast('❌ ' + fmErr(error)); return; }
    showToast('🥷 Podebrano ' + data.qty + ' ' + farmCropIdentity(data.crop_type).emoji + ' — trafiło do twoich plonów.');
    if (close) close();
    fwFxAt(x, y, 'steal', data.crop_type);
    scheduleFarmInventoryReconcile();
    await fwNbRefresh(true);
  } finally { fwNbBusy = false; }
}

async function fwBuyScarecrow(btn) {
  const L = fwNb?.limits || {};
  if (!confirm('Kupić Stracha na wróble za ' + fmtNum(L.scarecrow_price || 1500) + ' 🪙? Pilnuje wszystkich twoich pól przez ' + (L.scarecrow_days || 7) + ' dni (kupione wcześniej dni się sumują).')) return;
  if (btn) btn.disabled = true;
  const { data, error } = await sb.rpc('buy_farm_scarecrow');
  if (error) { showToast('❌ ' + fmErr(error)); if (btn) btn.disabled = false; return; }
  if (typeof data.coins === 'number') { me.coins = data.coins; setText(headerCoins, me.coins); }
  showToast('🧑‍🌾 Strach na wróble pilnuje twoich pól do ' + new Date(data.scarecrow_until).toLocaleDateString('pl-PL') + '.');
  await fwNbRefresh(true);
  if (farmModalEl && farmHubTab === 'neighbours') renderFarmHubBody();
}

function fwAgo(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 60) return m + ' min temu';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h temu';
  const d = Math.round(h / 24);
  return d + ' ' + plCount(d, 'dzień', 'dni', 'dni') + ' temu';
}

// 🤝 Sąsiedzi hub tab.
function buildFarmNeighboursBody(bodyEl) {
  fwEnsureNbRealtime();
  if (!fwNb || Date.now() - fwNbAt > FW_NB_STALE_MS) {
    loadFarmNeighbours().then(() => { if (farmModalEl && farmHubTab === 'neighbours') fwRenderNeighbours(bodyEl); });
  }
  if (!fwNb) { bodyEl.replaceChildren(el('div', { className: 'loading-center' }, el('div', { className: 'spinner' }))); return; }
  fwRenderNeighbours(bodyEl);
}

function fwRenderNeighbours(bodyEl) {
  const L = fwNb.limits || {};
  const mine = fwNb.me || {};
  const wrap = el('div', { className: 'fw-orders' });
  wrap.append(el('div', { className: 'fw-lead' },
    'Farma to wspólne pole. ', el('b', {}, 'Różnorodność i pary roślin'), ' na twoich działkach podnoszą plon, ',
    el('b', {}, 'zasadzone NFT'), ' dają talenty całej twojej farmie, sąsiadom możesz ', el('b', {}, 'podlewać'),
    ' rośliny — a to, co ktoś zostawi dojrzałe na ponad ' + (L.steal_grace_hours || 12) + ' h, można ',
    el('b', {}, 'podebrać'), '. Łączny bonus: do +' + Math.round((L.bonus_cap || 0.25) * 100) + '% (+'
      + Math.round((L.bonus_cap_talent || 0.35) * 100) + '% z talentem NFT).'));

  // ── Me: today's allowance + protection ──
  const until = mine.scarecrow_until && new Date(mine.scarecrow_until).getTime() > Date.now() ? new Date(mine.scarecrow_until) : null;
  const talentShield = (mine.talents || []).some(t => t.kind === 'scarecrow');
  const scBtn = el('button', { className: 'farm-mini-btn primary', type: 'button' },
    (until ? 'Przedłuż' : 'Kup') + ' stracha · ' + fmtNum(L.scarecrow_price || 1500) + ' 🪙');
  scBtn.addEventListener('click', () => fwBuyScarecrow(scBtn));
  wrap.append(el('div', { className: 'fw-nb-box' },
    el('div', { className: 'fw-nb-head' }, '🧑‍🌾 Ty'),
    el('div', { className: 'fw-nb-row' },
      el('span', { className: 'fw-chip' }, '💧 podlewania dziś: ', el('b', {}, Math.max(0, (L.water_per_day || 3) - (mine.water_used || 0)) + '/' + (L.water_per_day || 3))),
      el('span', { className: 'fw-chip' }, '🥷 podbierania dziś: ', el('b', {}, Math.max(0, (L.steal_per_day || 5) - (mine.steal_used || 0)) + '/' + (L.steal_per_day || 5))),
      el('span', { className: 'fw-chip' }, '🤝 podlałeś łącznie: ', el('b', {}, String(mine.waterings_given || 0)))),
    el('div', { className: 'fw-nb-row' },
      el('span', { className: 'fw-nb-muted' }, talentShield
        ? 'Twoich pól pilnuje talent NFT — nikt nic nie podbierze.'
        : until ? 'Strach na wróble pilnuje twoich pól do ' + until.toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }) + '.'
        : 'Twoje dojrzałe plony są bez ochrony. Strach na wróble pilnuje wszystkich pól przez ' + (L.scarecrow_days || 7) + ' dni.'),
      talentShield ? '' : scBtn)));

  const cols = el('div', { className: 'fw-nb-cols' });

  // ── Combos ──
  const myCrops = new Set();
  const mySpecies = new Set();
  fmTiles.forEach(t => {
    if (t.owner_id !== me?.id || !t.planted_species) return;
    mySpecies.add(t.planted_species);
    const d = fmDefs.get(t.planted_species); if (d?.crop_type) myCrops.add(d.crop_type);
  });
  const pairList = el('ul', { className: 'fw-nb-list' });
  (fwNb.pairs || []).forEach(p => {
    const on = myCrops.has(p.a) && myCrops.has(p.b);
    const A = farmCropIdentity(p.a), B = farmCropIdentity(p.b);
    pairList.append(el('li', { className: on ? 'mine' : '' },
      (on ? '✅ ' : '') + A.emoji + ' + ' + B.emoji + ' ' + p.name,
      el('span', { className: 't' }, '+' + Math.round(p.bonus * 100) + '% dla obu')));
  });
  const divPlus = Math.max(0, ...(mine.talents || []).filter(t => t.kind === 'diversity_plus').map(t => +t.value));
  const dv = L.diversity || [0.05, 0.10, 0.15];
  cols.append(el('div', { className: 'fw-nb-box' },
    el('div', { className: 'fw-nb-head' }, '🌱 Pary i różnorodność'),
    el('div', { className: 'fw-nb-muted' }, 'Para działa, gdy obie rośliny rosną na TWOICH polach w chwili zbioru. Różnorodność: 3 / 4 / 5+ gatunków naraz = +'
      + dv.map(v => Math.round(v * 100)).join(' / +') + '%. Teraz uprawiasz: ',
      el('b', {}, mySpecies.size + (divPlus ? ' (+' + divPlus + ' z talentu)' : '')), '.'),
    pairList));

  // ── Talents ──
  // Your own NFTs first (active ✅, then owned-but-idle 💤 — the whole point is
  // to get those planted); everyone else's talents fold into a <details>.
  const active = new Set((mine.talents || []).map(t => t.species));
  const owned = new Set((typeof fmNft !== 'undefined' ? fmNft : []).filter(n => n.owner_id === me?.id).map(n => n.species));
  const talentLi = t => {
    const def = fmDefs.get(t.species);
    const mark = active.has(t.species) ? '✅ ' : owned.has(t.species) ? '💤 ' : '';
    return el('li', { className: active.has(t.species) ? 'mine' : '' },
      mark + (def?.emoji || '💎') + ' ' + (def?.name || t.species) + ': ' + t.label.replace(/^[^:]+:\s*/, ''));
  };
  const all = (fwNb.talents || []).slice();
  const minePart = all.filter(t => active.has(t.species) || owned.has(t.species))
    .sort((a, b) => active.has(b.species) - active.has(a.species));
  const rest = all.filter(t => !active.has(t.species) && !owned.has(t.species));
  const tl = el('ul', { className: 'fw-nb-list' });
  minePart.forEach(t => tl.append(talentLi(t)));
  const idle = minePart.filter(t => !active.has(t.species)).length;
  const talentBox = el('div', { className: 'fw-nb-box' },
    el('div', { className: 'fw-nb-head' }, '💎 Talenty NFT'),
    el('div', { className: 'fw-nb-muted' }, 'Działają, dopóki NFT jest ZASADZONE na twoim polu. Te same talenty się nie sumują. Nowe kolekcje bez własnego talentu dają +'
      + Math.round((L.default_talent || 0.03) * 100) + '% na wszystkie pola.'
      + (idle ? ' 💤 = masz, ale nie zasadziłeś — talent śpi.' : '')),
    minePart.length ? tl : el('div', { className: 'fw-nb-muted' }, 'Nie masz jeszcze żadnej karty NFT.'));
  if (rest.length) {
    const ul = el('ul', { className: 'fw-nb-list' });
    rest.forEach(t => ul.append(talentLi(t)));
    talentBox.append(el('details', {}, el('summary', { className: 'fw-nb-muted' }, 'Talenty pozostałych NFT (' + rest.length + ')'), ul));
  }
  cols.append(talentBox);
  wrap.append(cols);

  // ── Feed ──
  const feed = el('ul', { className: 'fw-nb-list' });
  (fwNb.feed || []).slice(0, 25).forEach(e => {
    const crop = e.crop_type ? farmCropIdentity(e.crop_type) : null;
    const def = e.species ? fmDefs.get(e.species) : null;
    feed.append(el('li', { className: e.mine ? 'mine' : '' },
      e.kind === 'steal'
        ? '🥷 ' + e.actor + ' podebrał ' + e.qty + ' ' + (crop?.emoji || '') + ' graczowi ' + e.owner
        : '💧 ' + e.actor + ' podlał ' + (def?.emoji || '🌱') + ' gracza ' + e.owner,
      el('span', { className: 't' }, fwAgo(e.at))));
  });
  wrap.append(el('div', { className: 'fw-nb-box' },
    el('div', { className: 'fw-nb-head' }, '📰 Wydarzenia na polu'),
    (fwNb.feed || []).length ? feed : el('div', { className: 'fw-nb-muted' }, 'Jeszcze nic się nie wydarzyło. Kliknij rosnącą roślinę sąsiada, żeby ją podlać.')));

  bodyEl.replaceChildren(wrap);
}
