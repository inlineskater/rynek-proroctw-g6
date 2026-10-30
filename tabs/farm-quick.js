// ════════════════════════════════════════════════════════════════════════════
//  Ogródek quick actions — lazy module (TAB_MODULES.farmquick)
// ════════════════════════════════════════════════════════════════════════════
//  One row of buttons in the sky band for the daily loop, so a visit is a few
//  clicks instead of forty: 🧺 harvest everything ripe, 📋 fill every order the
//  barn covers, 💰 sell, 💧 water (own zen plants + neighbours), 🌱 plant every
//  free plot, and ⚡ all of it in that order.
//
//  Nothing here is new server logic: every step calls the SAME RPCs the single
//  buttons do (plantCrop/harvestCrop in index.html, fill_farm_order,
//  sell_crop_to_npc, farm_water_tile, gardenWater), one at a time, so every
//  server rule (fair share, Lvl-1 card caps, water limits, the zen arm-nonce
//  gate) still applies and a failure stops the run where it happened.
//
//  index.html keeps only the TAB_MODULES entry, one withTabModule() call in
//  renderFarmPanels() and the farmQuickSync() stub the 1s tick calls.

(function farmQuickInjectCss() {
  if (document.getElementById('farm-quick-css')) return;
  const s = document.createElement('style');
  s.id = 'farm-quick-css';
  s.textContent = `
    .fq-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
    .fq-bar.hidden { display: none; }
    .fq-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 999px;
      border: 1px solid rgba(255,255,255,.55); background: rgba(255,255,255,.82); color: #334155;
      font-size: 12.5px; font-weight: 700; cursor: pointer; white-space: nowrap;
      box-shadow: 0 1px 3px rgba(15,23,42,.12); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
    .fq-btn:hover:not(:disabled) { background: #fff; }
    .fq-btn:disabled { opacity: .55; cursor: default; }
    .fq-btn .fq-n { min-width: 17px; padding: 0 5px; border-radius: 999px; background: #16a34a; color: #fff;
      font-size: 11px; line-height: 17px; text-align: center; font-variant-numeric: tabular-nums; }
    .fq-btn .fq-n:empty { display: none; }
    .fq-btn.fq-all { background: #0f172a; border-color: #0f172a; color: #fff; }
    .fq-btn.fq-all:hover:not(:disabled) { background: #1e293b; }
    .fq-status { padding: 6px 12px; border-radius: 999px; background: rgba(15,23,42,.55); color: #fff; font-size: 12px; font-weight: 600; }
    .fq-status:empty { display: none; }
    @media (max-width: 600px) {
      .fq-bar { flex: 1 1 100%; }
      .fq-btn { padding: 6px 9px; }
      .fq-btn .fq-txt { display: none; }
    }
    .fq-dlg { display: flex; flex-direction: column; gap: 10px; color: var(--text); }
    .fq-lead { font-size: 12.5px; line-height: 1.5; color: var(--muted); margin: 0; }
    .fq-mode { display: flex; gap: 6px; flex-wrap: wrap; }
    .fq-mode button { flex: 1 1 0; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text); font-size: 12.5px; font-weight: 700; cursor: pointer; }
    .fq-mode button.on { background: #0f172a; border-color: #0f172a; color: #fff; }
    .fq-rows { display: flex; flex-direction: column; gap: 4px; }
    .fq-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px;
      font-size: 13px; padding: 6px 8px; border-radius: 8px; background: var(--surface); }
    .fq-row-ico { font-size: 18px; line-height: 1; }
    .fq-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fq-row-sub { display: block; font-size: 11px; color: var(--muted); }
    .fq-row-num { font-weight: 800; font-variant-numeric: tabular-nums; text-align: right; }
    .fq-total { display: flex; justify-content: space-between; font-weight: 800; font-size: 14px; padding: 2px 8px; }
    .fq-check { display: flex; gap: 8px; align-items: flex-start; font-size: 12.5px; cursor: pointer; }
    .fq-check input { margin-top: 2px; }
    .fq-note { font-size: 11.5px; color: var(--muted); line-height: 1.45; }
    .fq-empty { padding: 10px; text-align: center; color: var(--muted); font-size: 12.5px; }
    .fq-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  `;
  document.head.appendChild(s);
})();

const FQ_MODE_KEY = 'rp_fq_plant_mode';   // 'profit' | 'orders', remembered per device
let fqBusy = false;
let fqRefs = null;   // { host, btns: { id: { btn, n } }, status }
let fqKey = '';

function fqPlantMode() {
  try { return localStorage.getItem(FQ_MODE_KEY) === 'orders' ? 'orders' : 'profit'; } catch (_e) { return 'profit'; }
}
function fqSetPlantMode(m) {
  try { localStorage.setItem(FQ_MODE_KEY, m); } catch (_e) { /* per-device convenience only */ }
}

function fqXY(key) { const [x, y] = key.split(',').map(Number); return { x, y }; }

// ── What there is to do ─────────────────────────────────────────────────────
function fqReadyKeys(now = Date.now()) {
  const out = [];
  fmTiles.forEach((t, k) => {
    if (t.owner_id !== me?.id || !t.planted_species || !t.ready_at || fmPendingTileActions.has(k)) return;
    if (new Date(t.ready_at).getTime() <= now) out.push(k);
  });
  return out;
}

// Same rule as farmFreeTileCount(): zen (migration) plots are not farm plots.
function fqFreeKeys() {
  const out = [];
  fmTiles.forEach((t, k) => {
    if (t.owner_id !== me?.id || t.planted_species || t.listed || t.acquired_via === 'migration' || fmPendingTileActions.has(k)) return;
    out.push(k);
  });
  // Reading order, so the board fills the way a person would plant it.
  return out.sort((a, b) => { const p = fqXY(a), q = fqXY(b); return p.y - q.y || p.x - q.x; });
}

function fqOpenOrders(now = Date.now()) {
  const orders = typeof fwOrders !== 'undefined' && fwOrders?.orders ? fwOrders.orders : [];
  return orders.filter(o => !o.mine && (o.lines || []).length && new Date(o.expires_at).getTime() > now);
}

// Orders the barn covers, best reward first, each one taken out of a local
// copy of the barn so two orders never count the same crops.
function fqOrderPlan(now = Date.now()) {
  const inv = new Map(fmInventory);
  const out = [];
  fqOpenOrders(now).sort((a, b) => Number(b.reward || 0) - Number(a.reward || 0)).forEach(o => {
    if (!o.lines.every(l => Number(inv.get(l.crop_type) || 0) >= Number(l.qty))) return;
    o.lines.forEach(l => inv.set(l.crop_type, Number(inv.get(l.crop_type) || 0) - Number(l.qty)));
    out.push(o);
  });
  return out;
}

// 💧 My zen plants that can be watered now, plus neighbours' growing plots up
// to today's allowance — fewest waterings first, then the soonest to ripen, so
// the +3% lands on plots that have not had it yet.
function fqWaterPlan(now = Date.now()) {
  const zen = [...fmZen.values()].filter(g => g.user_id === me?.id && farmPlantSnapshot(g).canWater);
  const nb = [];
  if (typeof fwNb !== 'undefined' && fwNb) {
    const L = fwNb.limits || {};
    const left = (L.water_per_day || 3) - (fwNb.me?.water_used || 0);
    const cands = [];
    fmTiles.forEach((t, k) => {
      if (!t.owner_id || t.owner_id === me?.id || !t.planted_species || !t.ready_at) return;
      const ready = new Date(t.ready_at).getTime();
      if (ready <= now + 60000) return;
      const ev = fwNb.tileMap.get(k);
      if (ev?.watered_by_me || (ev?.waters || 0) >= (L.water_per_cycle || 3)) return;
      cands.push({ key: k, waters: ev?.waters || 0, ready });
    });
    cands.sort((a, b) => a.waters - b.waters || a.ready - b.ready);
    nb.push(...cands.slice(0, Math.max(0, left)));
  }
  return { zen, nb };
}

function fqInventoryUnits() {
  let n = 0;
  fmInventory.forEach(q => { if (q > 0) n += Number(q); });
  return n;
}

// 💰 How much of each crop to sell. Three rules, in order:
//  • lots rotting within 24 h are always sold — at any price they beat zero;
//  • with keepOrders, what the open orders ask for stays in the barn;
//  • unless `all`, stop where the 7-day fair share stops paying 100%
//    (farm-fair-share.sql) — past it the NPC pays 30% and then 5%, so the rest
//    is better given to the 🏛️ Spichlerz or kept for orders.
// Soonest-rotting crops are sold first, so they get the full-price room.
function fqSellPlan(opts) {
  const now = Date.now();
  const reserve = new Map();
  if (opts.keepOrders) {
    fqOpenOrders(now).forEach(o => o.lines.forEach(l =>
      reserve.set(l.crop_type, Number(reserve.get(l.crop_type) || 0) + Number(l.qty))));
  }
  const share = Number(fmFairness?.fair_share_7d || 0);
  const tiers = Array.isArray(fmFairness?.tiers) ? fmFairness.tiers : [];
  const fullTier = tiers.find(t => Number(t.rate) >= 1);
  const cap = share > 0 && fullTier && fullTier.upto_x != null ? Number(fullTier.upto_x) * share : Infinity;
  let used = Number(fmFairness?.used_7d || 0);

  const soon = now + 86400000;
  const rotting = new Map();
  fmInventoryLots.forEach(l => {
    if (l.expires_at && new Date(l.expires_at).getTime() < soon) rotting.set(l.crop_type, Number(rotting.get(l.crop_type) || 0) + Number(l.qty));
  });

  const rows = [];
  [...fmInventory.entries()]
    .filter(([crop, q]) => q > 0 && fmMarket.get(crop))
    .sort((a, b) => {
      // Plain string order: ISO dates sort chronologically, no date sorts last.
      const ea = String(fmInventoryExp.get(a[0]) || '\uffff'), eb = String(fmInventoryExp.get(b[0]) || '\uffff');
      return ea < eb ? -1 : ea > eb ? 1 : 0;
    })
    .forEach(([crop, have]) => {
      have = Number(have);
      const rot = Math.min(have, Number(rotting.get(crop) || 0));
      const keep = Math.min(have - rot, Number(reserve.get(crop) || 0));
      const avail = have - keep;
      let qty = avail;
      if (!opts.all && cap < Infinity) {
        // Market value grows with qty, so binary-search the most that still fits.
        const fits = q => used + Number(farmSellQuote(crop, q)?.fullProceeds || 0) <= cap;
        let lo = 0, hi = avail;
        while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
        qty = Math.max(lo, rot);
      }
      const q = qty > 0 ? farmSellQuote(crop, qty) : null;
      const full = Number(q?.fullProceeds || 0);
      const pay = q ? Math.round(farmFairSharePay(full, used)) + Number(q.eventBonus || 0) : 0;
      used += full;
      rows.push({ crop, have, qty, keep, rot, rest: avail - qty, pay, full });
    });
  return rows;
}

// ── 🌱 Planting plan ────────────────────────────────────────────────────────
// Every card/NFT I could put in the ground right now, with its full-cycle
// projection from the same ranking 🎒 Mój Majątek shows.
function fqPlantCandidates() {
  return farmOwnedPlantRanking('today')
    .filter(r => r.calc && (r.nft ? r.statusKind === 'free' : r.free > 0))
    .map(r => ({
      species: r.def.species, inst: r.inst?.id || null, crop: r.def.crop_type,
      name: r.name, emoji: r.inst ? farmNftEmoji(r.inst) : (r.def.emoji || '🌱'), level: r.level,
      left: r.nft ? 1 : r.free, yld: Number(r.calc.yld || 0), growMin: Number(r.calc.growMin || 1440),
      day: Number(r.calc.dayNow || 0),
    }));
}

// Daily coins of one more plot of `c` when `units` of its crop are already
// planned. Plots planted together ripen together and the 💰 button sells them
// as one batch, so the batch's price drop is real: the second plot of the same
// crop is worth less than the first. That is what spreads the plan over several
// crops (and the diversity bonus in farm_harvest_yield likes that too).
function fqMarginalDay(c, units) {
  const a = Number(units.get(c.crop) || 0);
  if (!a || !c.yld) return c.day;
  const q0 = farmSellQuote(c.crop, a), q1 = farmSellQuote(c.crop, a + c.yld), qs = farmSellQuote(c.crop, c.yld);
  if (!q0 || !q1 || !qs || !qs.fullProceeds) return c.day;
  return c.day * Math.max(0, q1.fullProceeds - q0.fullProceeds) / qs.fullProceeds;
}

// What the open orders still need after the barn and my growing plots.
function fqOrderNeeds(now) {
  const pool = new Map(fmInventory);
  fmTiles.forEach(t => {
    if (t.owner_id !== me?.id || !t.planted_species) return;
    const d = fmDefs.get(t.planted_species);
    const c = d && farmPlantIncomeCalc(d, t.planted_level || 1);
    if (c) pool.set(d.crop_type, Number(pool.get(d.crop_type) || 0) + c.yld);
  });
  const lines = [];
  fqOpenOrders(now).sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at)).forEach(o => {
    const units = o.lines.reduce((s, l) => s + Number(l.qty), 0) || 1;
    o.lines.forEach(l => {
      const have = Number(pool.get(l.crop_type) || 0);
      const use = Math.min(have, Number(l.qty));
      pool.set(l.crop_type, have - use);
      if (Number(l.qty) - use > 0) {
        lines.push({ crop: l.crop_type, need: Number(l.qty) - use, vpu: Number(o.reward || 0) / units, exp: new Date(o.expires_at).getTime() });
      }
    });
  });
  return lines;
}

// Greedy, one free plot at a time: in 'orders' mode the plant that covers the
// most order value it can still ripen in time; otherwise (and for plots no
// order needs) the best marginal coins/day.
function fqPlantPlan(mode, keys = fqFreeKeys()) {
  const now = Date.now();
  const cands = fqPlantCandidates();
  const units = new Map();
  const needs = mode === 'orders' ? fqOrderNeeds(now) : [];
  const plan = [];
  for (const key of keys) {
    let best = null, bestScore = -1, bestWhy = 'profit', bestTake = null;
    for (const c of cands) {
      if (c.left <= 0) continue;
      let gain = 0;
      const take = [];
      if (needs.length) {
        let left = c.yld;
        const ready = now + c.growMin * 60000 + 10 * 60000;
        needs.filter(n => n.crop === c.crop && n.need > 0 && n.exp > ready)
          .sort((a, b) => b.vpu - a.vpu)
          .forEach(n => { if (left <= 0) return; const u = Math.min(left, n.need); gain += u * n.vpu; left -= u; take.push([n, u]); });
      }
      const day = fqMarginalDay(c, units);
      // Order value dominates; coins/day only breaks ties and fills the rest.
      const score = gain > 0 ? 1e9 + gain + day / 1e3 : day;
      if (score > bestScore) { best = c; bestScore = score; bestWhy = gain > 0 ? 'orders' : 'profit'; bestTake = take; }
    }
    if (!best) break;
    best.left -= 1;
    units.set(best.crop, Number(units.get(best.crop) || 0) + best.yld);
    if (bestWhy === 'orders') bestTake.forEach(([n, u]) => { n.need -= u; });
    plan.push({ key, c: best, why: bestWhy, day: Math.round(best.day) });
  }
  return plan;
}

// ── Dialog ──────────────────────────────────────────────────────────────────
// A modal whose body can be re-rendered (mode toggles) and resolves true/false.
function fqDialog(title, render, okLabel) {
  return new Promise(resolve => {
    const body = el('div', { className: 'fq-dlg' });
    const ok = el('button', { className: 'btn-primary' }, okLabel);
    const cancel = el('button', { className: 'btn-ghost' }, 'Anuluj');
    const closeX = el('button', { className: 'btn-close', type: 'button', 'aria-label': 'Zamknij' }, '✕');
    const overlay = el('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' },
      el('div', { className: 'modal' },
        el('div', { className: 'modal-header' }, el('div', { className: 'modal-title' }, title), closeX),
        body, el('div', { className: 'fq-actions' }, cancel, ok)));
    const done = v => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    const rerender = () => {
      const r = render(rerender) || {};
      body.replaceChildren(...(r.nodes || []));
      ok.disabled = !!r.disabled;
      if (r.okLabel) ok.textContent = r.okLabel;
    };
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
    closeX.addEventListener('click', () => done(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);
    rerender();
    document.body.appendChild(overlay);
    ok.focus();
  });
}

function fqRow(ico, name, sub, num) {
  return el('div', { className: 'fq-row' },
    el('span', { className: 'fq-row-ico' }, typeof ico === 'string' ? farmIcon(ico) : ico),
    el('span', { className: 'fq-row-name', title: name }, name, sub ? el('span', { className: 'fq-row-sub' }, sub) : ''),
    el('span', { className: 'fq-row-num' }, num));
}

function fqModeToggle(options, current, onPick) {
  const box = el('div', { className: 'fq-mode', role: 'group' });
  options.forEach(([id, label]) => {
    const b = el('button', { type: 'button', className: id === current ? 'on' : '', 'aria-pressed': id === current ? 'true' : 'false' }, label);
    b.addEventListener('click', () => onPick(id));
    box.append(b);
  });
  return box;
}

function fqPlanSummary(plan) {
  const groups = new Map();
  plan.forEach(p => {
    const k = (p.c.inst || p.c.species) + '|' + p.why;
    const g = groups.get(k) || { c: p.c, why: p.why, n: 0, day: 0 };
    g.n++; g.day += p.day;
    groups.set(k, g);
  });
  return [...groups.values()];
}

function fqPlantNodes(plan, mode, setMode) {
  const nodes = [
    fqModeToggle([['profit', '💰 Najbardziej opłacalne'], ['orders', '📋 Pod zamówienia']], mode, setMode),
    el('p', { className: 'fq-lead' }, mode === 'orders'
      ? 'Najpierw rośliny, których brakuje do otwartych zamówień i które zdążą dojrzeć przed ich końcem. Wolne działki, których żadne zamówienie nie potrzebuje, dostają najbardziej opłacalną roślinę.'
      : 'Każda wolna działka dostaje roślinę, która da najwięcej 🪙 dziennie przy dzisiejszej cenie skupu. Kilka działek tej samej rośliny dojrzeje razem i obniży cenę, więc plan sam rozkłada się na kilka gatunków.'),
  ];
  if (!plan.length) {
    nodes.push(el('div', { className: 'fq-empty' }, fqFreeKeys().length
      ? 'Nie masz wolnej karty do zasadzenia — otwórz 📦 Skrzynki albo ulepsz kartę do poz. 2 (wtedy sadzi się bez limitu).'
      : 'Nie masz wolnej działki.'));
    return nodes;
  }
  const rows = el('div', { className: 'fq-rows' });
  let total = 0;
  fqPlanSummary(plan).forEach(g => {
    total += g.day;
    rows.append(fqRow(g.c.emoji, g.n + '× ' + g.c.name + (g.c.level > 1 ? ' · poz. ' + g.c.level : ''),
      (g.why === 'orders' ? '📋 pod zamówienie · ' : '') + farmGrowDaysLabel(g.c.growMin) + ' · ' + g.c.yld + ' szt./działkę',
      '≈ ' + fmtNum(g.day) + ' 🪙/d'));
  });
  nodes.push(rows, el('div', { className: 'fq-total' }, el('span', {}, plan.length + ' ' + plCount(plan.length, 'działka', 'działki', 'działek')), el('span', {}, '≈ ' + fmtNum(total) + ' 🪙/d')),
    el('div', { className: 'fq-note' }, 'Szacunek brutto z pełnego cyklu, jak w rankingu „Co najbardziej opłaca się sadzić" (bez spadku ceny między działkami).'));
  return nodes;
}

function fqSellNodes(rows, opts, rerender) {
  const nodes = [
    fqModeToggle([['full', '⚖️ Tylko po pełnej cenie'], ['all', '💰 Wszystko']], opts.all ? 'all' : 'full', id => { opts.all = id === 'all'; rerender(); }),
  ];
  const keep = el('input', { type: 'checkbox' }); keep.checked = opts.keepOrders;
  keep.addEventListener('change', () => { opts.keepOrders = keep.checked; rerender(); });
  nodes.push(el('label', { className: 'fq-check' }, keep, el('span', {}, '📋 Zostaw w magazynie to, czego chcą otwarte zamówienia')));

  const sell = rows.filter(r => r.qty > 0);
  if (!sell.length) {
    nodes.push(el('div', { className: 'fq-empty' }, rows.length
      ? 'Nic do sprzedania po pełnej cenie — uczciwy udział w skupie jest wykorzystany. Resztę oddaj do 🏛️ Spichlerza albo przełącz na „Wszystko".'
      : 'Magazyn jest pusty.'));
  } else {
    const list = el('div', { className: 'fq-rows' });
    let total = 0;
    sell.forEach(r => {
      total += r.pay;
      const id = farmCropIdentity(r.crop);
      const sub = [r.rot ? '⚠️ ' + r.rot + ' gnije w 24 h' : null, r.keep ? '📋 zostaje ' + r.keep : null,
                   r.rest ? '⚖️ ponad udział ' + r.rest : null].filter(Boolean).join(' · ');
      list.append(fqRow(id.emoji, r.qty + '× ' + id.name, sub, '≈ ' + fmtNum(r.pay) + ' 🪙'));
    });
    nodes.push(list, el('div', { className: 'fq-total' }, el('span', {}, 'Razem brutto'), el('span', {}, '≈ ' + fmtNum(total) + ' 🪙')));
  }
  const rest = rows.reduce((s, r) => s + r.rest, 0);
  if (rest > 0 && !opts.all) {
    const don = el('input', { type: 'checkbox' }); don.checked = opts.donate;
    don.addEventListener('change', () => { opts.donate = don.checked; rerender(); });
    nodes.push(el('label', { className: 'fq-check' }, don,
      el('span', {}, '🏛️ Oddaj resztę (' + rest + ' szt. ponad udział) do Spichlerza — pełna wartość liczy się do 🎪 Festynu dla całego biura, ale 🪙 za to nie ma.')));
  }
  nodes.push(el('div', { className: 'fq-note' }, 'Sprzedaje po kolei, od plonów, które zgniją najszybciej. Każda sprzedaż obniża cenę danego plonu, jak w zwykłym oknie sprzedaży.'));
  return { nodes, disabled: !sell.length && !(opts.donate && rest > 0) };
}

// ── Runners ─────────────────────────────────────────────────────────────────
function fqStatus(text) { if (fqRefs?.status) fqRefs.status.textContent = text || ''; }

async function fqRun(fn) {
  if (fqBusy || !me) return;
  fqBusy = true; fqKey = ''; farmQuickSync();
  try { await fn(); }
  catch (e) { console.error('farm quick action', e); showToast('❌ ' + fmErr(e)); }
  finally { fqBusy = false; fqStatus(''); fqKey = ''; farmQuickSync(); }
}

async function fqDoHarvest() {
  const keys = fqReadyKeys();
  let ok = 0;
  for (const k of keys) {
    fqStatus('🧺 Zbieram ' + (ok + 1) + '/' + keys.length + '…');
    const { x, y } = fqXY(k);
    if (!await harvestCrop(x, y)) break;
    ok++;
  }
  if (ok) await scheduleFarmInventoryReconcile();
  return ok;
}

async function fqDoOrders(orders) {
  let ok = 0, coins = 0;
  for (const o of orders) {
    fqStatus('📋 Realizuję ' + (ok + 1) + '/' + orders.length + '…');
    const { data, error } = await sb.rpc('fill_farm_order', { p_order_id: o.id });
    if (error) { showToast('❌ ' + o.customer + ': ' + fmErr(error)); break; }
    if (typeof data.coins === 'number') { me.coins = data.coins; setText(headerCoins, me.coins); }
    o.mine = true;
    coins += Number(data.reward || 0);
    ok++;
  }
  if (ok) {
    await reloadFarmInventory();
    fwOrdersAt = 0;
    await loadFarmOrders();
    invalidateFarmAssetBreakdown();
  }
  return { ok, coins };
}

async function fqDoSell(rows, donate) {
  let gross = 0, net = 0, sold = 0, given = 0;
  for (const r of rows.filter(x => x.qty > 0)) {
    fqStatus('💰 Sprzedaję ' + farmCropIdentity(r.crop).name + '…');
    const { data, error } = await sb.rpc('sell_crop_to_npc', { p_crop_type: r.crop, p_qty: r.qty });
    if (error) { showToast('❌ ' + fmErr(error)); break; }
    // Same bookkeeping as sellCrop() in index.html, without its per-sale reloads.
    if (typeof data.coins === 'number') { me.coins = data.coins; setText(headerCoins, me.coins); }
    const mkt = fmMarket.get(r.crop);
    if (mkt) { mkt.cur_price = +data.cur_price; mkt.last_decay_at = data.last_decay_at || new Date().toISOString(); }
    if (typeof data.land_tax_debt === 'number') fmTax = Object.assign({}, fmTax || {}, { debt: Number(data.land_tax_debt || 0) });
    if (fmFairness && data.fair_share_used != null) fmFairness.used_7d = Number(data.fair_share_used);
    const g = Number(data.proceeds || 0) + Number(data.event_bonus || 0);
    gross += g;
    net += Number(data.net ?? data.proceeds ?? 0) + Number(data.event_net ?? data.event_bonus ?? 0);
    sold += Number(data.sold || r.qty);
  }
  if (donate) {
    for (const r of rows.filter(x => x.rest > 0)) {
      fqStatus('🏛️ Oddaję ' + farmCropIdentity(r.crop).name + '…');
      const { data, error } = await sb.rpc('donate_crops_to_granary', { p_crop_type: r.crop, p_qty: r.rest });
      if (error) { showToast('❌ Spichlerz: ' + fmErr(error)); break; }
      given += Number(data?.donated_qty || r.rest);
    }
  }
  if (sold || given) {
    await refreshFarmTaxQuote();
    await reloadFarmInventory();
    if (given && typeof fwGranaryRefresh === 'function') await fwGranaryRefresh();
    await invalidateFarmAssetBreakdown({ reload: true });
    renderFarmMarket();
    if (farmModalEl) refreshFarmHub();
  }
  return { sold, gross, net, given };
}

async function fqDoWater(plan) {
  let zen = 0, zenCoins = 0, nb = 0;
  for (const g of plan.zen) {
    fqStatus('💧 Podlewam ogród zen…');
    const { data, error } = await gardenWater(g.slot_index || 1);
    if (error) { showToast('❌ ' + gardenErr(error)); break; }
    if (typeof data.coins_earned === 'number') { me.coins += data.coins_earned; setText(headerCoins, me.coins); zenCoins += data.coins_earned; }
    zen++;
  }
  for (const n of plan.nb) {
    fqStatus('💧 Podlewam sąsiadów ' + (nb + 1) + '/' + plan.nb.length + '…');
    const { x, y } = fqXY(n.key);
    const { error } = await sb.rpc('farm_water_tile', { p_x: x, p_y: y });
    if (error) { showToast('❌ ' + fmErr(error)); break; }
    fwFxAt(x, y, 'water');
    nb++;
  }
  if (nb) await fwNbRefresh(true);
  if (zen) await loadFarm();
  return { zen, zenCoins, nb };
}

async function fqDoPlant(plan) {
  let ok = 0;
  for (const p of plan) {
    fqStatus('🌱 Sadzę ' + (ok + 1) + '/' + plan.length + '…');
    const { x, y } = fqXY(p.key);
    if (!await plantCrop(x, y, p.c.species, p.c.inst)) break;
    ok++;
  }
  return ok;
}

// ── Button handlers ─────────────────────────────────────────────────────────
function fqHarvestClick() {
  fqRun(async () => {
    const n = await fqDoHarvest();
    if (n) showToast('🧺 Zebrano z ' + n + ' ' + plCount(n, 'działki', 'działek', 'działek') + ' — plony są w magazynie.');
  });
}

function fqOrdersClick() {
  fqRun(async () => {
    const orders = fqOrderPlan();
    if (!orders.length) return;
    const total = orders.reduce((s, o) => s + Number(o.reward || 0), 0);
    const yes = await fqDialog('📋 Zrealizuj zamówienia', () => ({ nodes: [
      el('p', { className: 'fq-lead' }, 'Te zamówienia pokryjesz z magazynu (najlepiej płatne najpierw, żadne nie zabierze plonów innemu):'),
      el('div', { className: 'fq-rows' }, ...orders.map(o => fqRow(o.emoji || '🧺', o.customer,
        o.lines.map(l => l.qty + ' ' + farmCropIdentity(l.crop_type).emoji).join(' + '), fmtNum(o.reward) + ' 🪙'))),
      el('div', { className: 'fq-total' }, el('span', {}, 'Razem'), el('span', {}, fmtNum(total) + ' 🪙')),
    ] }), 'Realizuj ' + orders.length);
    if (!yes) return;
    const r = await fqDoOrders(orders);
    if (r.ok) showToast('📋 Zrealizowano ' + r.ok + ' ' + plCount(r.ok, 'zamówienie', 'zamówienia', 'zamówień') + ': +' + fmtNum(r.coins) + ' 🪙');
  });
}

function fqSellClick() {
  fqRun(async () => {
    const opts = { all: false, keepOrders: true, donate: false };
    let rows = [];
    const yes = await fqDialog('💰 Sprzedaj plony', rerender => {
      rows = fqSellPlan(opts);
      return fqSellNodes(rows, opts, rerender);
    }, 'Sprzedaj');
    if (!yes) return;
    const r = await fqDoSell(rows, opts.donate);
    if (r.sold || r.given) {
      showToast('💰 ' + (r.sold ? 'Sprzedano ' + r.sold + ' szt. · brutto ' + fmtNum(r.gross) + ' 🪙'
        + (r.net < r.gross ? ' · do portfela ' + fmtNum(r.net) + ' 🪙' : '') : '')
        + (r.given ? (r.sold ? ' · ' : '') + '🏛️ ' + r.given + ' szt. do Spichlerza' : ''));
    }
  });
}

function fqWaterClick() {
  fqRun(async () => {
    const r = await fqDoWater(fqWaterPlan());
    const parts = [];
    if (r.zen) parts.push('ogród zen ' + r.zen + '× (+' + fmtNum(r.zenCoins) + ' 🪙)');
    if (r.nb) parts.push('sąsiedzi ' + r.nb + '×');
    if (parts.length) showToast('💧 Podlano: ' + parts.join(' · '));
  });
}

function fqPlantClick() {
  fqRun(async () => {
    let mode = fqPlantMode();
    // farm-world.js owns the orders; loadFarm() fetches it, this only covers a cold start.
    if (mode === 'orders' && typeof loadFarmOrders === 'function' && !fwOrders) await loadFarmOrders();
    let plan = [];
    const yes = await fqDialog('🌱 Posadź na wolnych działkach', rerender => {
      plan = fqPlantPlan(mode);
      return { nodes: fqPlantNodes(plan, mode, m => { mode = m; fqSetPlantMode(m); rerender(); }),
               disabled: !plan.length, okLabel: plan.length ? 'Posadź ' + plan.length : 'Posadź' };
    }, 'Posadź');
    if (!yes || !plan.length) return;
    const n = await fqDoPlant(plan);
    if (n) showToast('🌱 Zasadzono ' + n + ' ' + plCount(n, 'działkę', 'działki', 'działek') + '.');
  });
}

// ⚡ The whole visit: harvest → orders → sell (full price only, keeping what
// orders want) → water → plant in the remembered mode. Each step is planned
// from fresh data after the previous one, and stops on the first error.
function fqAllClick() {
  fqRun(async () => {
    const mode = fqPlantMode();
    const ready = fqReadyKeys().length;
    const yes = await fqDialog('⚡ Zrób wszystko', () => ({ nodes: [
      el('p', { className: 'fq-lead' }, 'Po kolei, jak przy zwykłej wizycie:'),
      el('div', { className: 'fq-rows' },
        fqRow('🧺', 'Zbierz dojrzałe', '', String(ready)),
        fqRow('📋', 'Zrealizuj zamówienia z magazynu', '', ''),
        fqRow('💰', 'Sprzedaj', 'tylko po pełnej cenie, zostawiając plony dla otwartych zamówień', ''),
        fqRow('💧', 'Podlej', 'swój ogród zen i rośliny sąsiadów', ''),
        fqRow('🌱', 'Posadź na wolnych działkach', mode === 'orders' ? '📋 pod zamówienia' : '💰 najbardziej opłacalne', String(fqFreeKeys().length + ready))),
      el('div', { className: 'fq-note' }, 'Sposób sadzenia zmienisz w oknie 🌱 Posadź — zapamiętuje ostatni wybór.'),
    ] }), '⚡ Start');
    if (!yes) return;
    const out = [];
    const h = await fqDoHarvest();
    if (h) out.push('🧺 ' + h);
    if (typeof loadFarmOrders === 'function') { fwOrdersAt = 0; await loadFarmOrders(); }
    const o = await fqDoOrders(fqOrderPlan());
    if (o.ok) out.push('📋 +' + fmtNum(o.coins) + ' 🪙');
    const s = await fqDoSell(fqSellPlan({ all: false, keepOrders: true }), false);
    if (s.sold) out.push('💰 +' + fmtNum(s.gross) + ' 🪙');
    const w = await fqDoWater(fqWaterPlan());
    if (w.zen || w.nb) out.push('💧 ' + (w.zen + w.nb));
    const p = await fqDoPlant(fqPlantPlan(mode));
    if (p) out.push('🌱 ' + p);
    showToast(out.length ? '⚡ Gotowe: ' + out.join(' · ') : '⚡ Nie było nic do zrobienia.');
  });
}

// ── Bar ─────────────────────────────────────────────────────────────────────
const FQ_BUTTONS = [
  ['harvest', '🧺', 'Zbierz',   'Zbierz wszystkie dojrzałe rośliny', fqHarvestClick],
  ['orders',  '📋', 'Realizuj', 'Zrealizuj wszystkie zamówienia, które pokryjesz z magazynu', fqOrdersClick],
  ['sell',    '💰', 'Sprzedaj', 'Sprzedaj plony z magazynu (z podglądem, bez przekraczania uczciwego udziału)', fqSellClick],
  ['water',   '💧', 'Podlej',   'Podlej swój ogród zen i rośliny sąsiadów (dzisiejszy limit)', fqWaterClick],
  ['plant',   '🌱', 'Posadź',   'Posadź na wszystkich wolnych działkach: najbardziej opłacalne albo pod zamówienia', fqPlantClick],
  ['all',     '⚡', 'Wszystko', 'Zbierz → zamówienia → sprzedaj → podlej → posadź, jednym kliknięciem', fqAllClick],
];

// index.html hook: renderFarmPanels(). The host sits right after the field HUD
// and survives the HUD's own re-renders.
function farmQuickRender() {
  const bar = document.querySelector('#tab-farm .farm-sky-bar');
  if (!bar) return;
  let host = document.getElementById('farm-sky-quick');
  if (!host) {
    host = el('div', { className: 'fq-bar', id: 'farm-sky-quick', role: 'toolbar', 'aria-label': 'Szybkie akcje Ogródka' });
    const btns = {};
    FQ_BUTTONS.forEach(([id, ico, txt, title, fn]) => {
      const n = el('span', { className: 'fq-n' });
      const btn = el('button', { className: 'fq-btn' + (id === 'all' ? ' fq-all' : ''), type: 'button', title },
        el('span', { 'aria-hidden': 'true' }, ico), el('span', { className: 'fq-txt' }, txt), n);
      btn.addEventListener('click', fn);
      btns[id] = { btn, n };
      host.append(btn);
    });
    const status = el('span', { className: 'fq-status', role: 'status' });
    host.append(status);
    fqRefs = { host, btns, status };
    const hud = document.getElementById('farm-sky-hud');
    if (hud) hud.after(host); else bar.prepend(host);
    if (typeof scaleFarmPots === 'function') requestAnimationFrame(() => scaleFarmPots());
  }
  fqKey = '';
  farmQuickSync();
}

// index.html hook: the 1s farm tick (updateFarmFieldSummary). Cheap counts only
// — the plans themselves are built when a button is pressed.
function farmQuickSync(now = Date.now()) {
  if (!fqRefs || !fqRefs.host.isConnected) return;
  const mine = me ? farmOwnedTileCount() : 0;
  const w = fqWaterPlan(now);
  const c = {
    harvest: fqReadyKeys(now).length,
    orders: fqOrderPlan(now).length,
    sell: fqInventoryUnits(),
    water: w.zen.length + w.nb.length,
    plant: fqFreeKeys().length,
  };
  c.all = c.harvest + c.orders + c.water + c.plant + (c.sell ? 1 : 0);
  const key = [fqBusy, mine > 0 || fmZen.size > 0, c.harvest, c.orders, c.sell, c.water, c.plant].join('|');
  if (key === fqKey) return;
  fqKey = key;
  fqRefs.host.classList.toggle('hidden', !me || (mine === 0 && ![...fmZen.values()].some(g => g.user_id === me.id)));
  Object.entries(fqRefs.btns).forEach(([id, r]) => {
    const n = c[id] || 0;
    r.btn.disabled = fqBusy || n === 0;
    r.n.textContent = id === 'all' || n === 0 ? '' : (id === 'sell' && n > 999 ? '999+' : String(n));
  });
}
