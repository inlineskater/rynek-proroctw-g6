// ════════════════════════════════════════════════════════════════════════════
//  Ogródek NFT layer — lazy module (TAB_MODULES.farmnft)
// ════════════════════════════════════════════════════════════════════════════
//  • card frames per collection (Klasyka / Lato 2026 / Jesień 2026 / Hybrydy /
//    „Złota Kolekcja PRL"), a foil sheen on every NFT, a talent chip;
//  • 🗓️ Kalendarz kolekcji — one NFT edition a month since 2026-11, read from
//    the farm_nft_monthly_schedule view (supabase/farm-nft-monthly.sql);
//  • 🔀 merge, 🧬 breeding lab and the edition explorer (moved out of
//    index.html for the payload budget — it keeps three loader stubs).
//
//  Fetched when the Ogródek opens; until then NFT tiles keep index.html's plain
//  amber frame, so nothing depends on this file having loaded. Design and the
//  supply math: docs/farma.md.
'use strict';

const FNFT_LOADED = true;

(function farmNftInjectCss() {
  if (document.getElementById('farm-nft-css')) return;
  const s = document.createElement('style');
  s.id = 'farm-nft-css';
  s.textContent = `
    /* ── Frames per collection (the .fcc frame is the 3px gradient padding) ── */
    .fcc.nft.col-classic  { background: linear-gradient(160deg, #f8fafc, #94a3b8 40%, #e2e8f0 58%, #475569);
      box-shadow: 0 0 14px rgba(148,163,184,.55), 0 4px 12px rgba(0,0,0,.25); }
    .fcc.nft.col-summer26 { background: linear-gradient(160deg, #fef08a, #f59e0b 45%, #fde68a 60%, #b45309); }
    .fcc.nft.col-autumn26 { background: linear-gradient(160deg, #fed7aa, #c2410c 45%, #fdba74 60%, #7c2d12);
      box-shadow: 0 0 14px rgba(194,65,12,.45), 0 4px 12px rgba(0,0,0,.25); }
    .fcc.nft.col-prl      { background: linear-gradient(160deg, #fecaca, #b91c1c 38%, #fff7ed 52%, #b91c1c 66%, #7f1d1d);
      box-shadow: 0 0 14px rgba(185,28,28,.4), 0 4px 12px rgba(0,0,0,.25); }
    /* „Złota Kolekcja PRL": ration-card paper, typewriter serial, red stamp */
    .fcc.nft.col-prl .fcc-inner { background:
        repeating-linear-gradient(0deg, transparent 0 13px, rgba(120,90,40,.07) 13px 14px),
        linear-gradient(180deg, #fffaf0, #f6ead0); }
    .fcc.nft.col-prl .fcc-art { background: rgba(255,255,255,.55); box-shadow: inset 0 0 0 1px rgba(185,28,28,.18); }
    .fcc.nft.col-prl .fcc-nft-serial { font-family: 'Courier New', Courier, monospace; font-size: 9px; color: #991b1b; white-space: nowrap; }
    /* Edition names run long („Kukurydza z Pochodu Pierwszomajowego"): one line, full name in the tooltip. */
    .fcc.nft .fcc-rar { max-width: 100%; box-sizing: border-box; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fcc.nft.col-prl .fcc-rar { background: rgba(185,28,28,.12); color: #991b1b; }
    .fcc.nft.col-prl .fcc-pin { color: #fff; background: #b91c1c; border-radius: 50%; width: 17px; height: 17px; padding: 0;
      display: flex; align-items: center; justify-content: center; font: 900 11px/1 Georgia, 'Times New Roman', serif; }
    .fcc.nft.col-classic .fcc-rar { background: rgba(71,85,105,.14); color: #334155; }
    .fcc.nft.col-autumn26 .fcc-rar { background: rgba(194,65,12,.12); color: #9a3412; }

    /* Foil sheen on every NFT: background-position only (no transform), so it
       can never disturb a 3D flip context the tile might sit in. */
    .fcc.nft .fcc-inner::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
      background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,.55) 47%, rgba(255,255,255,0) 58%) no-repeat;
      background-size: 250% 100%; background-position: 160% 0; animation: fnftFoil 6s ease-in-out infinite; z-index: 2; }
    .fcc.nft.col-prl .fcc-inner::after { background-image: linear-gradient(115deg, transparent 35%, rgba(255,236,200,.7) 47%, transparent 58%); }
    @keyframes fnftFoil { 0%, 55% { background-position: 160% 0; } 85%, 100% { background-position: -60% 0; } }
    .fnft-talent { position: absolute; z-index: 3; top: 34px; right: 7px; width: 19px; height: 19px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; font-size: 11px; line-height: 1;
      background: rgba(255,255,255,.92); box-shadow: 0 1px 3px rgba(0,0,0,.25); cursor: help; }

    /* Pack reveal: per-collection face, static (the face sits in a 3D flip). */
    .farm-pack-card.nft.col-classic  .farm-pack-front { border-color: #64748b; background: linear-gradient(160deg, #f8fafc, #e2e8f0); }
    .farm-pack-card.nft.col-autumn26 .farm-pack-front { border-color: #c2410c; background: linear-gradient(160deg, #fff7ed, #fed7aa); }
    .farm-pack-card.nft.col-prl      .farm-pack-front { border-color: #b91c1c; background:
        repeating-linear-gradient(0deg, transparent 0 15px, rgba(120,90,40,.08) 15px 16px), linear-gradient(160deg, #fffaf0, #f6ead0); }
    .farm-pack-card.nft.col-prl .farm-pack-serial { font-family: 'Courier New', Courier, monospace; color: #991b1b; }

    /* Board: an NFT plot's level badge is gold, so a 🍍 NFT reads differently from a 🍍 card. */
    .farm-cell-lvl.nft { background: linear-gradient(160deg, #fde68a, #b45309); color: #3b2405; }

    /* Merge / breeding: twemoji instead of raw emoji */
    .bl-art .farm-ico, .bcr-emoji .farm-ico, .fnft-merge-row .farm-ico { width: 1em; height: 1em; vertical-align: -0.12em; }

    /* ── 🗓️ Kalendarz kolekcji ── */
    .fnft-cal-lead { font-size: 12.5px; line-height: 1.55; color: var(--muted); margin: 0 0 10px; }
    .fnft-cal-lead b { color: var(--text); }
    .fnft-cal { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .fnft-cal-card { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center;
      padding: 10px 8px 9px; border-radius: 12px; border: 2px solid #e7cfa0; min-width: 0;
      background: repeating-linear-gradient(0deg, transparent 0 13px, rgba(120,90,40,.06) 13px 14px), linear-gradient(180deg, #fffaf0, #f6ead0); color: #3b2405; }
    .fnft-cal-card.is-live { border-color: #b91c1c; box-shadow: 0 0 0 3px rgba(185,28,28,.14), 0 6px 16px rgba(0,0,0,.14); }
    .fnft-cal-card.is-upcoming { filter: grayscale(.75); opacity: .72; }
    .fnft-cal-card.is-closed { border-style: dashed; }
    .fnft-cal-month { font: 800 10px/1.2 'Courier New', Courier, monospace; text-transform: uppercase; letter-spacing: .06em; color: #991b1b; }
    .fnft-cal-occ { font-size: 10.5px; font-weight: 700; color: #7a5a1a; }
    .fnft-cal-art .farm-ico { width: 44px; height: 44px; filter: drop-shadow(0 2px 4px rgba(0,0,0,.2)); }
    .fnft-cal-art .farm-ico-emoji { font-size: 38px; }
    .fnft-cal-name { font-size: 12px; font-weight: 850; line-height: 1.15; min-height: 2.3em; display: flex; align-items: center; }
    .fnft-cal-tag { font-size: 10.5px; font-weight: 800; padding: 2px 7px; border-radius: 99px; background: rgba(0,0,0,.06); }
    .fnft-cal-card.is-live .fnft-cal-tag { background: #b91c1c; color: #fff; }
    .fnft-cal-meta { font-size: 10.5px; color: #6b5a3a; line-height: 1.35; }
    .fnft-cal-talent { font-size: 10px; color: #7a5a1a; font-style: italic; line-height: 1.3; }
    .fnft-cal-q { position: absolute; top: 6px; right: 6px; width: 18px; height: 18px; border-radius: 50%; background: #b91c1c; color: #fff;
      font: 900 11px/18px Georgia, 'Times New Roman', serif; text-align: center; }

    @media (prefers-reduced-motion: reduce) {
      .fcc.nft .fcc-inner::after { animation: none; background: none; }
    }
  `;
  document.head.append(s);
})();

// Cosmetic: the occasion each monthly edition celebrates (names + months come
// from the server; this only adds the little holiday line on the calendar).
const FNFT_OCCASIONS = {
  prl_pumpkin: '🔮 Andrzejki', prl_pineapple: '🎄 Wigilia', prl_carrot: '⛄ Zima i kulig',
  prl_chili: '💘 Walentynki', prl_potato: '🌷 Dzień Kobiet', prl_tomato: '💦 Śmigus-dyngus',
  prl_corn: '🚩 Pochód 1-Majowy', prl_strawberry: '🎓 Koniec roku szkolnego', prl_grapes: '🏖️ Wczasy pod Gruszą',
};
const FNFT_BURN_LABEL = { merge_fuel: '🔥 spalona (fuzja)', breed_parent: '🧬 skrzyżowana', altar: '🕯️ na ołtarzu' };
const FNFT_TALENT_ICON = {
  crop_boost: '🌾', all_boost: '✨', scarecrow: '🛡️', water_double: '💧', diversity_plus: '🌈', weather_shield: '☂️',
};
let fnftTalents = null;        // species → farm_nft_talents row
let fnftLoadedAt = 0;
let fnftLoading = null;

// Calendar + talents, at most every 10 minutes. The first load re-renders the
// open hub so tiles drawn before this module arrived pick up their frames.
function fnftRefresh(force) {
  if (fnftLoading) return fnftLoading;
  if (!force && fmMonthly && Date.now() - fnftLoadedAt < 600000) return Promise.resolve();
  const first = fmMonthly === null;
  fnftLoading = Promise.all([
    sb.from('farm_nft_monthly_schedule').select('*'),
    sb.from('farm_nft_talents').select('species,kind,crop_type,value,label'),
    fnftLoadSocial(),
  ]).then(([cal, tal]) => {
    fmMonthly = cal.error ? (fmMonthly || []) : (cal.data || []);
    if (!tal.error) fnftTalents = new Map((tal.data || []).map(t => [t.species, t]));
    fnftLoadedAt = Date.now();
    if (first && typeof farmModalEl !== 'undefined' && farmModalEl) refreshFarmHub();
  }).catch(e => console.error('farm nft calendar', e))
    .finally(() => { fnftLoading = null; });
  return fnftLoading;
}

// Overrides the index.html stub: collection extras on a serialized NFT tile.
function farmNftDecorateTile(tile, n, def) {
  if (def?.nft_collection === 'prl') {
    const pin = tile.querySelector('.fcc-pin');
    if (pin) { pin.textContent = 'Q'; pin.title = 'Znak jakości — Złota Kolekcja PRL'; }
  }
  const rarEl = tile.querySelector('.fcc-rar');
  if (rarEl && def?.name) rarEl.title = def.name;
  const t = fnftTalents?.get(n.species);
  if (t) tile.append(el('span', { className: 'fnft-talent', title: 'Talent (gdy zasadzona): ' + t.label },
    FNFT_TALENT_ICON[t.kind] || '✨'));
  if (fnftRibbons.has(n.id)) tile.append(el('span', { className: 'fnft-ribbon', title: 'Zwyciężczyni Wystawy' }, '🏆'));
}

function fnftMonthTitle(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  if (isNaN(d)) return String(iso);
  const m = d.toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' });
  return m.charAt(0).toUpperCase() + m.slice(1);
}

// 🗓️ Kalendarz kolekcji — fills `host` (the Katalog section block).
async function fnftCalendarInto(host) {
  if (!host) return;
  const body = el('div', {});
  host.append(body);
  if (fmMonthly === null) {
    body.append(el('div', { className: 'farm-card-sub' }, 'Ładowanie…'));
    await fnftRefresh(true);
    body.replaceChildren();
  }
  body.append(el('p', { className: 'fnft-cal-lead' },
    'Co miesiąc, 1. dnia o północy, startuje ', el('b', {}, 'JEDNA'), ' nowa limitowana kolekcja NFT — ',
    el('b', {}, '„Złota Kolekcja PRL"'), '. Nakład 50 sztuk, ale wypada ze skrzynek ', el('b', {}, 'tylko w swoim miesiącu'),
    ' — potem edycja zamyka się na zawsze, a niewybite numery przepadają. Każda karta to ',
    'odpicowana wersja zwykłej rośliny: rośnie ten sam plon, ale 6× obficiej, ma własny talent i imię z epoki.'));
  const rows = (fmMonthly || []).slice().sort((a, b) => String(a.series_month).localeCompare(String(b.series_month)));
  if (!rows.length) {
    body.append(el('div', { className: 'farm-card-sub' }, 'Kalendarz jest chwilowo niedostępny.'));
    return;
  }
  const grid = el('div', { className: 'fnft-cal' });
  rows.forEach(r => {
    const card = el('div', { className: 'fnft-cal-card is-' + r.status });
    let tag;
    if (r.status === 'live') tag = '🟢 W skrzynkach · ' + r.minted_count + '/' + r.edition_size;
    else if (r.status === 'closed') tag = '📕 Zamknięta · wybito ' + r.minted_count + '/' + r.edition_size;
    else tag = '🔒 od ' + farmMonthStartLabel(r.series_month);
    const crop = fmDefs.get(r.crop_type) || [...fmDefs.values()].find(d => d.crop_type === r.crop_type && d.edition_size == null);
    card.append(
      el('span', { className: 'fnft-cal-q', title: 'Znak jakości' }, 'Q'),
      el('div', { className: 'fnft-cal-month' }, fnftMonthTitle(r.series_month)),
      el('div', { className: 'fnft-cal-occ' }, FNFT_OCCASIONS[r.species] || ''),
      el('div', { className: 'fnft-cal-art' }, farmIcon(r.emoji || '💎')),
      el('div', { className: 'fnft-cal-name' }, r.name),
      el('div', { className: 'fnft-cal-tag' }, tag),
      el('div', { className: 'fnft-cal-meta' },
        'Plon: ' + (crop ? crop.emoji + ' ' + crop.name : r.crop_type) + ' · ' + r.base_yield + ' szt. / ' + farmGrowLabel(r.base_grow_minutes)),
      r.talent_label ? el('div', { className: 'fnft-cal-talent' }, r.talent_label) : '');
    if (r.status !== 'upcoming' && fmDefs.has(r.species)) {
      card.style.cursor = 'pointer';
      card.title = 'Zobacz wszystkie numery tej edycji';
      card.addEventListener('click', () => openFarmNftExplorer(r.species));
    }
    grid.append(card);
  });
  body.append(grid);
}

// ════════════════════════════════════════════════════════════════════════════
//  💎 Kolekcja NFT hub tab — 📖 Album · 🏛️ Wystawa · 🔥 Ołtarz · 🗓️ Kalendarz
//  Backend: supabase/farm-nft-social.sql. Nothing here mints a coin.
// ════════════════════════════════════════════════════════════════════════════

// Mirrors of the server's policy knobs — preview only, the server decides.
const FNFT_SET_BONUS = 0.02;               // farm_nft_set_bonus_per_set()
function fnftAltarBoxes(value) {          // farm_altar_boxes()
  return Math.max(1, Math.ceil(Math.max(0, Number(value) || 0) / 1000));
}

let fnftSub = 'album';
let fnftSets = null;          // farm_nft_sets rows (species arrays) for the yield preview
let fnftRibbons = new Set();  // instance ids that won a Wystawa
let fnftBusy = false;

(function farmNftHubCss() {
  if (document.getElementById('farm-nft-hub-css')) return;
  const s = document.createElement('style');
  s.id = 'farm-nft-hub-css';
  s.textContent = `
    .fnft-hub { display: flex; flex-direction: column; gap: 12px; color: var(--text); }
    .fnft-subs { display: flex; gap: 6px; flex-wrap: wrap; }
    .fnft-subs button { border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: 999px;
      padding: 6px 12px; font-size: 12.5px; font-weight: 700; cursor: pointer; }
    .fnft-subs button.active { background: var(--text); color: var(--card, #fff); border-color: var(--text); }
    .fnft-lead { font-size: 12.5px; line-height: 1.55; color: var(--muted); margin: 0; }
    .fnft-lead b { color: var(--text); }
    .fnft-kpi { display: flex; gap: 8px; flex-wrap: wrap; }
    .fnft-kpi span { font-size: 12px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); }
    .fnft-kpi b { font-variant-numeric: tabular-nums; }
    /* Album */
    .fnft-sets { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 10px; }
    .fnft-set { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .fnft-set.is-done { border-color: #16a34a; box-shadow: 0 0 0 2px rgba(22,163,74,.15); }
    .fnft-set-head { display: flex; align-items: center; gap: 8px; }
    .fnft-set-emoji { font-size: 22px; line-height: 1; }
    .fnft-set-name { font-weight: 850; font-size: 14px; min-width: 0; }
    .fnft-set-badge { margin-left: auto; font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: var(--bg-mid); color: var(--muted); white-space: nowrap; }
    .fnft-set.is-done .fnft-set-badge { background: #16a34a; color: #fff; }
    .fnft-set-blurb { font-size: 11.5px; color: var(--muted); }
    .fnft-slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); gap: 6px; }
    .fnft-slot { display: flex; flex-direction: column; align-items: center; gap: 2px; text-align: center; padding: 7px 4px; border-radius: 10px;
      border: 1px dashed var(--border); background: var(--card); min-width: 0; }
    .fnft-slot .farm-ico { width: 30px; height: 30px; filter: grayscale(1); opacity: .35; }
    .fnft-slot.has { border-style: solid; border-color: #d4a017; background: linear-gradient(180deg, #fffbeb, var(--card)); }
    .fnft-slot.has .farm-ico { filter: drop-shadow(0 2px 3px rgba(0,0,0,.2)); opacity: 1; }
    .fnft-slot.clickable { cursor: pointer; }
    .fnft-slot-name { font-size: 10px; font-weight: 750; line-height: 1.15; overflow-wrap: anywhere; }
    .fnft-slot-sub { font-size: 9.5px; color: var(--muted); }
    .fnft-set-by { font-size: 11px; color: var(--muted); }
    /* Wystawa */
    .fnft-expo-me { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
    .fnft-expo-me select { flex: 1 1 220px; min-width: 0; width: auto; }
    .fnft-expo-me button, .fnft-altar-row button, .fnft-actions button { width: auto; margin: 0; }
    .fnft-expo { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap: 10px; }
    .fnft-expo-card { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; padding: 12px 8px 10px;
      border-radius: 14px; border: 3px solid #e7cfa0; background: linear-gradient(180deg, #fffaf0, #f6ead0); color: #3b2405; min-width: 0; }
    .fnft-expo-card.col-classic { border-color: #94a3b8; } .fnft-expo-card.col-autumn26 { border-color: #c2410c; }
    .fnft-expo-card.col-prl { border-color: #b91c1c; } .fnft-expo-card.col-hybrid { border-color: #a855f7; }
    .fnft-expo-card.is-voted { box-shadow: 0 0 0 3px rgba(220,38,38,.25); }
    .fnft-expo-card .farm-ico { width: 52px; height: 52px; filter: drop-shadow(0 3px 5px rgba(0,0,0,.22)); }
    .fnft-expo-name { font-weight: 850; font-size: 13px; line-height: 1.15; }
    .fnft-expo-sp { font-size: 10.5px; color: #7a5a1a; overflow-wrap: anywhere; }
    .fnft-expo-who { font-size: 11px; font-weight: 700; }
    .fnft-expo-votes { font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .fnft-expo-card button { width: 100%; margin-top: 2px; }
    .fnft-hist { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
    .fnft-hist div { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .fnft-hist .farm-ico { width: 16px; height: 16px; }
    .fnft-when { color: var(--muted); font-variant-numeric: tabular-nums; }
    /* Ołtarz */
    .fnft-altar { display: flex; flex-direction: column; gap: 6px; }
    .fnft-altar-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px;
      padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); }
    .fnft-altar-row .farm-ico { width: 30px; height: 30px; }
    .fnft-altar-name { font-weight: 800; font-size: 13px; overflow-wrap: anywhere; }
    .fnft-altar-sub { font-size: 11px; color: var(--muted); }
    .fnft-altar-row button { white-space: nowrap; }
    .fnft-ribbon { position: absolute; z-index: 3; top: 56px; right: 7px; font-size: 13px; line-height: 1; filter: drop-shadow(0 1px 1px rgba(0,0,0,.3)); }
    .fnft-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .fnft-actions button { flex: 1 1 140px; }
    @media (max-width: 520px) { .fnft-altar-row { grid-template-columns: auto minmax(0, 1fr); } .fnft-altar-row button { grid-column: 1 / -1; } }
  `;
  document.head.append(s);
})();

// Album sets + Wystawa ribbons, loaded with the calendar. Kept separate from
// fnftRefresh's first-load repaint so a slow call never blocks the frames.
async function fnftLoadSocial() {
  const [sets, wins] = await Promise.all([
    sb.from('farm_nft_sets').select('code,species'),
    sb.from('farm_nft_expo_winners').select('instance_id').gt('prize_boxes', 0),
  ]);
  if (!sets.error) fnftSets = sets.data || [];
  if (!wins.error) fnftRibbons = new Set((wins.data || []).map(w => w.instance_id).filter(Boolean));
}

// Client mirror of farm_nft_set_bonus(): +2% per set whose every species you
// hold right now. Read by farmNeighbourYieldMult() in tabs/farm-world.js,
// inside the same cap as the other bonuses.
function fnftSetBonus() {
  if (!fnftSets || !me) return 0;
  const mine = new Set(fmNft.filter(n => n.owner_id === me.id).map(n => n.species));
  return FNFT_SET_BONUS * fnftSets.filter(s => (s.species || []).every(sp => mine.has(sp))).length;
}

function fnftNick(uid) {
  return (sidePeople.find(p => p.id === uid) || {}).nick || (uid === me?.id ? me.nick : '?');
}

function fnftWeekLabel(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  return isNaN(d) ? String(iso) : 'tydz. od ' + d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
}

function buildFarmNftHubBody(bodyEl) {
  const wrap = el('div', { className: 'fnft-hub' });
  const subs = el('div', { className: 'fnft-subs', role: 'tablist' });
  const content = el('div', {});
  [['album', '📖 Album'], ['expo', '🏛️ Wystawa'], ['altar', '🔥 Ołtarz'], ['calendar', '🗓️ Kalendarz']].forEach(([id, label]) => {
    const b = el('button', { type: 'button', className: fnftSub === id ? 'active' : '' }, label);
    b.addEventListener('click', () => { fnftSub = id; buildFarmNftHubBody(bodyEl); });
    subs.append(b);
  });
  wrap.append(subs, content);
  bodyEl.replaceChildren(wrap);
  content.append(el('div', { className: 'farm-card-sub' }, 'Ładowanie…'));
  const go = fnftSub === 'expo' ? fnftRenderExpo : fnftSub === 'altar' ? fnftRenderAltar
           : fnftSub === 'calendar' ? (host => { host.replaceChildren(); return fnftCalendarInto(host); }) : fnftRenderAlbum;
  Promise.resolve(go(content)).catch(e => {
    console.error('farm nft hub', e);
    content.replaceChildren(el('div', { className: 'farm-empty' }, 'Nie udało się wczytać. Spróbuj ponownie.'));
  });
}

// ── 📖 Album ────────────────────────────────────────────────────────────────
async function fnftRenderAlbum(host) {
  const { data, error } = await sb.rpc('farm_nft_album_state');
  if (error) throw error;
  const sets = data.sets || [];
  const done = (data.complete || []).length;
  host.replaceChildren();
  host.append(
    el('p', { className: 'fnft-lead' },
      'Zbieraj karty NFT w kolekcje. Komplet to ', el('b', {}, 'co najmniej jedna karta każdego gatunku z zestawu, trzymana naraz'),
      ' — każdy komplet daje ', el('b', {}, '+' + Math.round((data.per_set || FNFT_SET_BONUS) * 100) + '% plonu na wszystkich twoich polach'),
      '. Premia mieści się w tym samym limicie co pary i talenty (+25% / +35%), a liczy się to, co masz TERAZ: sprzedana karta zabiera premię. ',
      'Brakuje ci jednej? Kup ją na Targowisku albo wystaw „Zlecenie zakupu".'),
    el('div', { className: 'fnft-kpi' },
      el('span', {}, 'Komplety: ', el('b', {}, done + ' / ' + sets.length)),
      el('span', {}, 'Premia teraz: ', el('b', {}, '+' + Math.round((data.bonus || 0) * 100) + '% plonu'))));
  const grid = el('div', { className: 'fnft-sets' });
  sets.forEach(s => {
    const sp = s.species || [];
    const have = sp.filter(x => x.mine > 0).length;
    const card = el('div', { className: 'fnft-set' + (s.complete ? ' is-done' : '') });
    card.append(el('div', { className: 'fnft-set-head' },
      el('span', { className: 'fnft-set-emoji' }, s.emoji),
      el('span', { className: 'fnft-set-name' }, s.name),
      el('span', { className: 'fnft-set-badge' }, s.complete ? '✅ Komplet · +' + Math.round((data.per_set || FNFT_SET_BONUS) * 100) + '%' : have + ' / ' + sp.length)));
    if (s.blurb) card.append(el('div', { className: 'fnft-set-blurb' }, s.blurb));
    const slots = el('div', { className: 'fnft-slots' });
    sp.forEach(x => {
      let sub;
      if (x.mine > 0) sub = 'masz ' + x.mine;
      else if (x.series_month && !x.is_active) sub = '🔒 od ' + farmMonthStartLabel(x.series_month);
      else if (x.live > 0) sub = 'w obiegu: ' + x.live;
      else if (x.edition_size != null && x.minted >= x.edition_size) sub = 'wymarła';
      else sub = 'nikt nie ma';
      const slot = el('div', { className: 'fnft-slot' + (x.mine > 0 ? ' has' : ''), title: x.name || x.species },
        farmIcon(x.emoji || '💎'),
        el('div', { className: 'fnft-slot-name' }, x.name || x.species),
        el('div', { className: 'fnft-slot-sub' }, sub));
      if (x.is_active && fmDefs.has(x.species)) {
        slot.classList.add('clickable');
        slot.addEventListener('click', () => openFarmNftExplorer(x.species));
      }
      slots.append(slot);
    });
    card.append(slots);
    const by = s.completed_by || [];
    card.append(el('div', { className: 'fnft-set-by' }, by.length
      ? '🏅 Skompletowali: ' + by.map(b => b.nick + ' (' + new Date(b.at).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' }) + ')').join(', ')
      : 'Nikt jeszcze nie skompletował tego zestawu.'));
    grid.append(card);
  });
  host.append(grid);
}

// ── 🏛️ Wystawa ─────────────────────────────────────────────────────────────
async function fnftRenderExpo(host) {
  const { data, error } = await sb.rpc('farm_expo_state');
  if (error) throw error;
  const entries = data.entries || [];
  const myEntry = entries.find(e => e.mine);
  const ends = new Date(data.ends_at);
  host.replaceChildren();
  host.append(el('p', { className: 'fnft-lead' },
    'Co tydzień każdy może wystawić ', el('b', {}, 'jedną'), ' kartę NFT. Każdy ma ', el('b', {}, 'jeden głos'),
    ' (tajny — widać tylko liczby) i nie może głosować na siebie. W poniedziałek o północy wygrywa karta z największą liczbą głosów: ',
    el('b', {}, '⭐ Złota Skrzynia i 🏆 na karcie na zawsze'), '. Nagroda jest, gdy wystawiono min. ' + data.min_entries +
    ' karty i oddano min. ' + data.min_votes + ' głosy. Remis wygrywa ten, kto wystawił wcześniej.'));
  host.append(el('div', { className: 'fnft-kpi' },
    el('span', {}, 'Koniec: ', el('b', {}, fmtDateTime(ends))),
    el('span', {}, 'Karty: ', el('b', {}, String(entries.length))),
    el('span', {}, 'Głosy: ', el('b', {}, String(data.voters || 0)))));

  // My entry
  const mine = fmNft.filter(n => n.owner_id === me?.id).sort((a, b) => a.species.localeCompare(b.species) || a.serial_no - b.serial_no);
  const meBox = el('div', { className: 'fnft-expo-me' });
  if (!mine.length) {
    meBox.append(el('span', { className: 'fnft-lead' }, 'Nie masz karty NFT do wystawienia — ale możesz głosować.'));
  } else {
    const sel = el('select', { className: 'nick-select', 'aria-label': 'Twoja karta na Wystawę' });
    mine.forEach(n => sel.append(el('option', { value: n.id }, farmNftLabel(n) + (n.nft_name ? ' — ' + n.nft_name : ''))));
    if (myEntry) sel.value = myEntry.instance_id;
    const enter = el('button', { className: 'btn-primary', type: 'button' }, myEntry ? 'Zmień kartę' : '🏛️ Wystaw');
    enter.addEventListener('click', () => fnftExpoCall('farm_expo_enter', { p_instance_id: sel.value }, enter, host, myEntry ? 'Zmieniono kartę na Wystawie.' : '🏛️ Twoja karta jest na Wystawie!'));
    meBox.append(sel, enter);
    if (myEntry) {
      const out = el('button', { className: 'btn-ghost', type: 'button' }, 'Wycofaj');
      out.addEventListener('click', () => fnftExpoCall('farm_expo_enter', { p_instance_id: null }, out, host, 'Wycofano kartę z Wystawy.'));
      meBox.append(out);
    }
  }
  host.append(meBox);

  if (!entries.length) {
    host.append(el('div', { className: 'farm-empty' }, 'Na tej Wystawie nie ma jeszcze żadnej karty. Bądź pierwszy!'));
  } else {
    const grid = el('div', { className: 'fnft-expo' });
    entries.slice().sort((a, b) => (b.votes - a.votes) || String(a.entered_at).localeCompare(String(b.entered_at))).forEach(e => {
      const voted = data.my_vote === e.user_id;
      const card = el('div', { className: 'fnft-expo-card col-' + (e.nft_collection || 'classic') + (voted ? ' is-voted' : '') },
        farmIcon(farmNftIconFor(e.species, e.serial_no, e.emoji)),
        el('div', { className: 'fnft-expo-name' }, (e.nft_name || e.name) + (e.level > 1 ? ' ' + '⭐'.repeat(e.level) : '')),
        el('div', { className: 'fnft-expo-sp' }, e.name + ' · #' + e.serial_no + '/' + e.edition_size),
        el('div', { className: 'fnft-expo-who' }, '👤 ' + e.nick),
        el('div', { className: 'fnft-expo-votes' }, '❤️ ' + e.votes + ' ' + plCount(e.votes, 'głos', 'głosy', 'głosów')));
      let btn;
      if (e.mine) btn = el('button', { className: 'btn-ghost', type: 'button', disabled: true }, 'Twoja karta');
      else if (voted) {
        btn = el('button', { className: 'btn-ghost', type: 'button', title: 'Kliknij, aby cofnąć głos' }, '✓ Twój głos');
        btn.addEventListener('click', () => fnftExpoCall('farm_expo_vote', { p_entry_user: null }, btn, host, 'Cofnięto głos.'));
      } else {
        btn = el('button', { className: 'btn-primary', type: 'button' }, data.my_vote ? 'Przenieś głos' : '❤️ Głosuj');
        btn.addEventListener('click', () => fnftExpoCall('farm_expo_vote', { p_entry_user: e.user_id }, btn, host, '❤️ Zagłosowano na kartę ' + e.nick + '.'));
      }
      card.append(btn);
      grid.append(card);
    });
    host.append(grid);
  }

  const wins = data.winners || [];
  host.append(el('div', { className: 'farm-inv-section-title' }, '🏆 Poprzednie Wystawy'));
  if (!wins.length) host.append(el('div', { className: 'farm-empty' }, 'Jeszcze żadna Wystawa się nie zakończyła.'));
  else {
    const hist = el('div', { className: 'fnft-hist' });
    wins.forEach(w => hist.append(el('div', {},
      el('span', { className: 'fnft-when' }, fnftWeekLabel(w.week_start)),
      w.prize_boxes > 0
        ? el('span', {}, '🏆 ', el('b', {}, w.nick || '?'), ' — ', farmIcon(w.emoji || '💎'), ' „' + (w.nft_name || w.name || '') + '" #' + w.serial_no + ' · ' + w.votes + ' ' + plCount(w.votes, 'głos', 'głosy', 'głosów'))
        : el('span', { className: 'fnft-when' }, 'bez nagrody — ' + w.entries + ' ' + plCount(w.entries, 'karta', 'karty', 'kart') + ', ' + w.voters + ' ' + plCount(w.voters, 'głos', 'głosy', 'głosów')))));
    host.append(hist);
  }
}

async function fnftExpoCall(fn, args, btn, host, okMsg) {
  if (fnftBusy) return;
  fnftBusy = true; if (btn) btn.disabled = true;
  try {
    const { error } = await sb.rpc(fn, args);
    if (error) { showToast('❌ ' + fmErr(error)); return; }
    showToast(okMsg);
    await fnftRenderExpo(host);
  } finally {
    fnftBusy = false; if (btn) btn.disabled = false;
  }
}

// ── 🔥 Ołtarz ──────────────────────────────────────────────────────────────
async function fnftRenderAltar(host) {
  const planted = farmPlantedNftIds();
  const mine = fmNft.filter(n => n.owner_id === me?.id);
  const free = mine.filter(n => !n.listed && !planted.has(n.id))
    .sort((a, b) => (farmNftValue(a) || 0) - (farmNftValue(b) || 0));
  host.replaceChildren();
  host.append(el('p', { className: 'fnft-lead' },
    'Złóż kartę NFT w ofierze, a dostaniesz ', el('b', {}, '⭐ Złote Skrzynie'), ' (5 losowań, pierwsza karta co najmniej rzadka). ',
    'Skrzyń jest tyle, ile tysięcy 🪙 warta jest karta w Net Worth (w górę, min. 1) — mniej niż jej wartość, bo to ołtarz, a nie kantor. ',
    el('b', {}, 'Karta znika na zawsze'), ', a jej numer zostaje w eksploratorze edycji ze świeczką 🕯️. ',
    'Zasadzonych, wystawionych na Targowisku i tej z bieżącej Wystawy nie da się złożyć.'));
  if (!free.length) {
    host.append(el('div', { className: 'farm-empty' }, mine.length
      ? 'Wszystkie twoje karty NFT są zasadzone albo wystawione.'
      : 'Nie masz żadnej karty NFT.'));
  } else {
    const list = el('div', { className: 'fnft-altar' });
    free.forEach(n => {
      const def = fmDefs.get(n.species) || {};
      const value = farmNftValue(n) || 0;
      const boxes = fnftAltarBoxes(value);
      const btn = el('button', { className: 'btn-ghost', type: 'button' }, '🔥 Złóż → ⭐×' + boxes);
      btn.addEventListener('click', () => fnftSacrifice(n, btn, () => fnftRenderAltar(host)));
      list.append(el('div', { className: 'fnft-altar-row' },
        farmIcon(farmNftEmoji(n)),
        el('div', {},
          el('div', { className: 'fnft-altar-name' }, '„' + (n.nft_name || def.name) + '" #' + n.serial_no + '/' + n.edition_size),
          el('div', { className: 'fnft-altar-sub' }, (def.name || n.species) + ' · poz. ' + (n.level || 1) + ' · wartość ' + fdsCoins(value))),
        btn));
    });
    host.append(list);
  }
  const { data } = await sb.from('farm_nft_altar_log').select('user_id,species,serial_no,nft_name,boxes,created_at')
    .order('created_at', { ascending: false }).limit(10);
  host.append(el('div', { className: 'farm-inv-section-title' }, '🕯️ Ostatnie ofiary'));
  if (!data?.length) host.append(el('div', { className: 'farm-empty' }, 'Na ołtarzu jeszcze nic nie spłonęło.'));
  else {
    const hist = el('div', { className: 'fnft-hist' });
    data.forEach(r => {
      const def = fmDefs.get(r.species) || {};
      hist.append(el('div', {},
        el('span', { className: 'fnft-when' }, relTime(r.created_at)),
        el('b', {}, fnftNick(r.user_id)),
        el('span', {}, '→ ', farmIcon(farmNftIconFor(r.species, r.serial_no, def.emoji)), ' „' + (r.nft_name || def.name || r.species) + '" #' + r.serial_no + ' · ⭐×' + r.boxes)));
    });
    host.append(hist);
  }
}

async function fnftSacrifice(n, btn, after) {
  if (fnftBusy) return false;
  const def = fmDefs.get(n.species) || {};
  const boxes = fnftAltarBoxes(farmNftValue(n) || 0);
  const ok = await uiConfirm('Złożyć „' + (n.nft_name || def.name) + '" #' + n.serial_no + ' (' + (def.name || n.species) +
    ') na ołtarzu? Karta zniknie NA ZAWSZE, a ty dostaniesz ⭐×' + boxes + ' ' + plCount(boxes, 'Złotą Skrzynię', 'Złote Skrzynie', 'Złotych Skrzyń') + '.',
    { okLabel: '🔥 Złóż w ofierze', danger: true });
  if (!ok) return false;
  fnftBusy = true; if (btn) btn.disabled = true;
  try {
    const { data, error } = await sb.rpc('sacrifice_nft', { p_instance_id: n.id });
    if (error) { showToast('❌ ' + fmErr(error)); return false; }
    fmNft = fmNft.filter(x => x.id !== n.id);
    if (typeof data.boxes_gold === 'number') fmGoldBoxes = data.boxes_gold;
    await invalidateFarmAssetBreakdown({ reload: true });
    showToast('🔥 „' + (n.nft_name || def.name) + '" #' + n.serial_no + ' spłonęła na ołtarzu → ⭐×' + data.boxes);
    if (sideShowcase.get(me.id)?.instance_id === n.id) sideLoadShowcases(true);
    renderFarmSelection();
    if (after) await after();
    return true;
  } finally {
    fnftBusy = false; if (btn) btn.disabled = false;
  }
}

// ── NFT modal: the collector's actions (overrides the index.html stub) ─────
function farmNftModalExtras(n, body, close, opts) {
  if (n.owner_id !== me?.id) return;
  const isShow = sideShowcase.get(me.id)?.instance_id === n.id;
  const show = el('button', { className: 'btn-ghost', type: 'button' }, isShow ? '✓ Twoja wizytówka (usuń)' : '🖼️ Pokaż przy nicku');
  show.addEventListener('click', async () => {
    show.disabled = true;
    const { error } = await sb.rpc('set_showcase_nft', { p_instance_id: isShow ? null : n.id });
    show.disabled = false;
    if (error) { showToast('❌ ' + fmErr(error)); return; }
    showToast(isShow ? 'Usunięto wizytówkę.' : '🖼️ „' + (n.nft_name || '') + '" stoi teraz przy twoim nicku.');
    await sideLoadShowcases(true);
    close();
  });
  const expo = el('button', { className: 'btn-ghost', type: 'button' }, '🏛️ Wystaw na Wystawie');
  expo.addEventListener('click', async () => {
    expo.disabled = true;
    const { error } = await sb.rpc('farm_expo_enter', { p_instance_id: n.id });
    expo.disabled = false;
    if (error) { showToast('❌ ' + fmErr(error)); return; }
    showToast('🏛️ Karta jest na tegotygodniowej Wystawie!');
    close(); fnftSub = 'expo'; openFarmHub('nft');
  });
  const blocked = opts?.planted || n.listed;
  const altar = el('button', { className: 'btn-ghost', type: 'button', disabled: !!blocked,
    title: blocked ? 'Zasadzonej albo wystawionej karty nie da się złożyć' : '' }, '🔥 Na ołtarz → ⭐×' + fnftAltarBoxes(farmNftValue(n) || 0));
  altar.addEventListener('click', async () => { if (await fnftSacrifice(n, altar)) close(); });
  body.append(fdsSection('Kolekcjoner'), el('div', { className: 'fnft-actions' }, show, expo, altar));
}

// ── Moved from index.html: merge, breeding lab, edition explorer ─────────────

// Merge two same-species, same-level NFT instances into one higher-level NFT.
// The "fuel" candidate the player picks is destroyed forever; the "hero" (the
// card whose tile/footer button was clicked) survives and gains a level.
function openFarmNftMergeModal(hero) {
  const def = fmDefs.get(hero.species) || {};
  const lvl = hero.level || 1;
  const cost = 50 * lvl * lvl;
  const overlay = el('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
  const close = () => { overlay.remove(); window.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const closeX = el('button', { className: 'btn-close', type: 'button', 'aria-label': 'Zamknij' }, '✕');
  closeX.addEventListener('click', close);

  const heroLine = el('div', { className: 'farm-card-sub' },
    farmNftEmoji(hero) + ' ' + (hero.nft_name || def.name || hero.species) + ' #' + hero.serial_no + ' · poz. ' + lvl);

  const candidates = farmNftMergeCandidates(hero);
  let selectedId = candidates.length === 1 ? candidates[0].id : null;

  const warn = el('div', { className: 'farm-card-sub', style: { color: '#e74c3c', fontWeight: '600', marginTop: '8px' } });
  const updateWarn = () => {
    const fuel = candidates.find(c => c.id === selectedId);
    warn.textContent = fuel
      ? '⚠️ Karta #' + fuel.serial_no + ' „' + (fuel.nft_name || def.name || hero.species) + '" zostanie ZNISZCZONA NA ZAWSZE — zniknie z edycji, a pula zmniejszy się o 1 egzemplarz.'
      : 'Wybierz kartę, którą poświęcisz.';
  };

  const list = el('div', { className: 'fcc-grid compact' });
  const confirmBtn = el('button', { className: 'btn-primary', disabled: true, style: { marginTop: '10px' } });
  const refreshConfirm = () => {
    const enough = (me?.coins || 0) >= cost;
    confirmBtn.disabled = !selectedId || !enough;
    confirmBtn.textContent = !enough ? ('Za mało coinów (' + cost + ' 🪙)') : ('🔀 Połącz i ulepsz do poz. ' + (lvl + 1) + ' · ' + cost + ' 🪙');
  };

  if (!candidates.length) {
    list.append(el('div', { className: 'farm-empty' },
      'Nie masz innej karty „' + (def.name || hero.species) + '" na poziomie ' + lvl + ' do poświęcenia. Zdobądź kolejny egzemplarz ze skrzynki lub Targowiska.'));
  } else {
    candidates.forEach(c => {
      const radio = el('input', { type: 'radio', name: 'farm-merge-fuel' });
      radio.checked = selectedId === c.id;
      const row = el('div', { className: 'farm-merge-fuel-row',
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '6px', cursor: 'pointer' } },
        radio, el('span', { className: 'fnft-merge-row' }, farmIcon(farmNftEmoji(c)), ' #' + c.serial_no + ' · ' + (c.nft_name || def.name || hero.species)));
      row.addEventListener('click', () => {
        selectedId = c.id;
        list.querySelectorAll('input[type=radio]').forEach(r => { r.checked = false; });
        radio.checked = true;
        updateWarn(); refreshConfirm();
      });
      list.append(row);
    });
  }
  updateWarn(); refreshConfirm();

  confirmBtn.addEventListener('click', async () => {
    if (!selectedId) return;
    const ok = await mergeFarmNft(hero.id, selectedId, confirmBtn);
    if (ok) close();
  });

  const modal = el('div', { className: 'modal farm-nft-modal' },
    el('div', { className: 'modal-header' }, el('span', { className: 'modal-title' }, '🔀 Połącz karty NFT'), closeX),
    heroLine,
    el('div', { className: 'farm-card-sub' }, 'Wybierz drugi egzemplarz tego samego poziomu do poświęcenia:'),
    list,
    warn,
    confirmBtn);
  overlay.append(modal);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', esc);
  document.body.append(overlay);
}

async function mergeFarmNft(heroId, fuelId, btn) {
  if (btn) btn.disabled = true;
  const { data, error } = await sb.rpc('level_up_nft', { p_hero_id: heroId, p_fuel_id: fuelId });
  if (error) { showToast('❌ ' + fmErr(error)); if (btn) btn.disabled = false; return false; }
  if (typeof data.coins === 'number') { me.coins = data.coins; setText(headerCoins, me.coins); }
  fmNft = fmNft.filter(n => n.id !== fuelId);
  const hero = fmNft.find(n => n.id === heroId);
  if (hero) hero.level = data.new_level;
  await invalidateFarmAssetBreakdown({ reload: true });
  showToast('🔀 ' + (data.hero_name || '') + ' #' + data.hero_serial + ' — poziom ' + data.new_level + '! („' + (data.fuel_name || '') + '" #' + data.fuel_serial + ' poświęcona)');
  refreshFarmHub(); renderFarmSelection();
  return true;
}
// Rules and the office feed belong to the breeding decision, not to the main
// portfolio stream. Keep them collapsed inside the laboratory modal.
function farmHybridFeedDisclosure() {
  const sec = el('details', { className: 'farm-pm-details' });
  sec.append(el('summary', {}, 'Jak działa krzyżowanie i ostatnie hybrydy'));
  const ul = el('ul', { className: 'breed-facts' });
  [['🔥', 'Obie karty-rodzice znikają NA ZAWSZE.'],
   ['⚡', 'Hybryda zarabia o 15% więcej na dobę i rośnie o 5% krócej niż lepszy z rodziców — liczone od ich AKTUALNYCH poziomów i cen skupu ich plonów.'],
   ['🎚️', 'Hybryda dziedziczy poziom lepszego rodzica, więc awanse nie przepadają przy krzyżowaniu.'],
   ['💼', 'Wartość w majątku hybrydy nigdy nie spada poniżej wartości lepszego rodzica.'],
   ['✨', 'Wybrane pary dają kultowy przepis (np. 🌹+🌻 → „Słoneczna Róża"), reszta „Dzikiego Mieszańca 🌈" — a każdy jego numer ma własną ikonę.'],
   ['🪙', 'Koszt rośnie z poziomem rodziców; odznaka „Mistrz Hybryd" go obniża.']
  ].forEach(([ic, tx]) => ul.append(el('li', {}, el('span', { className: 'bfx' }, ic), tx)));
  sec.append(ul);
  if (fmHybridFeed && fmHybridFeed.length) {
    const feed = el('div', { className: 'farm-hybrid-feed' });
    feed.append(el('div', { className: 'farm-card-sub', style: { marginTop: '10px', fontWeight: '600' } }, 'Ostatnie hybrydy w biurze:'));
    fmHybridFeed.slice(0, 8).forEach(h => {
      feed.append(el('div', { className: 'farm-hybrid-row' },
        el('span', {}, farmNftIconFor(h.hybrid_species, h.hybrid_serial, h.hybrid_emoji || '🌈') + ' ' + h.hybrid_name + ' #' + h.hybrid_serial),
        el('span', { className: 'fhr-parents' }, '← '
          + farmNftIconFor(h.parent_a_species, h.parent_a_serial, fmDefs.get(h.parent_a_species)?.emoji)
          + '+' + farmNftIconFor(h.parent_b_species, h.parent_b_serial, fmDefs.get(h.parent_b_species)?.emoji) +
          (h.bred_by_nick ? ' · ' + h.bred_by_nick : ''))));
    });
    sec.append(feed);
  } else {
    sec.append(el('div', { className: 'farm-card-sub', style: { marginTop: '10px' } }, 'W biurze nie wyhodowano jeszcze żadnej hybrydy.'));
  }
  return sec;
}
function breedStatRow(label, value, opts = {}) {
  return el('div', { className: 'bl-stat' + (opts.good ? ' good' : '') },
    el('span', {}, label), el('b', {}, value));
}

// One parent slot: either an empty picker or the chosen card + its stats.
function breedSlot(side, chosen, onPick) {
  const box = el('div', { className: 'bl-slot' + (chosen ? ' filled' : '') });
  box.append(el('div', { className: 'bl-slot-head' }, side));
  if (!chosen) {
    box.append(el('div', { className: 'bl-empty' }, '＋'),
               el('div', { className: 'bl-empty-txt' }, 'Wybierz kartę'));
  } else {
    const st = farmNftStats(chosen);
    box.append(
      el('div', { className: 'bl-art' }, farmIcon(farmNftEmoji(chosen))),
      el('div', { className: 'bl-name' }, chosen.nft_name || st.def.name || chosen.species),
      el('div', { className: 'bl-sub' }, (st.def.name || '') + ' · #' + chosen.serial_no + '/' + chosen.edition_size),
      breedStatRow('Poziom', String(st.lvl)),
      breedStatRow('Plon', st.yield + ' szt.'),
      breedStatRow('Wzrost', farmGrowLabel(st.grow)),
      breedStatRow('Zysk/doba', st.perDay != null ? ('≈ ' + st.perDay + ' 🪙') : '—'),
      breedStatRow('Wartość', st.value != null ? (st.value + ' 🪙') : '—'));
  }
  const btn = el('button', { className: 'bl-pick' }, chosen ? 'Zmień' : 'Wybierz');
  btn.addEventListener('click', onPick);
  box.append(btn);
  return box;
}
function openFarmBreedModal() {
  const overlay = el('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
  const close = () => { overlay.remove(); window.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const closeX = el('button', { className: 'btn-close', type: 'button', 'aria-label': 'Zamknij' }, '✕');
  closeX.addEventListener('click', close);

  const pool = farmBreedableNfts();
  let A = null, B = null;
  const body = el('div', { className: 'bl-body' });

  // Inline chooser: lists eligible cards (excluding the other slot's species).
  function choose(slot) {
    const other = slot === 'A' ? B : A;
    const list = el('div', { className: 'bl-choose' });
    const opts = pool.filter(n => (!other || (n.id !== other.id && n.species !== other.species)));
    if (!opts.length) {
      list.append(el('div', { className: 'farm-empty' }, 'Brak pasujących kart — potrzebujesz karty INNEGO gatunku.'));
    }
    opts.forEach(n => {
      const st = farmNftStats(n);
      const row = el('button', { className: 'bl-choose-row' },
        el('span', { className: 'bcr-emoji' }, farmIcon(farmNftEmoji(n))),
        el('span', { className: 'bcr-name' }, (n.nft_name || st.def.name) + ' #' + n.serial_no),
        el('span', { className: 'bcr-stat' }, 'poz. ' + st.lvl + ' · ' + st.yield + ' szt. · ≈' + (st.perDay ?? '—') + '🪙/d'));
      row.addEventListener('click', () => { if (slot === 'A') A = n; else B = n; render(); });
      list.append(row);
    });
    body.replaceChildren(el('div', { className: 'bl-choose-head' }, 'Wybierz kartę — rodzic ' + slot),
      list);
    const back = el('button', { className: 'bl-pick', style: { marginTop: '10px' } }, '← Wróć');
    back.addEventListener('click', render);
    body.append(back);
  }

  function render() {
    body.replaceChildren();
    const prev = farmBreedPreview(A, B);
    const grid = el('div', { className: 'bl-grid' });
    grid.append(breedSlot('Rodzic A', A, () => choose('A')));

    // Middle: the result.
    const mid = el('div', { className: 'bl-slot bl-result' + (prev ? ' ready' : '') });
    mid.append(el('div', { className: 'bl-slot-head' }, 'Hybryda'));
    if (!prev) {
      mid.append(el('div', { className: 'bl-empty' }, '🧬'),
                 el('div', { className: 'bl-empty-txt' }, 'Wybierz dwie karty różnych gatunków, aby zobaczyć wynik'));
    } else {
      const r = prev.res;
      mid.append(
        el('div', { className: 'bl-art bl-art-holo' }, farmIcon(r.emoji || '🌈')),
        el('div', { className: 'bl-name' }, r.name),
        // The wild hybrid's icon depends on the serial the server hands out, which
        // isn't known until breed_nft commits — so the preview keeps the edition's
        // 🌈 and says what will happen instead of guessing a variety.
        el('div', { className: 'bl-sub' }, r.curated ? '✨ Kultowy przepis' : 'Brak przepisu — Dziki Mieszaniec, własna ikona dla numeru'),
        breedStatRow('Poziom', String(prev.level), { good: prev.level > 1 }),
        breedStatRow('Plon', prev.yield + ' szt.', { good: prev.yield > prev.bestParentYield }),
        breedStatRow('Wzrost', farmGrowLabel(prev.grow), { good: true }),
        breedStatRow('Zysk/doba', prev.perDay != null ? ('≈ ' + prev.perDay + ' 🪙') : '—',
                     { good: (prev.perDay || 0) > prev.bestParentPerDay }),
        breedStatRow('Wartość', prev.value != null ? (prev.value + ' 🪙') : '—',
                     { good: (prev.value || 0) >= prev.bestParentValue }),
        el('div', { className: 'bl-synergy' }, '⚡ Synergia: +15% zysku/dobę i −5% czasu wzrostu wobec lepszego rodzica; hybryda dziedziczy poziom lepszego rodzica'));
    }
    grid.append(mid);
    grid.append(breedSlot('Rodzic B', B, () => choose('B')));
    body.append(grid);

    const foot = el('div', { className: 'bl-foot' });
    if (prev) {
      const enough = (me?.coins || 0) >= prev.cost;
      foot.append(el('div', { className: 'bl-warn' },
        '⚠️ Obie karty-rodzice zostaną zniszczone na zawsze.'));
      const go = el('button', { className: 'btn-primary' },
        enough ? ('🧬 Skrzyżuj · ' + prev.cost + ' 🪙') : ('Za mało coinów (' + prev.cost + ' 🪙)'));
      go.disabled = !enough;
      go.addEventListener('click', async () => {
        const ok = await breedNft(A.id, B.id, go);
        if (ok) close();
      });
      foot.append(go);
    }
    body.append(foot, farmHybridFeedDisclosure());
  }
  render();

  const modal = el('div', { className: 'modal bl-modal' },
    el('div', { className: 'modal-header' },
      el('span', { className: 'modal-title' }, '🧬 Laboratorium krzyżowania'), closeX),
    body);
  overlay.append(modal);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', esc);
  document.body.append(overlay);
}


async function breedNft(aId, bId, btn) {
  if (!aId || !bId) return false;
  if (btn) btn.disabled = true;
  const { data, error } = await sb.rpc('breed_nft', { p_a: aId, p_b: bId });
  if (error) { showToast('❌ ' + fmErr(error)); if (btn) btn.disabled = false; return false; }
  if (typeof data.coins === 'number') { me.coins = data.coins; setText(headerCoins, me.coins); }
  const h = data.hybrid || {};
  // Remove both parents; add the fresh hybrid instance to local state.
  fmNft = fmNft.filter(n => n.id !== aId && n.id !== bId);
  // Carry the server's synergy stats into local state — without them the fresh
  // hybrid would render with its SPECIES defaults (weaker than the parents it
  // just burned) until the next full reload.
  // ⚠️ level and stat_value are part of that payload: since
  // farm-hybrid-income-parity.sql a hybrid INHERITS max(parentLevels) and may carry
  // a stat_value floor, so hardcoding level 1 / dropping stat_value made the fresh
  // card render at half yield and 1/50th value — and, far worse, made the NEXT
  // breeding preview measure „+15% over the better parent" against those wrong
  // numbers and offer a hybrid strictly worse than the parent, while quoting a
  // cost computed from level 1 instead of the real level.
  fmNft.push({ id: h.id, species: h.species, serial_no: h.serial_no, edition_size: h.edition_size,
               owner_id: me.id, nft_name: h.nft_name, level: h.level ?? 1, listed: false,
               stat_yield: h.stat_yield ?? null, stat_grow_minutes: h.stat_grow_minutes ?? null,
               stat_value: h.stat_value ?? null });
  // minted_count is the monotonic "minted ever" counter the catalog/edition grid
  // reads; bump it locally so the hybrid's supply isn't one short until a reload.
  const hDef = fmDefs.get(h.species);
  if (hDef && hDef.minted_count != null) hDef.minted_count = Math.max(hDef.minted_count + 1, h.serial_no || 0);
  fmHybridFeed = null; fmAchMine = null; fmAchAll = null;  // refetch meta (feed + achievements)
  await invalidateFarmAssetBreakdown({ reload: true });
  showToast('🧬 Wyhodowano ' + farmNftIconFor(h.species, h.serial_no, h.emoji) + ' „' + (h.name || 'hybrydę') + '" #' + h.serial_no + (h.curated ? ' ✨ (kultowy przepis!)' : '') + '!');
  refreshFarmHub(); renderFarmSelection();
  return true;
}
// Edition explorer: every serial slot of an NFT species (minted/owner or locked),
// plus the full ownership + price history from farm_nft_transfers. Opened from the
// Katalog 💎 group. Fetches live so it always reflects the latest mints/sales.
async function openFarmNftExplorer(species) {
  const def = fmDefs.get(species) || {};
  const overlay = el('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
  const close = () => { overlay.remove(); window.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const closeX = el('button', { className: 'btn-close', type: 'button', 'aria-label': 'Zamknij' }, '✕');
  closeX.addEventListener('click', close);
  const body = el('div', { className: 'farm-nftx-body' }, el('div', { className: 'loading-center' }, el('div', { className: 'spinner' })));
  const modal = el('div', { className: 'modal farm-nftx-modal' },
    el('div', { className: 'modal-header' },
      el('span', { className: 'modal-title' }, '💎 ' + (def.name || species) + ' — karta NFT'), closeX),
    body);
  overlay.append(modal);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', esc);
  document.body.append(overlay);

  try {
    const [instRes, trRes] = await Promise.all([
      sb.from('farm_nft_instances').select('id,serial_no,edition_size,owner_id,nft_name,listed,level').eq('species', species).order('serial_no'),
      sb.from('farm_nft_transfers').select('serial_no,from_owner,to_owner,price,kind,created_at').eq('species', species).order('created_at'),
    ]);
    const insts = instRes.data || [];
    const transfers = trRes.data || [];
    const editionSize = def.edition_size || insts.reduce((m, i) => Math.max(m, i.edition_size || 0), 0) || insts.length;
    // minted-ever: merges burn instances, so a serial can be minted yet have no
    // live row. Server counter first, live rows + transfer log as fallback.
    const mintedEver = Math.max(def.minted_count || 0, insts.length,
      insts.reduce((m, i) => Math.max(m, i.serial_no || 0), 0),
      transfers.reduce((m, t) => Math.max(m, t.serial_no || 0), 0));
    // resolve nicks for every owner referenced
    const ids = new Set();
    insts.forEach(i => i.owner_id && ids.add(i.owner_id));
    transfers.forEach(t => { if (t.from_owner) ids.add(t.from_owner); if (t.to_owner) ids.add(t.to_owner); });
    const nick = new Map();
    if (ids.size) {
      const { data: profs } = await sb.from('profiles').select('id,nick').in('id', [...ids]);
      (profs || []).forEach(p => nick.set(p.id, p.nick));
    }
    const nm = id => id ? (nick.get(id) || '?') : '—';
    const bySerial = new Map(); insts.forEach(i => bySerial.set(i.serial_no, i));

    const mine = insts.filter(i => i.owner_id === me?.id);
    const myLevel = mine.length ? Math.max(...mine.map(i => i.level || 1)) : undefined;
    const price = fmMarket.get(def.crop_type)?.base_price;
    const isHybrid = farmHasIndividualStats(def);

    body.replaceChildren();
    body.append(el('div', { className: 'farm-nftx-head' },
      farmIcon(def.emoji || '💎', 'farm-nftx-emoji'),
      el('div', {},
        el('div', { className: 'farm-nftx-title' }, def.name || species),
        el('div', { className: 'farm-nftx-sub' },
          mintedEver + ' / ' + editionSize + ' wybitych' +
          (mintedEver > insts.length ? ' · 🔥 ' + (mintedEver - insts.length) + ' spalonych (fuzje)' : '') +
          (isHybrid ? ' · wartość zależna od egzemplarza'
                    : ' · wartość ' + (editionSize ? Math.round(20000 / editionSize) : '?') + ' 🪙/szt')))));

    // ── Details, in the SAME window as the edition (previously a second modal
    //    behind a „Pokaż wszystkie" button, which split one card's info in two).
    const facts = el('div', { className: 'farm-nftx-facts' });
    const fact = (label, value, hint) => facts.append(el('div', { className: 'nftx-fact' },
      el('span', {}, label), el('b', {}, value), hint ? el('small', {}, hint) : ''));
    if (isHybrid) {
      fact('Statystyki', 'Indywidualne', 'dziedziczone po konkretnych rodzicach');
      fact('Cena skupu', price != null ? ('do ' + price + ' 🪙') : '—', 'za sztukę wspólnego plonu');
    } else {
      fact('Plon', farmYieldAtLevel(def, 1) + ' szt.', 'na poziomie 1');
      fact('Czas wzrostu', farmGrowDaysLabel(farmGrowMinAtLevel(def, 1)), 'min. 24 h');
      fact('Cena skupu', price != null ? ('do ' + price + ' 🪙') : '—', 'za sztukę plonu');
      fact('≈ Zysk/doba', price != null
        ? ('≈ ' + farmPerDayIncome(def, price * 0.30, 1) + '–' + farmPerDayIncome(def, price, 1) + ' 🪙') : '—',
        'przy cenie 30–100%');
    }
    fact('Nakład', String(editionSize), 'egzemplarzy na zawsze');
    fact('Masz', mine.length ? (mine.length + ' szt.') : '—',
      mine.length ? (isHybrid ? 'szczegóły w Moim Majątku' : 'poziom maks. ' + myLevel)
                  : (isHybrid ? 'z krzyżowania' : 'ze skrzynek'));
    body.append(facts);

    body.append(el('div', { className: 'farm-nftx-source' }, isHybrid
      ? '🧬 Hybryda — nie wypada ze skrzynek. Każdy egzemplarz dziedziczy własne parametry po użytych rodzicach, dlatego katalog nie pokazuje wspólnego poziomu ani drabinki zysku. Dokładne dane konkretnego egzemplarza są w 🎒 Moim Majątku.'
        + (species === 'wild_hybrid'
            ? ' To zbiorcza edycja dla par bez kultowego przepisu, więc każdy numer ma też własną ikonę — dwa Dzikie Mieszańce nigdy nie wyglądają tak samo.' : '')
      : (def.series_week
          ? '🗓️ Kolekcja sezonowa — wypada ze skrzynek do wyczerpania nakładu.'
          : '📦 Wypada ze skrzynek, dopóki nakład się nie wyczerpie.')));

    if (!isHybrid) {
      body.append(el('div', { className: 'farm-inv-section-title' }, '⬆️ Poziomy egzemplarza'));
      body.append(farmCardLevelTable(def, price, myLevel, { nft: true }));
    }

    // Edition grid: every slot 1..N — minted shows owner+name; a minted serial
    // with no live instance was burned as merge fuel; locked = not yet drawn.
    // „Dziki Mieszaniec" is the one edition whose icon differs per serial, so its
    // slots carry it — everywhere else it would just repeat the header 500 times.
    const perSerialIcon = species === 'wild_hybrid';
    // How each missing serial left the edition — the last burn row wins.
    const burnBy = new Map();
    transfers.forEach(t => { if (t.kind === 'merge_fuel' || t.kind === 'breed_parent' || t.kind === 'altar') burnBy.set(t.serial_no, t.kind); });
    const grid = el('div', { className: 'farm-nftx-grid' });
    for (let s = 1; s <= editionSize; s++) {
      const inst = bySerial.get(s);
      const burned = !inst && s <= mintedEver;
      const burnKind = burned ? (burnBy.get(s) || 'merge_fuel') : null;
      const slot = el('div', { className: 'farm-nftx-slot' + (inst ? (inst.owner_id === me?.id ? ' mine' : ' minted') : ' locked') },
        el('div', { className: 'farm-nftx-serial' },
          perSerialIcon ? el('span', { className: 'farm-nftx-slot-ico' }, farmIcon(farmNftIconFor(species, s, def.emoji))) : '',
          el('span', {}, '#' + s + (!isHybrid && inst && inst.level > 1 ? ' ⭐'.repeat(inst.level) : ''))),
        inst
          ? el('div', { className: 'farm-nftx-owner' }, el('b', {}, (inst.nft_name || '—') + (!isHybrid && inst.level > 1 ? ' Poz.' + inst.level : '')), el('span', {}, '👤 ' + nm(inst.owner_id)))
          : el('div', { className: 'farm-nftx-owner' }, el('span', {}, burned ? (FNFT_BURN_LABEL[burnKind] || '🔥 spalona') : '🔒 niewybita')));
      grid.append(slot);
    }
    body.append(el('div', { className: 'farm-inv-section-title' }, '🎴 Egzemplarze'), grid);

    // Ownership + price history
    body.append(el('div', { className: 'farm-inv-section-title' }, '📜 Historia własności i cen'));
    if (!transfers.length) {
      body.append(el('div', { className: 'farm-empty' }, 'Brak historii.'));
    } else {
      const list = el('div', { className: 'farm-nftx-hist' });
      transfers.slice().reverse().forEach(t => {
        const when = new Date(t.created_at).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
        let line;
        if (t.kind === 'mint') {
          line = el('span', {}, '✨ Wybito #' + t.serial_no + ' → ', el('b', {}, nm(t.to_owner)));
        } else if (t.kind === 'merge_fuel') {
          line = el('span', {}, '🔥 #' + t.serial_no + ' spalona przy fuzji przez ', el('b', {}, nm(t.from_owner)));
        } else if (t.kind === 'altar') {
          line = el('span', {}, '🕯️ #' + t.serial_no + ' złożona na ołtarzu przez ', el('b', {}, nm(t.from_owner)),
            el('span', { className: 'farm-nftx-price' }, t.price != null ? ' · ⭐×' + t.price : ''));
        } else if (t.kind === 'breed_parent') {
          line = el('span', {}, '🧬 #' + t.serial_no + ' poszła na krzyżowanie (', el('b', {}, nm(t.from_owner)), ')');
        } else if (t.kind === 'merge_hero') {
          line = el('span', {}, '⬆️ #' + t.serial_no + ' awansowała przez fuzję (', el('b', {}, nm(t.from_owner)), ')',
            el('span', { className: 'farm-nftx-price' }, t.price != null ? ' · koszt ' + t.price + ' 🪙' : ''));
        } else {
          line = el('span', {}, '🔁 #' + t.serial_no + ': ', el('b', {}, nm(t.from_owner)), ' → ', el('b', {}, nm(t.to_owner)),
            el('span', { className: 'farm-nftx-price' }, ' za ' + (t.price != null ? t.price + ' 🪙' : '—')));
        }
        list.append(el('div', { className: 'farm-nftx-hrow' }, line, el('span', { className: 'farm-nftx-when' }, when)));
      });
      body.append(list);
    }
  } catch (e) {
    console.error('nft explorer', e);
    body.replaceChildren(el('div', { className: 'farm-empty' }, 'Nie udało się wczytać edycji.'));
  }
}
