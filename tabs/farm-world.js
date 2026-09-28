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
    #fw-banner { display: flex; flex-direction: column; gap: 8px; width: 100%; box-sizing: border-box; margin: 0 0 10px;
      padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--card); color: var(--text); }
    #fw-banner.hidden { display: none; }
    .fw-wx-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0; }
    .fw-wx-ic { font-size: 26px; line-height: 1; flex: 0 0 auto; }
    .fw-wx-main { flex: 1 1 220px; min-width: 0; }
    .fw-wx-title { font-size: 13px; font-weight: 700; }
    .fw-wx-sub { font-size: 12px; color: var(--muted); line-height: 1.5; overflow-wrap: anywhere; }
    .fw-wx-sub b { color: var(--text); }
    .fw-wx-good { color: #16a34a; font-weight: 700; }
    .fw-wx-bad { color: #dc2626; font-weight: 700; }
    .fw-wx-btn { flex: 0 0 auto; font: inherit; font-size: 12px; font-weight: 600; color: var(--accent); background: none; border: 0; cursor: pointer; padding: 4px 0; }
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
  return fwWeatherMultWindow(def.crop_type, from, to);
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
    sub.append('Teraz rośnie lepiej: ');
    good.forEach(([ct, m]) => sub.append(fwWxCropChip(ct, m), ' '));
  }
  if (bad.length) {
    if (good.length) sub.append(' · ');
    sub.append('gorzej: ');
    bad.forEach(([ct, m]) => sub.append(fwWxCropChip(ct, m), ' '));
  }
  if (!good.length && !bad.length) sub.append('Ta pogoda nie sprzyja ani nie szkodzi żadnej uprawie.');

  const btn = el('button', { className: 'fw-wx-btn', type: 'button' }, fwWxOpen ? 'Zwiń ▴' : 'Jak pogoda działa ▾');
  btn.addEventListener('click', () => { fwWxOpen = !fwWxOpen; fwRenderWeatherBanner(); });

  const temp = cur.temp_c != null ? ', ' + Math.round(cur.temp_c) + '°C' : '';
  host.replaceChildren(
    el('div', { className: 'fw-wx-row' },
      el('span', { className: 'fw-wx-ic' }, lab.ic),
      el('div', { className: 'fw-wx-main' },
        el('div', { className: 'fw-wx-title' }, 'Pogoda we Wrocławiu: ' + lab.name + temp),
        sub),
      btn),
    fwWxStrip());
  if (fwWxOpen) host.append(fwWxDetails(crops));
}

// Next 48 h in 6-hour blocks, each shown as its most common condition.
function fwWxStrip() {
  const H = 3600000, now = Date.now();
  const strip = el('div', { className: 'fw-wx-strip' });
  const start = Math.floor(now / (6 * H)) * 6 * H;
  for (let i = 0; i < 8; i++) {
    const a = start + i * 6 * H, b = a + 6 * H;
    const hs = fwWx.hours.filter(h => h.ms >= a && h.ms < b);
    if (!hs.length) continue;
    const counts = {};
    hs.forEach(h => { counts[h.c] = (counts[h.c] || 0) + 1; });
    const cat = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0];
    const temps = hs.map(h => Number(h.t)).filter(Number.isFinite);
    const d = new Date(a);
    const label = i === 0 ? 'teraz' : String(d.getHours()).padStart(2, '0') + ':00';
    strip.append(el('div', { className: 'fw-wx-cell' + (i === 0 ? ' now' : ''), title: (FW_WX_LABELS[cat] || {}).name || cat },
      el('b', {}, (FW_WX_LABELS[cat] || FW_WX_LABELS.cloudy).ic),
      temps.length ? Math.round(Math.max(...temps)) + '°' : '',
      el('span', {}, label)));
  }
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
