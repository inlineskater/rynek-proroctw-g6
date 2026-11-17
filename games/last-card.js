// ── „Ostatnia Karta G6" (last_card) — a shedding card game vs three bots ─────
// Głos Biura's first winning idea (2026-11-09). You and three office bots
// (🤖 Kadry, 🤖 Księgowość, 🤖 IT), seven cards each; match the colour or the
// symbol of the top card, ⏭️ Urlop / 🔁 Zmiana kierunku / +2 Nadgodziny /
// 🌈 Zmiana priorytetów / +4 Deadline; call „Ostatnia!" when you go down to
// one card. First to empty their hand wins.
//
// SERVER-AUTHORITATIVE for every move (see supabase/functions/last-card-action):
// this file never knows the deck or the bots' hands, it renders the sanitized
// view the server returns and sends play/draw/pass. The playable-card
// highlight is a convenience; the server re-checks everything. There is no
// parity contract.
//
// Two modes on one panel, like every other seasonal game:
//   seasonal — mode 'season', result goes to last_card_scores (weekly ranking).
//   arcade   — „Wszystkie Gry" (allGamesMode): mode 'arcade', the server
//              writes arcade_scores itself (like rps/Filler).
//
// index.html holds only the empty #seasonal-game-last-card shell, the
// `lastCardRuntime` pre-declaration, the stopLastCardRound() stub and the
// lcScoreLabel() decoder; the panel markup and CSS are built here.

const LC_COLOR_LOOK = {
  r: { name: 'czerwony', bg: '#e5484d', dark: '#b4232a' },
  y: { name: 'żółty', bg: '#f5b300', dark: '#b07f00' },
  g: { name: 'zielony', bg: '#2fa84f', dark: '#1f7a37' },
  b: { name: 'niebieski', bg: '#2f6fdf', dark: '#1f4fa8' },
};
const LC_VALUE_LOOK = {
  S: { sym: '⏭', name: 'Urlop — następny traci turę' },
  R: { sym: '⇄', name: 'Zmiana kierunku' },
  D: { sym: '+2', name: '+2 Nadgodziny — następny dobiera 2 i traci turę' },
  W: { sym: '🌈', name: 'Zmiana priorytetów — wybierasz kolor' },
  F: { sym: '+4', name: '+4 Deadline — wybierasz kolor, następny dobiera 4 i traci turę' },
};
const LC_SEAT_LOOK = [
  { name: 'Ty', emoji: '🙂' },
  { name: 'Kadry', emoji: '🤖' },
  { name: 'Księgowość', emoji: '🤖' },
  { name: 'IT', emoji: '🤖' },
];
const LC_BOT_STEP_MS = 520;

(function lcInjectCss() {
  if (document.getElementById('lc-css')) return;
  const s = document.createElement('style');
  s.id = 'lc-css';
  s.textContent = `
    .lc-stage { position: relative; width: 100%; max-width: 620px; margin: 0 auto; }
    .lc-table { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr); grid-template-rows: auto auto;
      gap: 8px; padding: 12px; border-radius: 16px; background: radial-gradient(ellipse at 50% 40%, #2f7d55, #1d5a3b);
      box-shadow: inset 0 0 0 3px #164a30, 0 12px 30px rgba(15,23,42,.18); user-select: none; -webkit-user-select: none; }
    .lc-seat { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 6px 4px; border-radius: 12px;
      color: #ecfdf5; font-size: 12px; text-align: center; position: relative; min-width: 0; transition: box-shadow .2s, background .2s; }
    .lc-seat.s2 { grid-column: 2; grid-row: 1; }
    .lc-seat.s1 { grid-column: 1; grid-row: 2; }
    .lc-seat.s3 { grid-column: 3; grid-row: 2; }
    .lc-seat.active { background: rgba(255,255,255,.12); box-shadow: 0 0 0 2px #facc15; }
    .lc-seat-name { font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    .lc-backs { display: flex; justify-content: center; height: 34px; }
    .lc-back { width: 22px; height: 32px; border-radius: 4px; margin-left: -12px; border: 2px solid #fff;
      background: repeating-linear-gradient(45deg, #334155 0 4px, #475569 4px 8px); box-shadow: 0 1px 2px rgba(0,0,0,.35); }
    .lc-back:first-child { margin-left: 0; }
    .lc-count { font-size: 12px; opacity: .9; }
    .lc-bubble { position: absolute; top: -8px; left: 50%; transform: translateX(-50%); background: #fff; color: #0f172a;
      font-weight: 800; font-size: 12px; padding: 3px 8px; border-radius: 10px; white-space: nowrap; z-index: 2;
      box-shadow: 0 4px 12px rgba(0,0,0,.3); animation: lc-pop .25s ease-out; }
    .lc-bubble.warn { background: #fef08a; }
    .lc-center { grid-column: 2; grid-row: 2; display: flex; align-items: center; justify-content: center; gap: 14px; padding: 6px 0; }
    .lc-pile { display: flex; flex-direction: column; align-items: center; gap: 4px; color: #ecfdf5; font-size: 11px; }
    .lc-deck { width: 58px; height: 84px; border-radius: 8px; border: 3px solid #fff; padding: 0; cursor: default;
      background: repeating-linear-gradient(45deg, #334155 0 6px, #475569 6px 12px); color: #fff; font-weight: 800; font-size: 13px;
      box-shadow: 3px 3px 0 #0f172a55, 6px 6px 0 #0f172a33; }
    .lc-deck.can { cursor: pointer; box-shadow: 0 0 0 3px #facc15, 3px 3px 0 #0f172a55; }
    .lc-deck.can:hover { transform: translateY(-2px); }
    .lc-dir { font-size: 22px; color: #fef9c3; line-height: 1; }
    .lc-dir.flip { animation: lc-spin .5s ease-out; }
    .lc-colorchip { width: 14px; height: 14px; border-radius: 50%; display: inline-block; vertical-align: -2px; border: 2px solid #fff; }
    .lc-card { position: relative; width: 58px; height: 84px; border-radius: 8px; border: 3px solid #fff; padding: 0;
      display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 900; font-family: system-ui, sans-serif;
      font-size: 28px; line-height: 1; box-shadow: 0 2px 4px rgba(0,0,0,.3); flex: 0 0 auto; text-shadow: 0 1px 0 rgba(0,0,0,.35); }
    .lc-card .lc-corner { position: absolute; top: 3px; left: 5px; font-size: 11px; }
    .lc-card .lc-corner.br { top: auto; left: auto; bottom: 3px; right: 5px; transform: rotate(180deg); }
    .lc-card.wild { background: #1f2937; }
    .lc-card.wild::before { content: ''; position: absolute; inset: 10px 6px; border-radius: 4px; opacity: .9;
      background: linear-gradient(160deg, #e5484d 0 25%, #f5b300 25% 50%, #2fa84f 50% 75%, #2f6fdf 75%); }
    .lc-card.wild > span { position: relative; }
    .lc-card.wild .lc-corner { display: none; }
    .lc-card.big { width: 70px; height: 100px; font-size: 34px; }
    .lc-card.pop { animation: lc-pop .3s ease-out; }
    .lc-hand-wrap { margin-top: 10px; }
    .lc-hand { display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; min-height: 92px; padding: 4px 0; }
    .lc-hand .lc-card { cursor: default; transition: transform .12s, box-shadow .12s; }
    .lc-hand .lc-card.ok { cursor: pointer; transform: translateY(-6px); box-shadow: 0 0 0 3px #facc15, 0 6px 12px rgba(0,0,0,.3); }
    .lc-hand .lc-card.ok:hover { transform: translateY(-10px); }
    .lc-hand .lc-card.dim { filter: saturate(.55) brightness(.9); }
    .lc-hand .lc-card.new { animation: lc-in .35s ease-out; }
    .lc-hand-label { font-size: 12px; color: var(--muted); text-align: center; }
    .lc-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: center; margin-top: 8px; }
    .lc-call.on { background: #facc15; color: #422006; border-color: #eab308; }
    .lc-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      border-radius: 16px; background: rgba(15,23,42,.55); z-index: 3; padding: 12px; animation: lc-fade .15s ease-out; }
    .lc-box { background: #fff; color: #0f172a; border-radius: 12px; padding: 16px 18px; text-align: center; max-height: 100%; overflow: auto;
      box-shadow: 0 16px 40px rgba(0,0,0,.35); max-width: 380px; width: 100%; animation: lc-pop .28s ease-out; }
    .lc-box h3 { margin: 0 0 6px; font-size: 17px; }
    .lc-box p { margin: 4px 0 0; font-size: 13px; color: #475569; }
    .lc-colors { display: flex; gap: 8px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
    .lc-colors button { width: 64px; height: 64px; border-radius: 14px; border: 3px solid #fff; cursor: pointer; color: #fff;
      font-weight: 800; font-size: 11px; box-shadow: 0 0 0 2px #cbd5e1; display: flex; align-items: flex-end; justify-content: center; padding-bottom: 6px; }
    .lc-colors button:hover { transform: translateY(-3px); }
    .lc-reveal { text-align: left; margin-top: 10px; font-size: 12px; }
    .lc-reveal-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 4px 0; }
    .lc-reveal-row strong { min-width: 84px; }

    @keyframes lc-pop { 0% { transform: scale(.6); opacity: 0 } 70% { transform: scale(1.06) } 100% { transform: scale(1); opacity: 1 } }
    @keyframes lc-fade { from { opacity: 0 } to { opacity: 1 } }
    @keyframes lc-in { from { transform: translateY(-30px); opacity: 0 } to { transform: none; opacity: 1 } }
    @keyframes lc-spin { from { transform: rotate(-180deg) } to { transform: none } }
    @media (max-width: 480px) {
      .lc-table { padding: 8px; gap: 4px; }
      .lc-card { width: 46px; height: 68px; font-size: 22px; }
      .lc-card.big { width: 56px; height: 82px; font-size: 28px; }
      .lc-deck { width: 46px; height: 68px; }
      .lc-center { gap: 8px; }
      .lc-back { width: 16px; height: 24px; margin-left: -10px; }
      .lc-backs { height: 26px; }
      .lc-hand { gap: 4px; }
    }
    .lc-card.lc-mini { width: 24px; height: 34px; font-size: 12px; border-width: 2px; border-radius: 4px; }
    .lc-card.lc-mini .lc-corner { display: none; }
    .lc-card.lc-mini.wild::before { inset: 4px 3px; }
    @media (prefers-reduced-motion: reduce) {
      .lc-stage *, .lc-table { animation: none !important; transition: none !important; }
    }
  `;
  document.head.appendChild(s);
})();

// ── Panel markup ─────────────────────────────────────────────────────────────
(function lcBuildPanel() {
  const root = document.getElementById('seasonal-game-last-card');
  if (!root || root.dataset.built) return;
  root.dataset.built = '1';
  const stat = (label, id, v) => el('div', { className: 'bj-stat' },
    el('div', { className: 'bj-stat-label' }, label), el('div', { className: 'bj-stat-value', id }, v));
  const li = (...parts) => { const n = el('li'); n.append(...parts); return n; };
  const board = (title, sub, id, extra) => el('section', {},
    el('div', { className: 'bj-board-title' }, el('span', {}, title), el('span', { className: 'bj-board-sub', id: extra || null, title: sub.title || '' }, sub.text || '')),
    el('div', { id }));

  root.replaceChildren(el('div', { className: 'bj-layout' },
    el('section', { className: 'bj-game-panel' },
      el('div', { className: 'bj-head' },
        el('div', {},
          el('h2', { className: 'page-title' }, '„Ostatnia Karta G6" 🎴'),
          el('p', { className: 'page-sub' }, 'Pomysł tygodnia z 🗳️ Głosu Biura. Ty i trzy boty z działów, po siedem kart. Pozbądź się swoich pierwszy — w jak najmniejszej liczbie tur.')),
        el('div', { className: 'bj-prizes', 'aria-label': 'Nagrody tygodniowe' },
          el('span', { className: 'bj-prize' }, '🥇 1000 🪙'),
          el('span', { className: 'bj-prize' }, '🥈 500 🪙'),
          el('span', { className: 'bj-prize' }, '🥉 200 🪙'))),
      el('div', { className: 'bj-rules' },
        el('div', { className: 'bj-rules-title' }, 'Jak grać'),
        el('ul', {},
          li('Zagraj kartę w ', el('strong', {}, 'tym samym kolorze'), ' albo z ', el('strong', {}, 'tym samym znakiem'), ' co karta na stosie. Pasujące karty są podświetlone.'),
          li('Nic nie pasuje? Kliknij talię i dobierz jedną. Jeśli pasuje, możesz ją od razu zagrać, a jeśli nie — pasujesz.'),
          li(el('strong', {}, '⏭ Urlop'), ' — następny traci turę. ', el('strong', {}, '⇄'), ' — zmiana kierunku. ', el('strong', {}, '+2 Nadgodziny'), ' — następny dobiera 2 i traci turę. ', el('strong', {}, '🌈'), ' — wybierasz kolor. ', el('strong', {}, '+4 Deadline'), ' — wybierasz kolor, a następny dobiera 4.'),
          li('Zanim zagrasz przedostatnią kartę, wciśnij ', el('strong', {}, '📢 Ostatnia!'), '. Jeśli zapomnisz, dobierasz 2 karty.'),
          li(el('strong', {}, 'Ranking tygodnia:'), ' wygrana zawsze bije przegraną, a wśród wygranych liczy się najmniej Twoich tur (stracona tura też jest turą). Bez wygranej liczy się najlepsze miejsce w partii. Do rankingu wchodzi do 30 partii dziennie.'))),
      el('div', { className: 'bj-stats' },
        stat('Twoje tury', 'lc-turns', '0'),
        stat('Karty w ręce', 'lc-cards', '0'),
        stat('Najlepszy wynik', 'lc-best', '—'),
        stat('Partie dziś', 'lc-today', '0/30')),
      el('div', { className: 'lc-stage', id: 'lc-stage' },
        el('div', { className: 'lc-table', id: 'lc-table' }),
        el('div', { className: 'lc-hand-wrap' },
          el('div', { className: 'lc-hand-label', id: 'lc-hand-label' }, 'Twoja ręka'),
          el('div', { className: 'lc-hand', id: 'lc-hand' }))),
      el('div', { className: 'bj-actions lc-actions' },
        el('button', { className: 'btn-primary bj-start-btn', id: 'lc-start-btn' }, 'Rozdaj karty'),
        el('button', { className: 'btn-ghost lc-call hidden', id: 'lc-call-btn', title: 'Wciśnij przed zagraniem przedostatniej karty' }, '📢 Ostatnia!'),
        el('button', { className: 'btn-ghost hidden', id: 'lc-pass-btn' }, 'Pasuj'),
        el('button', { className: 'btn-ghost hidden', id: 'lc-resign-btn' }, '🏳️ Poddaj się'),
        el('div', { className: 'bj-status', id: 'lc-status' }, 'Kliknij „Rozdaj karty", żeby zacząć.'))),
    el('aside', { className: 'bj-board-panel' },
      board('Ten tydzień', {}, 'lc-weekly-board', 'lc-week-label'),
      board('All-time', { text: 'rekordy' }, 'lc-alltime-board'),
      board('Ostatnie nagrody', { text: 'wypłata: po tygodniu', title: 'Top 3 z minionego tygodnia dostają nagrody w poniedziałek po zamknięciu tygodnia.' }, 'lc-awards'))));
})();

const lcTableEl  = document.getElementById('lc-table');
const lcStageEl  = document.getElementById('lc-stage');
const lcHandEl   = document.getElementById('lc-hand');
const lcStartBtn = document.getElementById('lc-start-btn');
const lcCallBtn  = document.getElementById('lc-call-btn');
const lcPassBtn  = document.getElementById('lc-pass-btn');
const lcResignBtn = document.getElementById('lc-resign-btn');
const lcStatus   = document.getElementById('lc-status');

function newLastCardRuntime() {
  return {
    playing: false,   // a server match is running
    busy: false,      // a request / playback is in flight
    round: null,      // server round payload { id, mode, status, score, table }
    call: false,      // „Ostatnia!" armed for the next play
    bubble: null,     // { seat, text, warn } shown over a seat
    fresh: [],        // cards just drawn into my hand (animated in)
    popTop: false,
    flipDir: false,
    activeSeat: null, // seat highlighted during playback
    overlay: null,
    today: 0, cap: 30,
  };
}

// ── Cards ───────────────────────────────────────────────────────────────────
const lcIsWild = c => c[0] === 'w';

function lcFits(t, c) {
  if (lcIsWild(c)) return true;
  return c[0] === t.color || (!lcIsWild(t.top) && c[1] === t.top[1]);
}

function lcCardName(c) {
  const v = LC_VALUE_LOOK[c[1]];
  const col = lcIsWild(c) ? '' : ' (' + LC_COLOR_LOOK[c[0]].name + ')';
  return (v ? v.name : 'Karta ' + c[1]) + col;
}

function lcCardEl(c, extra) {
  const sym = LC_VALUE_LOOK[c[1]]?.sym ?? c[1];
  const wild = lcIsWild(c);
  const node = el('button', { type: 'button', className: 'lc-card' + (wild ? ' wild' : '') + (extra ? ' ' + extra : ''), title: lcCardName(c) },
    el('span', { className: 'lc-corner' }, sym), el('span', {}, sym), el('span', { className: 'lc-corner br' }, sym));
  if (!wild) node.style.background = LC_COLOR_LOOK[c[0]].bg;
  node.dataset.card = c;
  return node;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function lcMyTurn(t, rt) {
  return !!t && t.turn === 0 && !t.result && !rt.busy;
}

function lcSeatEl(t, s, rt) {
  const look = LC_SEAT_LOOK[s];
  const n = t ? t.counts[s] : 7;
  const backs = el('div', { className: 'lc-backs' });
  for (let k = 0; k < Math.min(n, 8); k++) backs.append(el('div', { className: 'lc-back' }));
  const active = rt.activeSeat != null ? rt.activeSeat === s : t && t.turn === s;
  const node = el('div', { className: 'lc-seat s' + s + (active ? ' active' : '') },
    el('div', { className: 'lc-seat-name' }, look.emoji + ' ' + look.name),
    backs,
    el('div', { className: 'lc-count' }, t ? plCountLc(n) : '7 kart'));
  if (rt.bubble && rt.bubble.seat === s) node.append(el('div', { className: 'lc-bubble' + (rt.bubble.warn ? ' warn' : '') }, rt.bubble.text));
  return node;
}

function plCountLc(n) {
  return n + ' ' + (typeof plCount === 'function' ? plCount(n, 'karta', 'karty', 'kart') : 'kart');
}

function lcRender() {
  const rt = lastCardRuntime || (lastCardRuntime = newLastCardRuntime());
  if (!lcTableEl) return;
  const t = rt.round?.table || null;
  const mine = lcMyTurn(t, rt);

  // Centre: the deck (click to draw) and the discard pile with the colour.
  const deck = el('button', { type: 'button', className: 'lc-deck' + (mine && !t.drawn ? ' can' : ''), title: 'Dobierz kartę' }, t ? String(t.deck) : '108');
  deck.addEventListener('click', () => { if (lcMyTurn(lastCardRuntime.round?.table, lastCardRuntime) && !lastCardRuntime.round.table.drawn) lcAct({ action: 'draw' }); });
  const top = t ? lcCardEl(t.top, 'big' + (rt.popTop ? ' pop' : '')) : el('div', { className: 'lc-card big wild' }, el('span', {}, '🎴'));
  top.disabled = true;
  const colorChip = t ? el('span', { className: 'lc-colorchip', style: { background: LC_COLOR_LOOK[t.color].bg } }) : null;
  const center = el('div', { className: 'lc-center' },
    el('div', { className: 'lc-pile' }, deck, el('span', {}, 'talia')),
    el('div', { className: 'lc-pile' },
      el('span', { className: 'lc-dir' + (rt.flipDir ? ' flip' : ''), title: 'Kierunek gry' }, t && t.dir < 0 ? '↺' : '↻')),
    el('div', { className: 'lc-pile' }, top, el('span', {}, colorChip, t ? ' ' + LC_COLOR_LOOK[t.color].name : 'stos')));
  lcTableEl.replaceChildren(lcSeatEl(t, 2, rt), lcSeatEl(t, 1, rt), center, lcSeatEl(t, 3, rt));

  // My hand.
  if (lcHandEl) {
    const fresh = [...(rt.fresh || [])];
    const cards = (t?.hand || []).map(c => {
      const ok = mine && (t.drawn ? c === t.drawn : lcFits(t, c));
      let cls = mine ? (ok ? 'ok' : 'dim') : '';
      const fi = fresh.indexOf(c);
      if (fi >= 0) { fresh.splice(fi, 1); cls += ' new'; }
      const node = lcCardEl(c, cls);
      node.dataset.ok = ok ? '1' : '';
      return node;
    });
    lcHandEl.replaceChildren(...cards);
    if (rt.bubble && rt.bubble.seat === 0) lcHandEl.prepend(el('div', { className: 'lc-bubble' + (rt.bubble.warn ? ' warn' : ''), style: 'position:relative;top:0;left:0;transform:none;align-self:center' }, rt.bubble.text));
  }
  const label = document.getElementById('lc-hand-label');
  if (label) label.textContent = t ? (rt.activeSeat === 0 || (rt.activeSeat == null && t.turn === 0) ? '👉 Twoja ręka — Twój ruch' : 'Twoja ręka') : 'Twoja ręka';
  rt.fresh = [];
  rt.popTop = false;
  rt.flipDir = false;
  lcSetStats();
  lcSetButtons();
}

function lcSetStats() {
  const rt = lastCardRuntime;
  const t = rt?.round?.table;
  const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = String(v); };
  set('lc-turns', t ? t.turns : 0);
  set('lc-cards', t ? t.hand.length : 0);
  set('lc-today', (rt?.today || 0) + '/' + (rt?.cap || 30));
}

function lcSetButtons() {
  const rt = lastCardRuntime;
  const t = rt?.round?.table;
  const inMatch = !!rt?.playing;
  const mine = lcMyTurn(t, rt);
  if (lcStartBtn) {
    lcStartBtn.classList.toggle('hidden', inMatch);
    lcStartBtn.disabled = !!rt?.busy;
    lcStartBtn.textContent = rt?.busy && !inMatch ? 'Tasuję...' : rt?.round ? 'Nowa partia' : 'Rozdaj karty';
  }
  if (lcCallBtn) {
    lcCallBtn.classList.toggle('hidden', !inMatch);
    lcCallBtn.disabled = !mine || t.hand.length !== 2;
    if (lcCallBtn.disabled && !(mine && t.hand.length === 2)) rt.call = false;
    lcCallBtn.classList.toggle('on', !!rt?.call);
    lcCallBtn.textContent = rt?.call ? '📢 Ostatnia! ✓' : '📢 Ostatnia!';
  }
  if (lcPassBtn) lcPassBtn.classList.toggle('hidden', !(inMatch && mine && t.drawn));
  if (lcResignBtn) { lcResignBtn.classList.toggle('hidden', !inMatch); lcResignBtn.disabled = !!rt?.busy; }
}

function lcSetStatus(text) { if (lcStatus) lcStatus.textContent = text; }

function lcOverlay(node) {
  const rt = lastCardRuntime;
  if (rt.overlay) rt.overlay.remove();
  rt.overlay = node;
  if (node && lcStageEl) lcStageEl.appendChild(node);
}

function lcStatusForTable() {
  const t = lastCardRuntime.round?.table;
  if (!t || t.result) return;
  if (t.turn !== 0) { lcSetStatus('Boty grają...'); return; }
  if (t.drawn) lcSetStatus('Dobrana karta pasuje — zagraj ją albo pasuj.');
  else if (t.hand.some(c => lcFits(t, c))) lcSetStatus(t.hand.length === 2 ? 'Twój ruch. Masz dwie karty — wciśnij 📢 Ostatnia! przed zagraniem.' : 'Twój ruch. Kliknij podświetloną kartę.');
  else lcSetStatus('Nic nie pasuje — kliknij talię, żeby dobrać kartę.');
}

// ── Event playback ──────────────────────────────────────────────────────────

const lcReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const lcSleep = ms => new Promise(r => setTimeout(r, ms));

// Replays the server's events on a copy of the table as it looked before the
// request, so every bot play, draw and skip is visible. The real server view
// replaces the copy afterwards.
async function lcPlayEvents(events) {
  const rt = lastCardRuntime;
  if (!rt.round?.table || !events?.length) return;
  const vt = JSON.parse(JSON.stringify(rt.round.table));
  const saved = rt.round;
  rt.round = { ...saved, table: vt };
  vt.turn = -1;                              // nothing clickable during playback
  const step = lcReducedMotion() ? 120 : LC_BOT_STEP_MS;
  const name = s => LC_SEAT_LOOK[s].name;
  try {
    for (const ev of events) {
      if (lastCardRuntime !== rt) return;
      rt.bubble = null;
      if (ev.k === 'play') {
        rt.activeSeat = ev.seat;
        vt.top = ev.card; vt.color = ev.color;
        vt.counts[ev.seat] = Math.max(0, vt.counts[ev.seat] - 1);
        if (ev.seat === 0) { const i = vt.hand.indexOf(ev.card); if (i >= 0) vt.hand.splice(i, 1); }
        rt.popTop = true;
        if (lcIsWild(ev.card)) rt.bubble = { seat: ev.seat, text: '🎨 ' + LC_COLOR_LOOK[ev.color].name };
        lcSetStatus((ev.seat === 0 ? 'Zagrywasz: ' : name(ev.seat) + ' zagrywa: ') + lcCardName(ev.card) + (lcIsWild(ev.card) ? ' → ' + LC_COLOR_LOOK[ev.color].name : '') + '.');
        lcRender();
        await lcSleep(ev.seat === 0 ? step * 0.6 : step);
      } else if (ev.k === 'draw') {
        vt.counts[ev.seat] += ev.n;
        vt.deck = Math.max(0, vt.deck - ev.n);
        if (ev.seat === 0 && ev.cards) { vt.hand.push(...ev.cards); rt.fresh = [...ev.cards]; }
        const why = ev.why === 'forgot' ? ' (zapomniane „Ostatnia!")' : ev.why === 'D' ? ' (+2)' : ev.why === 'F' ? ' (+4)' : '';
        rt.bubble = { seat: ev.seat, text: '+' + ev.n + (ev.why === 'forgot' ? ' 🙊' : ''), warn: ev.why !== 'turn' };
        if (ev.why === 'turn') rt.activeSeat = ev.seat;
        lcSetStatus((ev.seat === 0 ? 'Dobierasz ' : name(ev.seat) + ' dobiera ') + plCountLc(ev.n) + why + '.');
        lcRender();
        await lcSleep(step * (ev.why === 'turn' ? 0.7 : 0.9));
      } else if (ev.k === 'skip') {
        rt.activeSeat = ev.seat;
        rt.bubble = { seat: ev.seat, text: '⏭ traci turę', warn: true };
        lcSetStatus((ev.seat === 0 ? 'Tracisz turę.' : name(ev.seat) + ' traci turę.'));
        lcRender();
        await lcSleep(step * 0.8);
      } else if (ev.k === 'rev') {
        vt.dir = ev.dir;
        rt.flipDir = true;
        lcRender();
        await lcSleep(step * 0.5);
      } else if (ev.k === 'last') {
        rt.bubble = { seat: ev.seat, text: '📢 Ostatnia!', warn: true };
        lcRender();
        await lcSleep(step * 0.8);
      } else if (ev.k === 'shuffle') {
        lcSetStatus('Talia się skończyła — tasuję stos.');
        await lcSleep(step * 0.4);
      }
    }
  } finally {
    if (lastCardRuntime === rt) { rt.round = saved; rt.bubble = null; rt.activeSeat = null; }
  }
}

function lcShowEnd(round, summary) {
  const t = round.table;
  const won = t.result === 'won';
  const score = summary?.score ?? round.score ?? 0;
  const why = t.reason === 'resign' ? 'Poddałeś partię.'
    : t.reason === 'plies' ? 'Limit ruchów — liczą się karty w ręce.'
    : won ? 'Pozbyłeś się wszystkich kart w ' + t.turns + ' turach.'
    : LC_SEAT_LOOK[t.winner].name + ' wygrywa. Twoje miejsce: ' + t.place + '.';
  const saved = round.mode === 'arcade' ? 'Zapisano w rankingu arcade.' : 'Zapisano w rankingu tygodnia.';
  const reveal = el('div', { className: 'lc-reveal' }, ...(t.hands || []).map((h, s) => el('div', { className: 'lc-reveal-row' },
    el('strong', {}, LC_SEAT_LOOK[s].emoji + ' ' + LC_SEAT_LOOK[s].name), ...(h.length ? h.map(c => { const n = lcCardEl(c, 'lc-mini'); n.disabled = true; return n; }) : [el('span', {}, '— pusto 🏆')]))));
  lcOverlay(el('div', { className: 'lc-overlay' }, el('div', { className: 'lc-box' },
    el('h3', {}, won ? '🏆 Wygrana!' : t.reason === 'resign' ? '🏳️ Poddana' : '🎴 Koniec partii'),
    el('p', {}, why),
    el('p', {}, el('strong', {}, 'Wynik: ' + lcScoreLabel(score))),
    el('p', {}, saved),
    reveal,
    el('button', { type: 'button', className: 'btn-primary', style: 'margin-top:10px', onclick: () => lcStart() }, 'Zagraj ponownie'))));
  lcSetStatus((won ? 'Wygrana' : 'Koniec partii') + ' · ' + lcScoreLabel(score) + '.');
}

function lcAskColor(card) {
  const pick = c => el('button', { type: 'button', style: { background: LC_COLOR_LOOK[c].bg }, onclick: () => { lcOverlay(null); lcPlay(card, c); } }, LC_COLOR_LOOK[c].name);
  lcOverlay(el('div', { className: 'lc-overlay' }, el('div', { className: 'lc-box' },
    el('h3', {}, card[1] === 'F' ? '+4 Deadline — wybierz kolor' : '🌈 Wybierz kolor'),
    el('p', {}, 'Następna karta musi być w tym kolorze.'),
    el('div', { className: 'lc-colors' }, pick('r'), pick('y'), pick('g'), pick('b')),
    el('button', { type: 'button', className: 'btn-ghost', style: 'margin-top:10px', onclick: () => lcOverlay(null) }, 'Anuluj'))));
}

// ── Flow ────────────────────────────────────────────────────────────────────

function stopLastCardRound() {
  // The match lives on the server and survives leaving the tab; this only
  // drops the local view. loadLastCardState() resumes it.
  if (lastCardRuntime?.overlay) lastCardRuntime.overlay.remove();
  const keep = lastCardRuntime;
  lastCardRuntime = newLastCardRuntime();
  if (keep) { lastCardRuntime.today = keep.today; lastCardRuntime.cap = keep.cap; }
  lcRender();
}

function lcApplyRound(round) {
  const rt = lastCardRuntime;
  rt.round = round;
  rt.playing = !!round && round.status === 'active';
  rt.call = false;
}

async function lcStart() {
  const rt = lastCardRuntime;
  if (rt.busy) return;
  if (rt.playing && !confirm('Zacząć nową partię? Obecna przepadnie bez wyniku.')) return;
  rt.busy = true;
  lcOverlay(null);
  lcSetButtons();
  lcSetStatus('Tasuję i rozdaję...');
  try {
    const season = !allGamesMode;
    const data = await invokeLastCard({ action: 'start', mode: season ? 'season' : 'arcade' });
    lcApplyRound(data.round);
    if (season) rt.today = (rt.today || 0) + 1;
    rt.fresh = [...data.round.table.hand];
  } catch (err) {
    showToast('❌ ' + err.message);
    lcSetStatus(err.message || 'Nie udało się rozpocząć partii.');
  } finally {
    rt.busy = false;
    lcRender();
    lcStatusForTable();
  }
}

async function lcAct(payload) {
  const rt = lastCardRuntime;
  if (!rt.playing || rt.busy) return;
  rt.busy = true;
  lcOverlay(null);
  lcRender();
  try {
    const data = await invokeLastCard(payload);
    if (lastCardRuntime !== rt) return;
    await lcPlayEvents(data.events);
    if (lastCardRuntime !== rt) return;
    lcApplyRound(data.round);
    rt.busy = false;
    lcRender();
    const t = data.round.table;
    if (t.result) {
      lcShowEnd(data.round, data.summary);
      if (data.round.mode === 'arcade') loadArcadeScores('last_card');
      else if (data.weekly) lcRenderState(data);
      if (data.summary) showToast((t.result === 'won' ? '🏆 ' : '🎴 ') + 'Wynik zapisany: ' + lcScoreLabel(data.summary.score));
    } else lcStatusForTable();
  } catch (err) {
    showToast('❌ ' + err.message);
    rt.busy = false;
    lcRender();
    lcStatusForTable();
  }
}

function lcPlay(card, color) {
  const rt = lastCardRuntime;
  const t = rt.round?.table;
  const payload = { action: 'play', card, last: !!rt.call && t?.hand.length === 2 };
  if (color) payload.color = color;
  lcAct(payload);
}

function lcOnHandClick(evt) {
  const node = evt.target.closest('.lc-card');
  if (!node || !node.dataset.ok) return;
  const rt = lastCardRuntime;
  if (!lcMyTurn(rt.round?.table, rt)) return;
  const card = node.dataset.card;
  if (lcIsWild(card)) lcAskColor(card);
  else lcPlay(card);
}

async function lcResign() {
  if (!lastCardRuntime.playing || lastCardRuntime.busy) return;
  if (!confirm('Poddać partię? Liczy się jak przegrana z wynikiem 0.')) return;
  lcAct({ action: 'resign' });
}

// ── Networking + leaderboards ───────────────────────────────────────────────

async function invokeLastCard(payload) {
  const { data, error } = await sb.functions.invoke('last-card-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z grą.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd gry.');
  return data;
}

async function loadLastCardState(showSpinner = true) {
  if (!lastCardRuntime) lastCardRuntime = newLastCardRuntime();
  lcRender();
  const weeklyWrap  = document.getElementById('lc-weekly-board');
  const allTimeWrap = document.getElementById('lc-alltime-board');
  const awardsWrap  = document.getElementById('lc-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeLastCard({ action: 'state' });
    lcRenderState(data);
    // Resume a match left running (another tab, a reload).
    if (data.round && !lastCardRuntime.busy && !lastCardRuntime.playing) {
      lcApplyRound(data.round);
      lcRender();
      lcStatusForTable();
    }
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
  }
}

function lcRenderState(data) {
  const rt = lastCardRuntime;
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  if (data.seasonToday != null) { rt.today = data.seasonToday; rt.cap = data.seasonDailyCap || 30; }
  const weekLabel = document.getElementById('lc-week-label');
  if (weekLabel) weekLabel.textContent = whackBossWeekRange(data.weekStart)?.short || '';
  const best = document.getElementById('lc-best');
  if (best) best.textContent = data.myWeekly ? lcScoreLabel(data.myWeekly.score) : '—';
  lcRenderTable(document.getElementById('lc-weekly-board'), data.weekly || [], 'weekly');
  lcRenderTable(document.getElementById('lc-alltime-board'), data.allTime || [], 'allTime');
  lcRenderAwards(document.getElementById('lc-awards'), data.awards || []);
  lcSetStats();
}

function lcRenderTable(wrap, rows, mode) {
  if (!wrap) return;
  rows = rows.filter(r => r.nick !== 'admin');
  if (!rows.length) {
    wrap.replaceChildren(el('p', { className: 'bj-empty' }, mode === 'weekly' ? 'Jeszcze nikt nie zagrał w tym tygodniu.' : 'Brak rekordów.'));
    return;
  }
  const bodyRows = rows.slice(0, 10).map(row => el('tr', {},
    el('td', { className: 'lb-rank' + (row.rank === 1 ? ' gold' : '') }, whackBossRankLabel(row.rank)),
    el('td', { className: 'lb-nick' + (row.user_id === me?.id ? ' me' : '') }, row.nick + (row.user_id === me?.id ? ' (Ty)' : '')),
    el('td', { className: 'lb-num', title: 'Wygrane / rozegrane partie' }, (row.wins ?? 0) + '/' + (row.rounds_played ?? 0)),
    el('td', { className: 'lb-net' }, lcScoreLabel(row.score))));
  wrap.replaceChildren(el('table', { className: 'lb-table-compact' },
    el('thead', {}, el('tr', {},
      el('th', {}, '#'), el('th', {}, 'Nick'),
      el('th', { title: 'Wygrane / rozegrane partie' }, '🏆'),
      el('th', { title: 'Najlepsza partia: najmniej tur do wygranej, a bez wygranej najlepsze miejsce' }, 'Wynik'))),
    el('tbody', {}, ...bodyRows)));
}

function lcRenderAwards(wrap, awards) {
  if (!wrap) return;
  if (!awards.length) {
    wrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Pierwsze nagrody pojawią się po zakończeniu tygodnia.'));
    return;
  }
  wrap.replaceChildren(...awards.slice(0, 6).map(row => {
    const label = whackBossWeekRange(row.week_start)?.short || '';
    return el('div', { className: 'bj-award-row' },
      el('span', {}, whackBossRankLabel(row.rank) + ' ' + row.nick + (label ? ' · ' + label : '')),
      el('strong', {}, '+' + row.prize_coins + ' 🪙'));
  }));
}

// ── Wiring ──────────────────────────────────────────────────────────────────

if (lcHandEl) lcHandEl.addEventListener('click', lcOnHandClick);
if (lcStartBtn) lcStartBtn.addEventListener('click', lcStart);
if (lcPassBtn) lcPassBtn.addEventListener('click', () => lcAct({ action: 'pass' }));
if (lcResignBtn) lcResignBtn.addEventListener('click', lcResign);
if (lcCallBtn) lcCallBtn.addEventListener('click', () => { lastCardRuntime.call = !lastCardRuntime.call; lcSetButtons(); });

if (!lastCardRuntime) lastCardRuntime = newLastCardRuntime();
lcRender();
