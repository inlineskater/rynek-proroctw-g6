// Lazy-loaded tab module — see ensureTabModule() in index.html.
// Owns its own top-level const/let; reads shared globals (me, el, showToast,
// headerCoins, setText, fmtDateTime, plCount, withTabModule, uiConfirm,
// uiPrompt) from index.html, which always runs first. Its function declarations
// overwrite index.html's no-op stubs (stopBankTimer) that switchTab()/doLogout()
// call unconditionally. It injects its own CSS (#bank-ui-css): index.html is
// under a hard payload budget.
'use strict';

// ── 🏦 Bank G6 ──────────────────────────────────────────────────────────────
// Redesigned 2026-10-23 in the Ogródek's spirit (owner's brief: "better, easier
// to understand, more like the Ogródek"): an illustrated bank front with three
// friendly numbers, big icon tiles instead of a tab bar, and every product as a
// card that says in one sentence what happens to your coins, with a calculator
// and progress bars instead of statement tables. Pages: 🏠 Pulpit · 🐷 Skarbonka ·
// 🔒 Lokata · 📜 Obligacje · 🤝 Kredyt (bank-loans.sql) · 📄 Wyciąg
// (bank-statement.sql) · 🏛️ RPP (bank-rpp-notes.sql) · 🔁 Rynek · ❓ Jak to działa.
// The 🎰 casino share was retired the same day (bank-casino-share-removed.sql).
//
// Every constant below mirrors supabase/bank.sql and exists ONLY to preview a
// number before you commit. The server is authoritative for anything that moves
// a coin; the client merely predicts. Keep them in sync.
const BANK_TERMS = [
  { days: 7,  bps: 500  },
  { days: 14, bps: 1200 },
  { days: 30, bps: 3000 },
];
const BANK_LOKATA_MIN = 500;
// ⚠️ Limits are DYNAMIC — recomputed daily by bank_ensure_limits() and served
// in bankState.caps / bankState.limits. These are fallbacks for a stale
// deployment only; never render them when the server sent a value.
const BANK_LOKATA_MAX = 15000;
const BANK_PIGGY_MAX = 3000;
const BANK_PIGGY_BPS = 60;        // per day, simple
const BANK_PIGGY_LOCK_DAYS = 7;
const BANK_PIGGY_MAX_DAYS = 90;   // accrual ceiling, mirrors bank_piggy_interest()
const BANK_SIGNET_PRICE = 15000;
const BANK_SIGNET_PCT = 2;
const BANK_SIGNET_CAP_FALLBACK = 20000;
function bankSignetCap()  { return Number(bankState?.signet?.cap ?? BANK_SIGNET_CAP_FALLBACK) || 0; }
function bankSignetPct()  { return Number(bankState?.signet?.pct ?? BANK_SIGNET_PCT); }
// The cap applies to the BASE, not to the payout, exactly as award_daily_interest().
function bankSignetDaily(base) {
  const cap = bankSignetCap();
  return Math.floor(Math.min(Number(base) || 0, cap || Infinity) * bankSignetPct() / 100);
}

const BANK_SECTIONS = [
  { id: 'home',      ic: '🏠', label: 'Pulpit' },
  { id: 'piggy',     ic: '🐷', label: 'Skarbonka' },
  { id: 'lokata',    ic: '🔒', label: 'Lokata' },
  { id: 'bonds',     ic: '📜', label: 'Obligacje' },
  { id: 'loan',      ic: '🤝', label: 'Kredyt' },
  { id: 'statement', ic: '📄', label: 'Wyciąg' },
  { id: 'rpp',       ic: '🏛️', label: 'RPP' },
  { id: 'market',    ic: '🔁', label: 'Rynek' },
  { id: 'help',      ic: '❓', label: 'Jak to działa' },
];

let bankState = null;
let bankLoan = null;          // bank_loan_state() — null before bank-loans.sql
let bankRpp = [];             // last bank_rpp_notes rows
let bankStmt = null;          // bank_statement() for bankStmtMonth
let bankStmtMonth = null;
let bankSection = 'home';
let bankTerm = 30;
let bankTimer = null;
let bankCountdowns = [];      // [{ node, until }] — refreshed by the 1s tick
let bankBusy = false;
let bankRefetching = false;

// ── CSS ─────────────────────────────────────────────────────────────────────
(function bankInjectCss() {
  if (document.getElementById('bank-ui-css')) return;
  const s = document.createElement('style');
  s.id = 'bank-ui-css';
  s.textContent = `
    .bq { max-width: 1100px; margin: 0 auto; color: var(--text); font-size: 13.5px; }
    .bq * { box-sizing: border-box; }
    .bq-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .bq-pos { color: #15803d; } .bq-neg { color: #b91c1c; }

    /* Hero: the bank front in a sunny sky, like the Ogródek's sky band. */
    .bq-hero { position: relative; overflow: hidden; border-radius: var(--r-lg); padding: 18px 18px 16px;
      background: linear-gradient(180deg, #bfe3ff 0%, #e6f4ff 55%, #f6efe0 56%, #efe4cc 100%);
      border: 1px solid #d6e6f5; box-shadow: var(--sh-md); }
    .bq-hero::after { content: ''; position: absolute; left: -10%; right: -10%; bottom: 0; height: 18px;
      background: repeating-linear-gradient(90deg, #d9c9a3 0 22px, #e4d6b4 22px 44px); opacity: .6; }
    .bq-cloud { position: absolute; top: 14px; width: 90px; height: 26px; border-radius: 20px; background: #fff; opacity: .85;
      animation: bqCloud 60s linear infinite; }
    .bq-cloud::before, .bq-cloud::after { content: ''; position: absolute; background: #fff; border-radius: 50%; }
    .bq-cloud::before { width: 38px; height: 38px; left: 14px; top: -18px; }
    .bq-cloud::after { width: 28px; height: 28px; left: 46px; top: -12px; }
    @keyframes bqCloud { from { transform: translateX(-140px); } to { transform: translateX(1200px); } }
    .bq-top { position: relative; z-index: 1; display: flex; gap: 18px; align-items: flex-end; flex-wrap: wrap; }
    .bq-building { flex: 0 0 auto; width: 150px; position: relative; padding-top: 34px; }
    .bq-building .roof { position: absolute; top: 0; left: -6px; right: -6px; height: 36px;
      clip-path: polygon(50% 0, 100% 100%, 0 100%); background: linear-gradient(180deg, #f8fafc, #dbe3ec); }
    .bq-building .sign { position: absolute; top: 18px; left: 0; right: 0; text-align: center; font-size: 10px;
      font-weight: 900; letter-spacing: .14em; color: #8a6d1d; }
    .bq-building .cols { height: 74px; border-top: 6px solid #cbd5e1;
      background: repeating-linear-gradient(90deg, #f1f5f9 0 14px, #cbd5e1 14px 16px, #f8fafc 16px 30px, #e2e8f0 30px 37px); }
    .bq-building .door { position: absolute; bottom: 10px; left: 50%; width: 26px; height: 36px; transform: translateX(-50%);
      background: #8a6d1d; border-radius: 13px 13px 0 0; box-shadow: inset 0 0 0 3px #b8932c; }
    .bq-building .steps { height: 10px; background: linear-gradient(180deg, #e2e8f0 0 50%, #cbd5e1 50%); margin: 0 -8px; }
    .bq-hello { flex: 1 1 260px; min-width: 0; padding-bottom: 4px; }
    .bq-hello h2 { margin: 0; font-size: 22px; color: #0f2a44; }
    .bq-hello p { margin: 4px 0 0; color: #36506b; font-size: 13px; line-height: 1.45; }
    .bq-mood { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; padding: 4px 10px; border-radius: 999px;
      font-size: 12px; font-weight: 600; background: rgba(255,255,255,.85); border: 1px solid #d6e6f5; color: #0f2a44; }
    .bq-stats { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px; margin-top: 14px; }
    .bq-stat { background: rgba(255,255,255,.92); border: 1px solid #e2e8f0; border-radius: 14px; padding: 10px 12px;
      box-shadow: 0 2px 10px rgba(15,23,42,.06); }
    .bq-stat .ic { font-size: 20px; }
    .bq-stat span { display: block; font-size: 11.5px; color: var(--muted); margin-top: 2px; }
    .bq-stat b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; margin-top: 1px; }
    .bq-stat small { display: block; font-size: 11px; color: var(--muted); }
    .bq-stat.warn { border-color: #f59e0b; background: #fffbeb; }

    /* Hub tiles */
    .bq-nav { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }
    .bq-tile { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px 8px;
      border-radius: 14px; border: 1px solid var(--border); background: var(--card); cursor: pointer; font: inherit;
      font-size: 11.5px; font-weight: 600; color: var(--text); box-shadow: var(--sh-sm); transition: transform .12s, box-shadow .12s; }
    .bq-tile .ic { font-size: 24px; line-height: 1; }
    .bq-tile:hover { transform: translateY(-2px); box-shadow: var(--sh-md); }
    .bq-tile.active { border-color: #b8932c; background: linear-gradient(180deg, #fffbeb, #fff); box-shadow: 0 0 0 2px rgba(184,147,44,.25); }
    .bq-badge { position: absolute; top: 4px; right: 6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
      background: #ef4444; color: #fff; font-size: 10.5px; line-height: 18px; text-align: center; }
    .bq-badge.ok { background: #16a34a; }
    @media (max-width: 760px) { .bq-nav { grid-template-columns: repeat(5, minmax(0, 1fr)); } }

    /* Cards */
    .bq-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
    .bq-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--r-lg); padding: 14px 16px;
      box-shadow: var(--sh-sm); min-width: 0; }
    .bq-card + .bq-card, .bq-card + .bq-grid, .bq-grid + .bq-card, .bq-grid + .bq-grid { margin-top: 12px; }
    .bq-card h3 { margin: 0 0 4px; font-size: 16px; display: flex; align-items: center; gap: 8px; }
    .bq-card h3 .ic { font-size: 22px; }
    .bq-card h4 { margin: 14px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .bq-pitch { margin: 0 0 10px; color: var(--muted); line-height: 1.5; }
    .bq-product { display: flex; flex-direction: column; gap: 8px; cursor: pointer; transition: transform .12s, box-shadow .12s; }
    .bq-product:hover { transform: translateY(-2px); box-shadow: var(--sh-md); }
    .bq-product .big { font-size: 34px; line-height: 1; }
    .bq-product .mine { font-size: 12.5px; padding: 7px 10px; border-radius: 10px; background: var(--surface); }
    .bq-product .mine b { font-variant-numeric: tabular-nums; }
    .bq-steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; margin: 6px 0 12px; }
    .bq-step { display: flex; gap: 8px; align-items: flex-start; padding: 9px 10px; border-radius: 12px; background: var(--surface);
      font-size: 12.5px; line-height: 1.4; }
    .bq-step .ic { font-size: 20px; flex: 0 0 auto; }
    .bq-alert { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 12px; margin-bottom: 12px;
      background: #ecfdf5; border: 1px solid #86efac; font-size: 13px; }
    .bq-alert.warn { background: #fffbeb; border-color: #fcd34d; }
    .bq-alert.bad { background: #fef2f2; border-color: #fca5a5; }
    .bq-alert .ic { font-size: 22px; }
    .bq-alert > div { flex: 1 1 auto; }

    /* Forms */
    .bq-picker { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 14px; background: var(--surface); }
    .bq-picker-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .bq-picker input[type=number] { width: 140px; min-height: 0; height: 38px; margin: 0; padding: 0 10px; font: inherit; font-size: 16px;
      font-weight: 700; border: 1px solid var(--border); border-radius: 10px; background: #fff; font-variant-numeric: tabular-nums; }
    .bq-picker input[type=range] { width: 100%; accent-color: #b8932c; }
    .bq-chip { padding: 6px 10px; border-radius: 999px; border: 1px solid var(--border); background: #fff; font: inherit; font-size: 12px; cursor: pointer; }
    .bq-chip:hover { border-color: #b8932c; }
    .bq-chip.on { border-color: #b8932c; background: #fffbeb; font-weight: 700; }
    .bq-preview { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
    .bq-preview div { padding: 8px 10px; border-radius: 10px; background: #fff; border: 1px solid var(--border); font-size: 12px; color: var(--muted); }
    .bq-preview b { display: block; font-size: 16px; color: var(--text); font-variant-numeric: tabular-nums; }
    .bq-go { align-self: flex-start; padding: 10px 18px; border: 0; border-radius: 12px; font: inherit; font-weight: 700; font-size: 14px;
      color: #fff; background: linear-gradient(180deg, #c9a43b, #a7821f); cursor: pointer; box-shadow: 0 2px 8px rgba(167,130,31,.35); }
    .bq-go:hover { filter: brightness(1.05); }
    .bq-go:disabled { opacity: .45; cursor: not-allowed; }
    .bq-ghost { padding: 7px 12px; border: 1px solid var(--border); border-radius: 10px; background: #fff; font: inherit;
      font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .bq-ghost:hover { border-color: #b8932c; } .bq-ghost:disabled { opacity: .45; cursor: not-allowed; }
    .bq-terms { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 10px 0; }
    .bq-term { padding: 9px 10px; border-radius: 12px; border: 1px dashed var(--border); font-size: 12px; color: var(--muted); }
    .bq-term b { display: block; color: var(--text); font-size: 14px; }
    .bq-choice { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 10px; }
    .bq-choice button { padding: 12px 8px; border-radius: 14px; border: 2px solid var(--border); background: var(--card); font: inherit;
      cursor: pointer; text-align: center; }
    .bq-choice button b { display: block; font-size: 20px; color: #a7821f; }
    .bq-choice button span { font-size: 12px; color: var(--muted); }
    .bq-choice button.on { border-color: #b8932c; background: #fffbeb; }

    /* Positions */
    .bq-pos-list { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    .bq-posi { display: flex; gap: 12px; align-items: center; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--border);
      background: var(--card); }
    .bq-posi .ic { font-size: 26px; flex: 0 0 auto; }
    .bq-posi .mid { flex: 1 1 auto; min-width: 0; }
    .bq-posi .mid b { font-size: 14px; }
    .bq-posi .mid small { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
    .bq-bar { height: 8px; border-radius: 99px; background: var(--surface); overflow: hidden; margin-top: 6px; }
    .bq-bar > i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, #f2c94c, #b8932c); }
    .bq-bar.green > i { background: linear-gradient(90deg, #86efac, #16a34a); }
    .bq-empty { padding: 16px; text-align: center; color: var(--muted); border-radius: 14px; border: 1px dashed var(--border); margin-top: 10px; }
    .bq-list-row { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .bq-list-row:last-child { border-bottom: 0; }
    .bq-list-row .grow { flex: 1 1 auto; min-width: 0; }
    .bq-list-row small { display: block; color: var(--muted); font-size: 11.5px; }

    /* Statement */
    .bq-hbar { display: grid; grid-template-columns: minmax(120px, 210px) 1fr auto; gap: 10px; align-items: center; padding: 5px 0; font-size: 13px; }
    .bq-hbar .track { height: 12px; border-radius: 99px; background: var(--surface); overflow: hidden; }
    .bq-hbar .track i { display: block; height: 100%; border-radius: 99px; }
    .bq-hbar.in .track i { background: linear-gradient(90deg, #86efac, #16a34a); }
    .bq-hbar.out .track i { background: linear-gradient(90deg, #fca5a5, #dc2626); }
    .bq-hbar.tr .track i { background: linear-gradient(90deg, #c7d2fe, #6366f1); }
    .bq-chart { width: 100%; height: 150px; display: block; }
    .bq-rank { display: inline-flex; gap: 8px; align-items: center; padding: 6px 12px; border-radius: 999px; background: #fffbeb;
      border: 1px solid #fcd34d; font-weight: 700; }

    /* RPP */
    .bq-gauge { display: flex; gap: 14px; align-items: center; }
    .bq-gauge svg { flex: 0 0 auto; }
    .bq-note { white-space: pre-line; line-height: 1.55; padding: 12px 14px; border-radius: 14px; background: var(--surface);
      border-left: 4px solid #b8932c; font-size: 13px; }
    .bq-note + .bq-note { margin-top: 8px; }
    .bq-note small { display: block; color: var(--muted); margin-bottom: 4px; }
    .bq details { border: 1px solid var(--border); border-radius: 14px; padding: 0 14px; background: var(--card); }
    .bq details + details { margin-top: 8px; }
    .bq summary { cursor: pointer; padding: 12px 0; font-weight: 700; list-style: none; }
    .bq summary::-webkit-details-marker { display: none; }
    .bq summary::before { content: '▸ '; color: #b8932c; }
    .bq details[open] summary::before { content: '▾ '; }
    .bq details p { margin: 0 0 12px; line-height: 1.55; color: var(--muted); }
    .bq table.bq-t { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 6px 0 12px; }
    .bq table.bq-t th, .bq table.bq-t td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; }
    .bq table.bq-t th { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
    .bq table.bq-t td.r, .bq table.bq-t th.r { text-align: right; font-variant-numeric: tabular-nums; }
    .bq-scroll { overflow-x: auto; }
    @media (max-width: 600px) {
      .bq-hero { padding: 14px 12px; }
      .bq-building { width: 110px; }
      .bq-hello h2 { font-size: 18px; }
      .bq-choice { grid-template-columns: 1fr; }
      .bq-hbar { grid-template-columns: 1fr auto; }
      .bq-hbar .track { grid-column: 1 / -1; grid-row: 2; }
    }
  `;
  document.head.appendChild(s);
})();

// ── formatting ──────────────────────────────────────────────────────────────
const bankFmt = n => Math.round(Number(n) || 0).toLocaleString('pl-PL');
const bankPct = bps => (Number(bps) / 100).toFixed(2).replace('.', ',') + '%';
const bankCoins = n => bankFmt(n) + ' 🪙';

function bankFmtLeft(untilMs) {
  if (!Number.isFinite(untilMs)) return '—';
  const ms = untilMs - Date.now();
  if (ms <= 0) return 'gotowe';
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins - days * 1440) / 60);
  if (days > 0) return `${days} ${plCount(days, 'dzień', 'dni', 'dni')}${hours ? ` ${hours} godz.` : ''}`;
  if (hours > 0) return `${hours} godz. ${mins - hours * 60} min`;
  return `${Math.max(1, mins)} min`;
}
function bankDate(ts) { return ts ? fmtDateTime(ts) : '—'; }
function bankDay(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pl-PL');
}

// ── lifecycle ───────────────────────────────────────────────────────────────
// Full teardown — switchTab()/doLogout() call this. startBankTimer() must NOT
// call it: render fills the countdown registry and the timer starts right after.
function stopBankTimer() {
  clearBankInterval();
  bankCountdowns = [];
}
function clearBankInterval() {
  if (bankTimer) { clearInterval(bankTimer); bankTimer = null; }
}
function startBankTimer() {
  clearBankInterval();
  bankTimer = setInterval(() => {
    let due = false;
    bankCountdowns.forEach(c => {
      const left = bankFmtLeft(c.until);
      if (c.node.textContent !== left) c.node.textContent = left;
      if (c.until <= Date.now()) due = true;
    });
    // Something just matured; the server settles lazily on read, so ask it —
    // guarded, or the tick queues one bank_state() per second while in flight.
    if (due && !bankRefetching) {
      bankRefetching = true;
      loadBank().finally(() => { bankRefetching = false; });
    }
  }, 1000);
}

async function loadBank() {
  const activationId = _tabActivationId;
  const body = document.getElementById('bank-body');
  if (!body) return;
  const [st, loan, rpp] = await Promise.all([
    sb.rpc('bank_state'),
    sb.rpc('bank_loan_state'),
    sb.from('bank_rpp_notes').select('note_date,body,posted_at').order('note_date', { ascending: false }).limit(7),
  ]);
  if (activeTab !== 'bank' || activationId !== _tabActivationId) return;
  if (st.error) {
    body.replaceChildren(el('div', { className: 'bq' }, el('div', { className: 'bq-empty' },
      'Bank G6 jest chwilowo niedostępny. (' + st.error.message + ')')));
    return;
  }
  bankState = st.data;
  bankLoan = loan.error ? null : loan.data;     // degrade if bank-loans.sql is missing
  bankRpp = rpp.error ? [] : (rpp.data || []);
  if (typeof bankState?.coins === 'number' && me) {
    me.coins = bankState.coins;
    if (headerCoins) setText(headerCoins, me.coins);
  }
  renderBank();
  startBankTimer();
  if (bankSection === 'statement') bankLoadStatement(bankStmtMonth);
}

// Every mutation funnels through here: one busy flag (no double-open), one
// error translation, one reload.
async function bankCall(fn, args, okMsg, btn) {
  if (bankBusy) return null;
  bankBusy = true;
  if (btn) btn.disabled = true;
  const { data, error } = await sb.rpc(fn, args || {});
  bankBusy = false;
  if (error) {
    const key = Object.keys(BANK_ERRORS).find(k => (error.message || '').includes(k));
    showToast('❌ ' + (BANK_ERRORS[key] || error.message));
    if (btn) btn.disabled = false;
    return null;
  }
  const coins = data?.coins_left ?? data?.coins;
  if (typeof coins === 'number' && me) { me.coins = coins; if (headerCoins) setText(headerCoins, me.coins); }
  if (okMsg) showToast(okMsg(data));
  await loadBank();
  return data;
}

const BANK_ERRORS = {
  insufficient_coins: 'Za mało monet w portfelu.',
  over_cap:           'To więcej niż dzisiejszy limit produktu.',
  amount_too_small:   `Najmniejsza kwota to ${bankCoins(BANK_LOKATA_MIN)}.`,
  bad_term:           'Nieprawidłowy okres.',
  bad_qty:            'Nieprawidłowa liczba sztuk.',
  sold_out:           'Emisja się wyczerpała.',
  no_open_series:     'Nie ma teraz otwartej emisji.',
  bond_user_limit:    'Masz już cały swój przydział z tej emisji.',
  not_for_sale:       'Ta oferta już zniknęła.',
  own_listing:        'To Twoja własna oferta.',
  bond_matured:       'Ta obligacja już zapadła.',
  deposit_not_found:  'Nie znaleziono depozytu.',
  holding_not_found:  'Nie znaleziono pozycji.',
  bad_price:          'Nieprawidłowa cena.',
  loan_above_median:  'Kredyt jest tylko dla graczy z majątkiem poniżej mediany biura.',
  loan_open_loan:     'Masz już kredyt — najpierw go spłać.',
  loan_tax_debt:      'Najpierw spłać zaległy podatek gruntowy.',
  loan_over_limit:    'To więcej niż Twój limit kredytu.',
  no_open_loan:       'Nie masz kredytu do spłaty.',
  bad_amount:         'Nieprawidłowa kwota.',
};

// ── small builders ──────────────────────────────────────────────────────────
function bqCard(ic, title, pitch) {
  const c = el('div', { className: 'bq-card' });
  if (title) c.append(el('h3', {}, el('span', { className: 'ic' }, ic || ''), title));
  if (pitch) c.append(el('p', { className: 'bq-pitch' }, pitch));
  return c;
}
function bqSteps(items) {
  const w = el('div', { className: 'bq-steps' });
  items.forEach(([ic, txt]) => w.append(el('div', { className: 'bq-step' }, el('span', { className: 'ic' }, ic), el('div', {}, txt))));
  return w;
}
function bqTerms(pairs) {
  const w = el('div', { className: 'bq-terms' });
  pairs.forEach(([label, value]) => w.append(el('div', { className: 'bq-term' }, label, el('b', {}, value))));
  return w;
}
function bqBar(pct, green) {
  const b = el('div', { className: 'bq-bar' + (green ? ' green' : '') });
  b.append(el('i', { style: { width: Math.max(0, Math.min(100, pct)) + '%' } }));
  return b;
}
function bqCountdown(until) {
  const span = el('span', { className: 'bq-num' }, bankFmtLeft(until));
  bankCountdowns.push({ node: span, until });
  return span;
}
function bqAlert(kind, ic, text, btnLabel, onClick) {
  const a = el('div', { className: 'bq-alert' + (kind ? ' ' + kind : '') }, el('span', { className: 'ic' }, ic), el('div', {}, text));
  if (btnLabel) { const b = el('button', { className: 'bq-ghost', type: 'button' }, btnLabel); b.addEventListener('click', onClick); a.append(b); }
  return a;
}
function bqGoTo(id) { bankSection = id; renderBank(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

// Amount picker: number input + slider + quick chips, all in sync.
// Returns { node, get value() }. onChange(value) fires on every move.
function bqAmountPicker({ min, max, step, start, onChange }) {
  const hi = Math.max(min, max);
  const input = el('input', { type: 'number', min: String(min), max: String(hi), step: String(step) });
  const range = el('input', { type: 'range', min: String(min), max: String(hi), step: String(step) });
  const v0 = Math.max(min, Math.min(hi, start ?? min));
  input.value = range.value = String(v0);
  const set = v => {
    const n = Math.max(0, Math.min(hi, Math.floor(Number(v) || 0)));
    input.value = String(n); range.value = String(Math.max(min, n));
    onChange && onChange(n);
  };
  input.addEventListener('input', () => { range.value = input.value; onChange && onChange(Math.floor(Number(input.value) || 0)); });
  range.addEventListener('input', () => set(range.value));
  const chips = el('div', { className: 'bq-picker-row' });
  [[0.25, '25%'], [0.5, '50%'], [1, 'Maks.']].forEach(([f, label]) => {
    const c = el('button', { className: 'bq-chip', type: 'button' }, label);
    c.addEventListener('click', () => set(Math.floor(hi * f / step) * step));
    chips.append(c);
  });
  const node = el('div', { className: 'bq-picker' },
    el('div', { className: 'bq-picker-row' }, input, el('span', { className: 'bq-num' }, '🪙 (maks. ' + bankFmt(hi) + ')')),
    range, chips);
  onChange && onChange(v0);
  return { node, get value() { return Math.floor(Number(input.value) || 0); } };
}

// ── portfolio arithmetic (display only; the server pays) ────────────────────
function bankPortfolio() {
  const deps = (bankState.deposits || []).filter(d => !d.closed_at);
  const holds = (bankState.holdings || []).filter(h => h.kind === 'bond');
  const lok = deps.filter(d => d.product === 'lokata');
  const pig = deps.filter(d => d.product === 'skarbonka');
  const sum = (a, f) => a.reduce((t, x) => t + Number(f(x) || 0), 0);
  const p = {
    lok, pig, bonds: holds,
    lokCap: sum(lok, d => d.principal), pigCap: sum(pig, d => d.principal),
    lokVal: sum(lok, d => d.mark), pigVal: sum(pig, d => d.mark),
    bondCap: sum(holds, h => h.face_value),
    bondVal: sum(holds, h => Number(h.face_value) + Number(h.accrued)),
    lokDay: Math.round(sum(lok, d => Number(d.interest_if_held) / Math.max(1, Number(d.term_days)))),
    pigDay: sum(pig, d => Math.floor(Number(d.principal) * BANK_PIGGY_BPS / 10000)),
    bondDay: sum(holds, h => h.coupon_per_day),
    ready: deps.filter(d => Date.parse(d.matures_at) <= Date.now()),
  };
  p.value = p.lokVal + p.pigVal + p.bondVal;
  p.perDay = p.lokDay + p.pigDay + p.bondDay;
  return p;
}
function bankLoanOpen() { return bankLoan?.loan || null; }

// ── shell ───────────────────────────────────────────────────────────────────
function renderBank() {
  const body = document.getElementById('bank-body');
  if (!body || !bankState) return;
  bankCountdowns = [];
  const p = bankPortfolio();
  const loan = bankLoanOpen();
  const root = el('div', { className: 'bq' });

  // Hero
  const L = bankState.limits;
  const health = L ? Number(L.health_bps) / 100 : null;
  const mood = health == null ? null
    : health >= 70 ? '🌤️ Gospodarka zdrowa'
    : health >= 40 ? '⛅ Gospodarka rozgrzana'
    : '🌧️ Wysoka inflacja — Bank ostrożny';
  const hero = el('div', { className: 'bq-hero' },
    el('div', { className: 'bq-cloud', style: { animationDelay: '-12s' } }),
    el('div', { className: 'bq-cloud', style: { top: '40px', animationDelay: '-40s', transform: 'scale(.7)' } }));
  const building = el('div', { className: 'bq-building', 'aria-hidden': 'true' },
    el('div', { className: 'roof' }), el('div', { className: 'sign' }, 'BANK G6'),
    el('div', { className: 'cols' }), el('div', { className: 'door' }), el('div', { className: 'steps' }));
  const hello = el('div', { className: 'bq-hello' },
    el('h2', {}, 'Dzień dobry, ' + (me?.nick || 'Graczu') + ' 👋'),
    el('p', {}, 'Tu Twoje monety pracują same: odkładasz, a Bank dopisuje odsetki. Wszystko wraca do Ciebie.'));
  if (mood) hello.append(el('span', { className: 'bq-mood', title: 'Kondycja gospodarki wg RPP G6' },
    mood + ' · ' + Math.round(health) + '%'));
  hero.append(el('div', { className: 'bq-top' }, building, hello));
  const stats = el('div', { className: 'bq-stats' },
    bqStat('💰', 'Gotówka', bankCoins(me?.coins), 'w portfelu'),
    bqStat('🏦', 'W Banku', bankCoins(p.value), p.value ? 'z narosłymi odsetkami' : 'jeszcze nic'),
    bqStat('📈', 'Zarabiasz dziennie', '+' + bankCoins(p.perDay), p.perDay ? 'z odsetek' : 'załóż pierwszą lokatę'));
  if (loan) stats.append(bqStat('🤝', 'Do spłaty', bankCoins(loan.outstanding),
    loan.overdue ? 'po terminie — spłata 100% sprzedaży' : 'spłata automatyczna', loan.overdue));
  hero.append(stats);
  root.append(hero);

  // Hub tiles
  const nav = el('div', { className: 'bq-nav' });
  BANK_SECTIONS.forEach(s => {
    const t = el('button', { className: 'bq-tile' + (s.id === bankSection ? ' active' : ''), type: 'button' },
      el('span', { className: 'ic' }, s.ic), s.label);
    const badge = bankBadge(s.id, p);
    if (badge) t.append(badge);
    t.addEventListener('click', () => { bankSection = s.id; renderBank(); if (s.id === 'statement') bankLoadStatement(bankStmtMonth); });
    nav.append(t);
  });
  root.append(nav);

  const panel = el('div', {});
  ({ home: bankHome, piggy: bankPiggy, lokata: bankLokata, bonds: bankBonds, loan: bankLoanPage,
     statement: bankStatementPage, rpp: bankRppPage, market: bankMarket, help: bankHelp }[bankSection] || bankHome)(panel, p);
  root.append(panel);
  body.replaceChildren(root);
}

function bqStat(ic, label, value, sub, warn) {
  return el('div', { className: 'bq-stat' + (warn ? ' warn' : '') },
    el('div', { className: 'ic' }, ic), el('span', {}, label), el('b', {}, value), sub ? el('small', {}, sub) : '');
}

function bankBadge(id, p) {
  const n = k => el('span', { className: 'bq-badge' + (k === 'ok' ? ' ok' : '') }, k === 'ok' ? '✓' : String(k));
  if (id === 'lokata') { const r = p.ready.filter(d => d.product === 'lokata').length; if (r) return n(r); }
  if (id === 'piggy') { const r = p.ready.filter(d => d.product === 'skarbonka').length; if (r) return n(r); }
  if (id === 'loan') { const l = bankLoanOpen(); if (l?.overdue) return n('!'); if (bankLoan?.eligible) return n('ok'); }
  if (id === 'market') { const m = (bankState.market || []).filter(h => !h.mine && h.kind === 'bond').length; if (m) return n(m); }
  return null;
}

// ── 🏠 Pulpit ───────────────────────────────────────────────────────────────
function bankHome(panel, p) {
  // Things waiting for the player come first.
  p.ready.forEach(d => panel.append(bqAlert('', d.product === 'lokata' ? '🔒' : '🐷',
    d.product === 'lokata'
      ? `Lokata ${d.term_days}-dniowa jest gotowa — odbierz ${bankCoins(Number(d.principal) + Number(d.interest_if_held))}.`
      : `Skarbonka przeszła karencję — możesz wypłacić z odsetkami (${bankCoins(d.interest_if_held)}).`,
    'Odbierz →', () => bqGoTo(d.product === 'lokata' ? 'lokata' : 'piggy'))));
  const loan = bankLoanOpen();
  if (loan?.overdue) panel.append(bqAlert('bad', '🤝',
    `Kredyt jest po terminie — do spłaty ${bankCoins(loan.outstanding)}. Każda sprzedaż plonów idzie teraz w całości na spłatę.`,
    'Spłać →', () => bqGoTo('loan')));

  const grid = el('div', { className: 'bq-grid' });
  const prod = (id, big, title, pitch, mineTxt) => {
    const c = el('div', { className: 'bq-card bq-product', role: 'button', tabindex: '0' },
      el('div', { className: 'big' }, big), el('h3', {}, title), el('p', { className: 'bq-pitch' }, pitch),
      el('div', { className: 'mine' }, mineTxt));
    c.addEventListener('click', () => bqGoTo(id));
    c.addEventListener('keydown', e => { if (e.key === 'Enter') bqGoTo(id); });
    return c;
  };
  grid.append(
    prod('piggy', '🐷', 'Skarbonka', 'Odkładasz kiedy chcesz, rośnie codziennie, wypłacasz kiedy chcesz.',
      p.pig.length ? el('span', {}, 'Masz ', el('b', {}, bankCoins(p.pigVal)), ' · +' + bankCoins(p.pigDay) + '/dzień') : 'Pusta — dobry start.'),
    prod('lokata', '🔒', 'Lokata', 'Zamrażasz monety na 7, 14 albo 30 dni i dostajesz z góry znany zysk.',
      p.lok.length ? el('span', {}, el('b', {}, String(p.lok.length)), ' ' + plCount(p.lok.length, 'lokata', 'lokaty', 'lokat') + ' · ' + bankCoins(p.lokCap)) : 'Brak lokat.'),
    prod('bonds', '📜', 'Obligacje', 'Kupujesz papier, który codziennie wypłaca kupon, a na końcu oddaje całą cenę.',
      p.bonds.length ? el('span', {}, el('b', {}, String(p.bonds.length)), ' szt. · +' + bankCoins(p.bondDay) + '/dzień') : 'Brak obligacji.'),
    prod('loan', '🤝', 'Kredyt dla rolnika', 'Pożyczka dla tych, którzy dopiero się rozkręcają. Spłaca się sama ze sprzedaży plonów.',
      loan ? el('span', {}, 'Do spłaty ', el('b', {}, bankCoins(loan.outstanding)))
        : bankLoan?.eligible ? el('span', {}, 'Możesz pożyczyć do ', el('b', {}, bankCoins(bankLoan.limit)))
        : 'Dla graczy poniżej mediany majątku.'));
  panel.append(grid);

  // Latest RPP communiqué
  if (bankRpp[0]) {
    const c = bqCard('🏛️', 'Ostatni komunikat RPP G6');
    c.append(el('div', { className: 'bq-note' }, el('small', {}, bankDay(bankRpp[0].note_date)), bankRpp[0].body));
    const more = el('button', { className: 'bq-ghost', type: 'button', style: { marginTop: '8px' } }, 'Wszystkie komunikaty →');
    more.addEventListener('click', () => bqGoTo('rpp'));
    c.append(more);
    panel.append(c);
  }

  // Recent settlements
  const ops = [
    ...(bankState.dividends || []).filter(d => d.kind !== 'share').map(d => ({ day: d.pay_date, ic: '📜', title: 'Kupon obligacji', amount: Number(d.amount || 0) })),
    ...(bankState.deposits || []).filter(d => d.closed_at).map(d => ({ day: d.closed_at, ic: d.product === 'lokata' ? '🔒' : '🐷',
      title: d.product === 'lokata' ? `Lokata ${d.term_days} dni${d.broke_early ? ' (zerwana)' : ''}` : 'Skarbonka — wypłata',
      amount: Number(d.interest || 0) })),
  ].sort((a, b) => String(b.day).localeCompare(String(a.day))).slice(0, 8);
  const hist = bqCard('🧾', 'Ostatnie wypłaty odsetek');
  if (!ops.length) hist.append(el('div', { className: 'bq-empty' }, 'Jeszcze nic — pierwsze odsetki pojawią się tutaj.'));
  ops.forEach(o => hist.append(el('div', { className: 'bq-list-row' }, el('span', {}, o.ic),
    el('div', { className: 'grow' }, o.title, el('small', {}, bankDay(o.day))),
    el('b', { className: o.amount > 0 ? 'bq-pos bq-num' : 'bq-num' }, o.amount > 0 ? '+' + bankCoins(o.amount) : '—'))));
  panel.append(hist);
  panel.append(bankSignetCard());
}

// ── 🐷 Skarbonka ────────────────────────────────────────────────────────────
function bankPiggy(panel) {
  const cap = Number(bankState.caps?.piggy_max) || BANK_PIGGY_MAX;
  const free = Math.max(0, cap - Number(bankState.caps?.piggy_open || 0));
  const c = bqCard('🐷', 'Skarbonka', 'Najprostszy sposób, żeby monety zarabiały. Bez terminu i bez ryzyka — zawsze odzyskasz to, co wpłaciłeś.');
  c.append(bqSteps([
    ['💰', 'Wpłacasz dowolną kwotę (do dzisiejszego limitu).'],
    ['📈', `Co dzień przybywa ${bankPct(BANK_PIGGY_BPS)} odsetek.`],
    ['🔓', `Po ${BANK_PIGGY_LOCK_DAYS} dniach wypłacasz z zyskiem. Wcześniej — sam kapitał.`],
  ]));
  const room = Math.min(free, Math.floor(Number(me?.coins) || 0));
  if (room < BANK_LOKATA_MIN) {
    c.append(el('div', { className: 'bq-empty' }, free < BANK_LOKATA_MIN
      ? `Dzisiejszy limit skarbonki (${bankCoins(cap)}) jest wykorzystany. Jutro RPP ustali nowy.`
      : `Potrzebujesz co najmniej ${bankCoins(BANK_LOKATA_MIN)} w portfelu.`));
  } else {
    const prev = el('div', { className: 'bq-preview' });
    const pick = bqAmountPicker({ min: BANK_LOKATA_MIN, max: room, step: 100, start: Math.min(room, 1000), onChange: a => {
      const d = Math.floor(a * BANK_PIGGY_BPS / 10000);
      prev.replaceChildren(
        el('div', {}, 'Za tydzień', el('b', { className: 'bq-pos' }, '+' + bankCoins(d * 7))),
        el('div', {}, 'Za miesiąc', el('b', { className: 'bq-pos' }, '+' + bankCoins(d * 30))),
        el('div', {}, 'Dziennie', el('b', {}, '+' + bankCoins(d))));
    } });
    const go = el('button', { className: 'bq-go', type: 'button' }, '🐷 Wrzuć do skarbonki');
    go.addEventListener('click', () => bankCall('bank_open_deposit', { p_product: 'skarbonka', p_amount: pick.value },
      () => '🐷 Wrzucono do skarbonki!', go));
    pick.node.append(prev, go);
    c.append(pick.node);
  }
  c.append(bqTerms([['Limit na dziś', bankCoins(cap)], ['Wolne', bankCoins(free)], ['Odsetki', bankPct(BANK_PIGGY_BPS) + ' / dzień'], ['Naliczanie', `do ${BANK_PIGGY_MAX_DAYS} dni`]]));
  c.append(el('h4', {}, 'Twoje skarbonki'), bankDepositList('skarbonka'));
  panel.append(c);
}

// ── 🔒 Lokata ───────────────────────────────────────────────────────────────
function bankLokata(panel) {
  const cap = Number(bankState.caps?.lokata_max) || BANK_LOKATA_MAX;
  const free = Math.max(0, cap - Number(bankState.caps?.lokata_open || 0));
  const term = BANK_TERMS.find(t => t.days === bankTerm) || BANK_TERMS[2];
  const c = bqCard('🔒', 'Lokata', 'Zamrażasz monety na wybrany czas, a Bank z góry mówi, ile dostaniesz. Im dłużej, tym więcej.');
  const choice = el('div', { className: 'bq-choice' });
  BANK_TERMS.forEach(t => {
    const b = el('button', { className: t.days === bankTerm ? 'on' : '', type: 'button' },
      el('b', {}, '+' + bankPct(t.bps).replace(',00', '')), el('span', {}, t.days + ' dni'));
    b.addEventListener('click', () => { bankTerm = t.days; renderBank(); });
    choice.append(b);
  });
  c.append(choice);
  const room = Math.min(free, Math.floor(Number(me?.coins) || 0));
  if (room < BANK_LOKATA_MIN) {
    c.append(el('div', { className: 'bq-empty' }, free < BANK_LOKATA_MIN
      ? `Dzisiejszy limit lokat (${bankCoins(cap)}) jest wykorzystany. Jutro RPP ustali nowy.`
      : `Potrzebujesz co najmniej ${bankCoins(BANK_LOKATA_MIN)} w portfelu.`));
  } else {
    const prev = el('div', { className: 'bq-preview' });
    const pick = bqAmountPicker({ min: BANK_LOKATA_MIN, max: room, step: 100, start: room, onChange: a => {
      const i = Math.floor(a * term.bps / 10000);
      const when = new Date(Date.now() + term.days * 86400000);
      prev.replaceChildren(
        el('div', {}, 'Wpłacasz', el('b', {}, bankCoins(a))),
        el('div', {}, 'Dostaniesz ' + when.toLocaleDateString('pl-PL'), el('b', { className: 'bq-pos' }, bankCoins(a + i))),
        el('div', {}, 'Zysk', el('b', { className: 'bq-pos' }, '+' + bankCoins(i))));
    } });
    const go = el('button', { className: 'bq-go', type: 'button' }, `🔒 Załóż lokatę na ${term.days} dni`);
    go.addEventListener('click', () => bankCall('bank_open_deposit',
      { p_product: 'lokata', p_amount: pick.value, p_term_days: bankTerm },
      d => `🔒 Lokata założona — odbiór ${bankDate(d.matures_at)}.`, go));
    pick.node.append(prev, go);
    c.append(pick.node);
  }
  c.append(bqTerms([['Limit na dziś', bankCoins(cap)], ['Wolne', bankCoins(free)], ['Zerwanie przed terminem', 'zwrot kapitału, bez odsetek']]));
  c.append(el('h4', {}, 'Twoje lokaty'), bankDepositList('lokata'));
  panel.append(c);
}

function bankDepositList(product) {
  const rows = (bankState.deposits || []).filter(d => d.product === product && !d.closed_at);
  const isLok = product === 'lokata';
  if (!rows.length) return el('div', { className: 'bq-empty' }, isLok ? 'Nie masz jeszcze lokat.' : 'Skarbonka jest pusta.');
  const list = el('div', { className: 'bq-pos-list' });
  rows.forEach(d => {
    const opened = Date.parse(d.opened_at), until = Date.parse(d.matures_at);
    const ready = until <= Date.now();
    const pct = ready ? 100 : (Date.now() - opened) / Math.max(1, until - opened) * 100;
    const btn = el('button', { className: ready ? 'bq-go' : 'bq-ghost', type: 'button' },
      ready ? 'Odbierz' : (isLok ? 'Zerwij' : 'Rozbij'));
    btn.addEventListener('click', async () => {
      if (!ready && !(await uiConfirm(isLok
        ? `Zerwanie przed terminem: odsetki (${bankCoins(d.interest_if_held)}) przepadną, dostaniesz ${bankCoins(d.principal)}. Kontynuować?`
        : `Skarbonka nie ma jeszcze ${BANK_PIGGY_LOCK_DAYS} dni — odsetki przepadną. Rozbić?`,
        { okLabel: isLok ? 'Zerwij lokatę' : 'Rozbij', danger: true }))) return;
      bankCall('bank_close_deposit', { p_id: d.id },
        r => r.interest > 0 ? `💰 Wypłacono ${bankCoins(r.principal + r.interest)} (w tym +${bankCoins(r.interest)}).`
                            : `Zwrócono ${bankCoins(r.principal)}.`, btn);
    });
    const mid = el('div', { className: 'mid' },
      el('b', {}, bankCoins(d.principal)),
      ' ', isLok ? `→ ${bankCoins(Number(d.principal) + Number(d.interest_if_held))}` : `· +${bankCoins(d.interest_if_held)} odsetek`,
      el('small', {}, ready ? (isLok ? '✅ Gotowa do odbioru' : '✅ Odsetki odblokowane')
        : el('span', {}, (isLok ? 'Do odbioru: ' : 'Odblokowanie odsetek za: '), bqCountdown(until))),
      bqBar(pct, ready));
    list.append(el('div', { className: 'bq-posi' }, el('span', { className: 'ic' }, isLok ? '🔒' : '🐷'), mid, btn));
  });
  return list;
}

// ── 📜 Obligacje ────────────────────────────────────────────────────────────
function bankBonds(panel) {
  const ser = bankState.series;
  const c = bqCard('📜', 'Obligacje G6', 'Kupujesz obligację za jej cenę. Codziennie dostajesz kupon, a w dniu wykupu Bank oddaje całą cenę. Możesz ją też sprzedać innemu graczowi.');
  if (ser) {
    const total = Number(ser.coupon_per_day) * Number(ser.term_days);
    c.append(bqTerms([
      ['Emisja', ser.code], ['Cena', bankCoins(ser.price)],
      ['Kupon', '+' + bankCoins(ser.coupon_per_day) + ' / dzień'],
      ['Łącznie zarobisz', '+' + bankCoins(total) + ` w ${ser.term_days} dni`]]));
    c.append(el('div', { style: { fontSize: '12px', color: 'var(--muted)' } }, `Sprzedano ${ser.sold} z ${ser.edition_size} sztuk · zapisy do ${bankDate(ser.closes_at)}`),
      bqBar(ser.sold / Math.max(1, ser.edition_size) * 100));
    const left = Math.max(0, Number(ser.edition_size) - Number(ser.sold));
    const mine = Number(ser.mine || 0);
    const allowance = Math.max(0, Math.min(ser.open_to_all ? left : Number(ser.per_user || 1) - mine, left, 10));
    c.append(el('p', { className: 'bq-pitch', style: { marginTop: '8px' } }, ser.open_to_all
      ? `Ostatnie dni emisji — przydziały zniesione, zostało ${left} szt. dla każdego.`
      : `Twój przydział z tej emisji: ${ser.per_user} szt. (masz ${mine}). Emisja dzieli się po równo między aktywnych graczy.`));
    if (allowance > 0) {
      const box = el('div', { className: 'bq-picker' });
      let qty = 1;
      const prev = el('div', { className: 'bq-preview' });
      const row = el('div', { className: 'bq-picker-row' });
      const draw = () => {
        row.replaceChildren(...Array.from({ length: allowance }, (_, i) => {
          const b = el('button', { className: 'bq-chip' + (i + 1 === qty ? ' on' : ''), type: 'button' }, String(i + 1) + ' szt.');
          b.addEventListener('click', () => { qty = i + 1; draw(); });
          return b;
        }));
        prev.replaceChildren(
          el('div', {}, 'Płacisz', el('b', {}, bankCoins(qty * ser.price))),
          el('div', {}, 'Kupon dziennie', el('b', { className: 'bq-pos' }, '+' + bankCoins(qty * ser.coupon_per_day))),
          el('div', {}, 'Na koniec wraca', el('b', {}, bankCoins(qty * ser.face_value))));
      };
      draw();
      const go = el('button', { className: 'bq-go', type: 'button' }, '📜 Kup obligacje');
      go.addEventListener('click', () => bankCall('bank_buy_bond', { p_qty: qty }, d => `📜 Kupiono ${d.qty} × ${ser.code}.`, go));
      box.append(row, prev, go);
      c.append(box);
    } else {
      c.append(el('div', { className: 'bq-empty' }, mine > 0 ? 'Masz już cały swój przydział z tej emisji.' : 'Emisja się wyczerpała.'));
    }
  } else {
    c.append(el('div', { className: 'bq-empty' }, 'Bieżąca emisja się wyczerpała. Kolejna otwiera się w przyszłym tygodniu.'));
  }
  c.append(el('h4', {}, 'Twoje obligacje'));
  const rows = (bankState.holdings || []).filter(h => h.kind === 'bond');
  if (!rows.length) c.append(el('div', { className: 'bq-empty' }, 'Nie masz jeszcze obligacji.'));
  else {
    const list = el('div', { className: 'bq-pos-list' });
    rows.forEach(h => {
      const act = h.ask_price
        ? (() => { const b = el('button', { className: 'bq-ghost', type: 'button' }, 'Wycofaj z rynku');
                   b.addEventListener('click', () => bankCall('bank_unlist_holding', { p_id: h.id }, () => 'Wycofano z rynku.', b)); return b; })()
        : (() => { const b = el('button', { className: 'bq-ghost', type: 'button' }, 'Sprzedaj');
                   b.addEventListener('click', () => bankListPrompt(h, b)); return b; })();
      list.append(el('div', { className: 'bq-posi' }, el('span', { className: 'ic' }, '📜'),
        el('div', { className: 'mid' }, el('b', {}, (h.series_code || 'Obligacja') + ' · ' + bankCoins(h.face_value)),
          el('small', {}, '+' + bankCoins(h.coupon_per_day) + '/dzień · naliczone ' + bankCoins(h.accrued) + ' · wykup za ',
            bqCountdown(Date.parse(h.matures_at)), h.ask_price ? ' · wystawiona za ' + bankCoins(h.ask_price) : '')),
        act));
    });
    c.append(list);
  }
  panel.append(c);
}

async function bankListPrompt(h, btn) {
  const fair = Number(h.face_value) + Number(h.accrued);
  const raw = await uiPrompt(`Za ile wystawiasz obligację? Pierwszy chętny kupuje od razu.\nUczciwa wartość: ${bankFmt(fair)} 🪙 (cena + naliczony kupon).`,
    String(fair), { okLabel: 'Wystaw' });
  if (raw === null) return;
  const price = Math.floor(Number(raw) || 0);
  if (price < 1) { showToast('❌ Nieprawidłowa cena.'); return; }
  bankCall('bank_list_holding', { p_id: h.id, p_price: price }, () => `Wystawiono za ${bankCoins(price)}.`, btn);
}

// ── 🤝 Kredyt ───────────────────────────────────────────────────────────────
function bankLoanPage(panel) {
  const c = bqCard('🤝', 'Kredyt dla rolnika',
    'Pożyczka dla tych, którzy dopiero się rozkręcają — na ulepszenie kart, skrzynki czy działkę. Spłaca się sama z Twojej sprzedaży plonów.');
  if (!bankLoan) {
    c.append(el('div', { className: 'bq-empty' }, 'Kredyt nie jest jeszcze dostępny.'));
    panel.append(c);
    return;
  }
  const L = bankLoan;
  const fee = Number(L.fee_rate || 0.1);
  c.append(bqSteps([
    ['👥', `Tylko dla graczy z majątkiem poniżej mediany biura (dziś ${bankCoins(L.median)}). Najbogatsi nie mogą pożyczać.`],
    ['🧮', `Limit = ${L.income_days} dni Twoich zarobków z farmy i ogrodu, od ${bankCoins(L.min_limit)} do ${bankCoins(L.max_limit)}.`],
    ['💸', `Jednorazowa opłata ${Math.round(fee * 100)}%. Żadnych odsetek, które rosną — dług nigdy się nie powiększa.`],
    ['🔁', `Spłata automatyczna: ${Math.round(L.share_before_due * 100)}% każdej sprzedaży plonów i zamówień przez ${L.term_days} dni, potem ${Math.round(L.share_after_due * 100)}%.`],
  ]));
  const loan = L.loan;
  if (loan) {
    const total = Number(loan.principal) + Number(loan.fee);
    const pct = (Number(loan.repaid) / Math.max(1, total)) * 100;
    if (loan.overdue) c.append(bqAlert('bad', '⏰', 'Kredyt jest po terminie — każda sprzedaż plonów idzie teraz w całości na spłatę.'));
    c.append(el('div', { className: 'bq-posi' }, el('span', { className: 'ic' }, '🤝'),
      el('div', { className: 'mid' }, el('b', {}, 'Do spłaty ' + bankCoins(loan.outstanding)),
        el('small', {}, `Spłacono ${bankCoins(loan.repaid)} z ${bankCoins(total)} · termin `,
          loan.overdue ? 'minął' : bqCountdown(Date.parse(loan.due_at))),
        bqBar(pct, true))));
    const room = Math.min(Number(loan.outstanding), Math.floor(Number(me?.coins) || 0));
    if (room >= 1) {
      const pick = bqAmountPicker({ min: 1, max: room, step: 1, start: room });
      const go = el('button', { className: 'bq-go', type: 'button' }, '💸 Spłać teraz');
      go.addEventListener('click', () => bankCall('bank_loan_repay', { p_amount: pick.value },
        r => r.loan ? `Spłacono ${bankCoins(r.paid)}. Zostało ${bankCoins(r.loan.outstanding)}.` : `🎉 Kredyt spłacony w całości!`, go));
      pick.node.append(go);
      c.append(el('h4', {}, 'Spłać szybciej z portfela'), pick.node);
    }
  } else if (L.eligible) {
    const prev = el('div', { className: 'bq-preview' });
    const pick = bqAmountPicker({ min: 1000, max: Number(L.limit), step: 500, start: Number(L.limit), onChange: a => {
      const f = Math.ceil(a * fee);
      prev.replaceChildren(
        el('div', {}, 'Dostajesz teraz', el('b', { className: 'bq-pos' }, bankCoins(a))),
        el('div', {}, 'Oddajesz razem', el('b', {}, bankCoins(a + f))),
        el('div', {}, 'Opłata', el('b', {}, bankCoins(f))));
    } });
    const go = el('button', { className: 'bq-go', type: 'button' }, '🤝 Weź kredyt');
    go.addEventListener('click', async () => {
      const a = pick.value;
      if (!(await uiConfirm(`Pożyczasz ${bankCoins(a)} i oddasz ${bankCoins(a + Math.ceil(a * fee))}. `
        + `Spłata pójdzie automatycznie z Twojej sprzedaży plonów. Kontynuować?`, { okLabel: 'Biorę kredyt' }))) return;
      bankCall('bank_loan_take', { p_amount: a }, r => `🤝 Wypłacono ${bankCoins(r.principal)}. Powodzenia na farmie!`, go);
    });
    pick.node.append(prev, go);
    c.append(el('h4', {}, `Możesz pożyczyć do ${bankCoins(L.limit)}`), pick.node);
  } else {
    const why = {
      above_median: `Twój majątek (${bankCoins(L.net_worth)}) jest powyżej mediany biura (${bankCoins(L.median)}) — kredyt jest dla tych, którzy gonią resztę.`,
      tax_debt: 'Masz zaległy podatek gruntowy — najpierw go spłać.',
      open_loan: 'Masz już otwarty kredyt.',
    }[L.reason] || 'Kredyt jest teraz niedostępny.';
    c.append(bqAlert('warn', 'ℹ️', why));
  }
  const hist = L.history || [];
  if (hist.length) {
    c.append(el('h4', {}, 'Spłacone kredyty'));
    hist.forEach(h => c.append(el('div', { className: 'bq-list-row' }, el('span', {}, '✅'),
      el('div', { className: 'grow' }, bankCoins(h.principal) + ' (opłata ' + bankCoins(h.fee) + ')',
        el('small', {}, bankDay(h.opened_at) + ' → ' + bankDay(h.closed_at))))));
  }
  panel.append(c);
}

// ── 📄 Wyciąg ───────────────────────────────────────────────────────────────
async function bankLoadStatement(month) {
  const { data, error } = await sb.rpc('bank_statement', month ? { p_month: month } : {});
  if (activeTab !== 'bank' || bankSection !== 'statement') return;
  bankStmt = error ? { error: error.message } : data;
  bankStmtMonth = data?.month || month || null;
  renderBank();
}

function bankStatementPage(panel) {
  const c = bqCard('📄', 'Wyciąg miesięczny', 'Twój miesiąc w jednym miejscu: skąd przyszły monety, na co poszły i jak wypadasz na tle biura.');
  const s = bankStmt;
  if (!s) { c.append(el('div', { className: 'loading-center' }, el('div', { className: 'spinner' }))); panel.append(c); return; }
  if (s.error) { c.append(el('div', { className: 'bq-empty' }, 'Wyciąg jest chwilowo niedostępny.')); panel.append(c); return; }

  const months = s.months || [];
  const MN = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
  const mLabel = m => { const d = new Date(m + 'T12:00:00'); return MN[d.getMonth()] + ' ' + d.getFullYear(); };
  const chips = el('div', { className: 'bq-picker-row', style: { marginBottom: '10px' } });
  months.slice(0, 6).forEach(m => {
    const b = el('button', { className: 'bq-chip' + (m === s.month ? ' on' : ''), type: 'button' }, mLabel(m));
    b.addEventListener('click', () => { bankStmt = null; renderBank(); bankLoadStatement(m); });
    chips.append(b);
  });
  c.append(chips);

  const income = Number(s.income || 0), spending = Number(s.spending || 0), casino = Number(s.casino || 0);
  const result = income - spending + casino;
  c.append(el('div', { className: 'bq-stats', style: { marginTop: '0' } },
    bqStat('⬆️', 'Przychody', '+' + bankCoins(income)),
    bqStat('⬇️', 'Wydatki', '−' + bankCoins(spending)),
    bqStat('🎰', 'Gry hazardowe', (casino >= 0 ? '+' : '−') + bankCoins(Math.abs(casino)), s.casino_rounds ? s.casino_rounds + ' rozgrywek' : 'nie grano'),
    bqStat(result >= 0 ? '🏆' : '📉', 'Wynik miesiąca', (result >= 0 ? '+' : '−') + bankCoins(Math.abs(result)))));
  if (s.rank) c.append(el('div', { style: { marginTop: '10px' } },
    el('span', { className: 'bq-rank' }, (s.rank <= 3 ? ['🥇', '🥈', '🥉'][s.rank - 1] : '🏅') + ` ${s.rank}. miejsce z ${s.players} w biurze`)));

  // Daily cumulative chart
  const days = s.days || [];
  if (days.length > 1) {
    let acc = 0;
    const pts = days.map(d => { acc += Number(d.net || 0); return acc; });
    const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), W = 600, H = 150, pad = 8;
    const x = i => pad + i / (pts.length - 1) * (W - 2 * pad);
    const y = v => H - pad - (v - lo) / Math.max(1, hi - lo) * (H - 2 * pad);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'bq-chart'); svg.setAttribute('preserveAspectRatio', 'none');
    const zero = document.createElementNS(ns, 'line');
    zero.setAttribute('x1', pad); zero.setAttribute('x2', W - pad); zero.setAttribute('y1', y(0)); zero.setAttribute('y2', y(0));
    zero.setAttribute('stroke', '#cbd5e1'); zero.setAttribute('stroke-dasharray', '4 4');
    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', 'M' + x(0) + ',' + y(0) + ' ' + pts.map((v, i) => 'L' + x(i) + ',' + y(v)).join(' ') + ' L' + x(pts.length - 1) + ',' + y(0) + 'Z');
    area.setAttribute('fill', acc >= 0 ? 'rgba(22,163,74,.12)' : 'rgba(220,38,38,.12)');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts.map((v, i) => x(i) + ',' + y(v)).join(' '));
    line.setAttribute('fill', 'none'); line.setAttribute('stroke', acc >= 0 ? '#16a34a' : '#dc2626'); line.setAttribute('stroke-width', '2.5');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(zero, area, line);
    c.append(el('h4', {}, 'Saldo miesiąca dzień po dniu'), svg);
  }

  // Bars per category
  const lines = s.lines || [];
  const group = (g, title, cls) => {
    const rows = lines.filter(l => l.group === g);
    if (!rows.length) return;
    const max = Math.max(...rows.map(l => Math.abs(Number(l.amount))));
    c.append(el('h4', {}, title));
    rows.forEach(l => {
      const a = Number(l.amount);
      c.append(el('div', { className: 'bq-hbar ' + cls }, el('span', {}, l.label),
        el('div', { className: 'track' }, el('i', { style: { width: (Math.abs(a) / Math.max(1, max) * 100) + '%' } })),
        el('b', { className: 'bq-num ' + (a >= 0 ? 'bq-pos' : 'bq-neg') }, (a >= 0 ? '+' : '−') + bankCoins(Math.abs(a)))));
    });
  };
  group('income', 'Skąd przyszły monety', 'in');
  group('spending', 'Na co poszły', 'out');
  group('transfer', 'Przesunięcia w Banku (nie zmieniają majątku)', 'tr');

  const top = s.top || [];
  if (top.length) {
    c.append(el('h4', {}, 'Największe wpływy'));
    top.forEach(t => c.append(el('div', { className: 'bq-list-row' }, el('span', {}, '⭐'),
      el('div', { className: 'grow' }, t.label, el('small', {}, bankDate(t.created_at))),
      el('b', { className: 'bq-pos bq-num' }, '+' + bankCoins(t.amount)))));
  }
  panel.append(c);
}

// ── 🏛️ RPP ──────────────────────────────────────────────────────────────────
function bankRppPage(panel) {
  const L = bankState.limits;
  const c = bqCard('🏛️', 'Rada Polityki Pieniężnej G6',
    'Codziennie rano RPP sprawdza, jak szybko w grze przybywa monet, i ustala limity Banku. Gdy inflacja rośnie — przykręca, gdy spada — luzuje. Komunikat trafia też na czat.');
  if (L) {
    const h = Math.max(0, Math.min(100, Number(L.health_bps) / 100));
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '120'); svg.setAttribute('height', '70'); svg.setAttribute('viewBox', '0 0 120 70');
    const arc = (pct, color, w) => {
      const a = Math.PI * (1 - pct / 100), r = 50, cx = 60, cy = 62;
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r * Math.cos(a)} ${cy - r * Math.sin(a)}`);
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', color); p.setAttribute('stroke-width', w); p.setAttribute('stroke-linecap', 'round');
      return p;
    };
    svg.append(arc(100, '#e2e8f0', 10), arc(Math.max(1, h), h >= 70 ? '#16a34a' : h >= 40 ? '#f59e0b' : '#dc2626', 10));
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', '60'); t.setAttribute('y', '58'); t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', '18'); t.setAttribute('font-weight', '800'); t.setAttribute('fill', '#0f172a');
    t.textContent = Math.round(h) + '%';
    svg.append(t);
    c.append(el('div', { className: 'bq-gauge' }, svg, el('div', {},
      el('b', {}, 'Kondycja gospodarki'),
      el('div', { style: { color: 'var(--muted)', fontSize: '12.5px', lineHeight: '1.5' } },
        `W grze przybywa ${bankCoins(L.net_mint_day)} dziennie (${(Number(L.inflation_bps) / 100).toFixed(2).replace('.', ',')}% wszystkich monet). `
        + (h >= 70 ? 'To spokojne tempo — limity są szerokie.' : h >= 40 ? 'To szybko — RPP trzyma limity w ryzach.' : 'To bardzo szybko — RPP mocno przykręciła limity.')))));
    c.append(bqTerms([
      ['Limit lokaty', bankCoins(L.lokata_cap)], ['Limit skarbonki', bankCoins(L.piggy_cap)],
      ['Emisja obligacji', L.bond_edition + ' szt.'], ['Budżet Banku', bankCoins(L.budget_day) + ' / dzień']]));
  }
  c.append(el('h4', {}, 'Komunikaty'));
  if (!bankRpp.length) c.append(el('div', { className: 'bq-empty' }, 'Pierwszy komunikat RPP pojawi się o 9:00.'));
  bankRpp.forEach(n => c.append(el('div', { className: 'bq-note' }, el('small', {}, bankDay(n.note_date)), n.body)));

  const hist = (bankState.limits_history || []);
  if (hist.length) {
    const d = el('details', { style: { marginTop: '12px' } }, el('summary', {}, 'Historia decyzji (tabela)'));
    const t = el('table', { className: 'bq-t' });
    t.append(el('tr', {}, el('th', {}, 'Dzień'), el('th', { className: 'r' }, 'Inflacja'), el('th', { className: 'r' }, 'Kondycja'),
      el('th', { className: 'r' }, 'Lokata'), el('th', { className: 'r' }, 'Skarbonka'), el('th', { className: 'r' }, 'Obligacje')));
    hist.forEach(h => t.append(el('tr', {}, el('td', {}, bankDay(h.effective_date)),
      el('td', { className: 'r' }, (Number(h.inflation_bps) / 100).toFixed(2).replace('.', ',') + '%'),
      el('td', { className: 'r' }, Math.round(Number(h.health_bps) / 100) + '%'),
      el('td', { className: 'r' }, bankFmt(h.lokata_cap)), el('td', { className: 'r' }, bankFmt(h.piggy_cap)),
      el('td', { className: 'r' }, String(h.bond_edition)))));
    d.append(el('div', { className: 'bq-scroll' }, t));
    c.append(d);
  }
  panel.append(c);
}

// ── 🔁 Rynek wtórny ─────────────────────────────────────────────────────────
function bankMarket(panel) {
  const rows = (bankState.market || []).filter(h => h.kind === 'bond');
  const c = bqCard('🔁', 'Rynek obligacji', 'Obligacje wystawione przez innych graczy. Kupujesz od razu, cała kwota idzie do sprzedającego — Bank nic nie pobiera.');
  if (!rows.length) c.append(el('div', { className: 'bq-empty' }, 'Nikt teraz nic nie sprzedaje.'));
  const list = el('div', { className: 'bq-pos-list' });
  rows.forEach(h => {
    const fair = Number(h.face_value) + Number(h.accrued);
    const price = Number(h.ask_price);
    const spread = Math.round((price / Math.max(1, fair) - 1) * 100);
    let act;
    if (h.mine) act = el('span', { className: 'bq-chip' }, 'Twoja oferta');
    else {
      act = el('button', { className: 'bq-go', type: 'button' }, 'Kup za ' + bankCoins(price));
      act.disabled = (Number(me?.coins) || 0) < price;
      act.addEventListener('click', () => bankCall('bank_buy_holding', { p_id: h.id }, r => `📜 Kupiono za ${bankCoins(r.price)}.`, act));
    }
    list.append(el('div', { className: 'bq-posi' }, el('span', { className: 'ic' }, '📜'),
      el('div', { className: 'mid' }, el('b', {}, 'Obligacja ' + bankCoins(h.face_value) + ' od ' + (h.owner_nick || '?')),
        el('small', {}, '+' + bankCoins(h.coupon_per_day) + '/dzień · wartość ' + bankCoins(fair)
          + (spread ? ` (${spread > 0 ? '+' : ''}${spread}%)` : '') + ' · wykup za ', bqCountdown(Date.parse(h.matures_at)))),
      act));
  });
  c.append(list);
  panel.append(c);
}

// ── 💍 Sygnet (signpost to the Sklep) ───────────────────────────────────────
function bankSignetCard() {
  const sig = bankState.signet || {};
  const base = Math.floor(Number(me?.coins) || 0)
    + (bankState.deposits || []).filter(d => !d.closed_at).reduce((t, d) => t + Number(d.principal || 0), 0);
  const cap = bankSignetCap();
  const c = bqCard('💍', 'Sygnet Bankiera',
    `Przedmiot ze Sklepu: ${bankSignetPct()}% dziennie od Twoich monet (gotówka + to, co w Banku), liczone od najwyżej ${bankCoins(cap)} — czyli do ${bankCoins(bankSignetDaily(cap))} dziennie.`);
  if (sig.owned) c.append(bqAlert('', '✅', `Masz Sygnet. Wypłacono Ci już ${bankCoins(sig.paid_total)}. Dziś zarabia ${bankCoins(bankSignetDaily(base))}.`));
  else if (sig.better) c.append(bqAlert('warn', 'ℹ️', `Masz już „${sig.better}", który płaci co najmniej tyle samo — Sygnet nic by nie dodał.`));
  else {
    const go = el('button', { className: 'bq-ghost', type: 'button' }, `Zobacz w Sklepie (${bankCoins(BANK_SIGNET_PRICE)}) →`);
    go.addEventListener('click', () => withTabModule('shop', () => openHeroItemInShop('banker_signet')));
    c.append(el('p', { className: 'bq-pitch' }, `U Ciebie dawałby ${bankCoins(bankSignetDaily(base))} dziennie.`), go);
  }
  return c;
}

// ── ❓ Jak to działa ────────────────────────────────────────────────────────
function bankHelp(panel) {
  const c = bqCard('❓', 'Jak to działa', 'Krótko i po ludzku. Kliknij pytanie, żeby rozwinąć.');
  const lok30 = BANK_TERMS[BANK_TERMS.length - 1];
  const faq = [
    ['Czy mogę stracić monety w Banku?',
      'Nie. Skarbonka, lokata i obligacja zawsze oddają to, co wpłaciłeś. Wcześniejsze zamknięcie kosztuje tylko odsetki. Jedyny wydatek bez zwrotu to opłata za kredyt (10%) i zakup Sygnetu.'],
    ['Co się bardziej opłaca?',
      `Na 1000 🪙: skarbonka daje ${bankFmt(1000 * BANK_PIGGY_BPS / 10000)} 🪙 dziennie, lokata 30-dniowa ${bankFmt(1000 * lok30.bps / 10000 / lok30.days)} 🪙 dziennie, `
      + `obligacja ${bankState.series ? bankFmt(Number(bankState.series.coupon_per_day) / Number(bankState.series.price) * 1000) : '—'} 🪙 dziennie. `
      + 'Lokata płaci najwięcej, ale monety są zamrożone; skarbonka jest najbardziej elastyczna; obligację możesz sprzedać.'],
    ['Dlaczego limity zmieniają się codziennie?',
      'Bank tworzy nowe monety, więc pilnuje inflacji. Co noc RPP liczy, ile monet przybyło w całej grze, i na tej podstawie ustala limity. Zmiana nigdy nie dotyczy już otwartych pozycji — oprocentowanie zapisuje się w chwili zawarcia.'],
    ['Czy Bank zabiera odsetki z Sygnetu?',
      'Nie. Monety w Banku nadal liczą się do podstawy Sygnetu i Pierścienia — produkty się sumują.'],
    ['Kto może wziąć kredyt?',
      'Gracze z majątkiem poniżej mediany biura, bez zaległego podatku i bez otwartego kredytu. Limit zależy od Twoich zarobków z ostatnich 14 dni. Opłata 10%, bez odsetek, spłata automatyczna ze sprzedaży plonów.'],
    ['Co to jest wyciąg?',
      'Zestawienie Twojego miesiąca z dziennika monet: przychody, wydatki, gry, saldo dzień po dniu i miejsce w biurze. Przesunięcia w Banku (lokaty, obligacje, kredyt) pokazujemy osobno, bo nie zmieniają majątku.'],
    ['Jak Bank wpływa na ranking?',
      'Monety w Banku liczą się do Net Worth tak samo jak gotówka. Kredyt jest liczony jako dług, więc nikt nie wspina się w rankingu na pożyczce.'],
    ['Co się stało z udziałami w kasynie?',
      'Zostały wycofane 23.10.2026 — kasyno zostało zarchiwizowane, więc nie miałyby z czego płacić. Wszyscy posiadacze dostali zwrot ceny zakupu.'],
  ];
  faq.forEach(([q, a]) => c.append(el('details', {}, el('summary', {}, q), el('p', {}, a))));
  panel.append(c);
}
