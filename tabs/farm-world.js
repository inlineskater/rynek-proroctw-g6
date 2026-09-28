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
