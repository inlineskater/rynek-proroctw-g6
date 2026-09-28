// ── „Papier, Kamień, Biuro G6" (rps) — a remake of ICQ's „RPS Online" ────────
// A 7×6 board, 14 pieces a side: 12 hidden fighters (✊ Zszywacz = kamień,
// ✋ Faktura = papier, ✌️ Niszczarka = nożyce), a 🚩 flag and a 🕳️ trap. Fights
// reveal both pieces; a tie makes both pick again; take the flag to win.
//
// SERVER-AUTHORITATIVE for every move (see supabase/functions/rps-action):
// this file never knows the bot's hidden pieces, it renders the sanitized view
// the server returns and sends {from, to} / a tie pick. The legal-move
// highlight below is a convenience; the server re-checks everything. There is
// no parity contract.
//
// Two modes on one panel, like every other seasonal game:
//   seasonal — mode 'season', result goes to rps_scores (weekly ranking).
//   arcade   — „Wszystkie Gry" (allGamesMode): mode 'arcade', the server
//              writes arcade_scores itself (like Filler).
//
// index.html holds only the empty #seasonal-game-rps shell, the `rpsRuntime`
// pre-declaration and the stopRpsRound() stub; the panel markup and CSS are
// built here (payload budget).

const RPS_COLS = 7;
const RPS_ROWS = 6;
const RPS_HOME_FIRST = (RPS_ROWS - 2) * RPS_COLS;   // first cell of your two home rows
const RPS_MAX_SCORE = 3000;
const RPS_LOOK = {
  R: { emoji: '✊', name: 'Zszywacz', kind: 'kamień' },
  P: { emoji: '✋', name: 'Faktura', kind: 'papier' },
  S: { emoji: '✌️', name: 'Niszczarka', kind: 'nożyce' },
  F: { emoji: '🚩', name: 'Flaga', kind: 'flaga' },
  T: { emoji: '🕳️', name: 'Pułapka', kind: 'pułapka' },
};
const RPS_FIGHT_MS = 1100;

(function rpsInjectCss() {
  if (document.getElementById('rps-css')) return;
  const s = document.createElement('style');
  s.id = 'rps-css';
  s.textContent = `
    .rps-stage { position: relative; width: 100%; max-width: 520px; margin: 0 auto; }
    .rps-board { display: grid; grid-template-columns: repeat(${RPS_COLS}, 1fr); gap: 3px;
      padding: 8px; border-radius: 12px; background: #5f9f2f;
      box-shadow: inset 0 0 0 2px #3f7a1b, 0 12px 30px rgba(15,23,42,.18);
      user-select: none; -webkit-user-select: none; }
    .rps-cell { position: relative; aspect-ratio: 1; border-radius: 6px; border: 0; padding: 0;
      display: flex; align-items: center; justify-content: center; cursor: default;
      font-size: clamp(18px, 6.2vw, 34px); line-height: 1; background: #a6d86b; transition: box-shadow .12s, transform .12s; }
    .rps-cell.alt { background: #93cb57; }
    .rps-cell.home-pick { cursor: pointer; box-shadow: inset 0 0 0 2px rgba(255,255,255,.55); }
    .rps-cell.can-pick { cursor: pointer; }
    .rps-cell.can-pick:hover { transform: translateY(-2px); }
    .rps-cell.sel { box-shadow: inset 0 0 0 3px #facc15, 0 0 12px rgba(250,204,21,.7); }
    .rps-cell.target { cursor: pointer; box-shadow: inset 0 0 0 3px rgba(255,255,255,.95); }
    .rps-cell.target::after { content: ''; position: absolute; width: 22%; height: 22%; border-radius: 50%; background: rgba(255,255,255,.85); }
    .rps-cell.target.enemy::after { background: rgba(239,68,68,.9); width: 30%; height: 30%; }
    .rps-cell.last { box-shadow: inset 0 0 0 3px rgba(239,68,68,.75); }
    .rps-tok { width: 84%; height: 84%; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      position: relative; box-shadow: 0 3px 0 rgba(0,0,0,.22); }
    .rps-tok.me { background: radial-gradient(circle at 35% 30%, #93c5fd, #2563eb); }
    .rps-tok.bot { background: radial-gradient(circle at 35% 30%, #fca5a5, #dc2626); }
    .rps-tok.static { border-radius: 10px; }
    .rps-tok .rps-q { font-size: .8em; font-weight: 800; color: #fff; font-family: system-ui, sans-serif; }
    .rps-tok .rps-eye { position: absolute; right: -4px; top: -4px; font-size: 11px; background: #fff; border-radius: 50%;
      width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
    .rps-tok.dead { opacity: .35; }
    .rps-duel, .rps-tie, .rps-end { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      border-radius: 12px; background: rgba(15,23,42,.55); z-index: 3; padding: 12px; }
    /* The end card sits low and lets the board show through: the fully
       revealed bot army is the best part of the post-mortem. */
    .rps-end { inset: auto 0 0 0; background: none; pointer-events: none; }
    .rps-end .rps-card { pointer-events: auto; padding: 10px 14px; }
    .rps-again { margin-top: 10px; }
    .rps-card { background: #fff; color: #0f172a; border-radius: 12px; padding: 16px 18px; text-align: center;
      box-shadow: 0 16px 40px rgba(0,0,0,.35); max-width: 340px; width: 100%; }
    .rps-duel-row { display: flex; align-items: center; justify-content: center; gap: 14px; font-size: 44px; margin: 6px 0; }
    .rps-duel-row .vs { font-size: 16px; font-weight: 800; color: #64748b; }
    .rps-duel-side { display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .rps-duel-side small { font-size: 11px; color: #64748b; }
    .rps-card h3 { margin: 0 0 4px; font-size: 17px; }
    .rps-card p { margin: 4px 0 0; font-size: 13px; color: #475569; }
    .rps-tie-btns { display: flex; gap: 8px; justify-content: center; margin-top: 12px; }
    .rps-tie-btns button { font-size: 34px; width: 72px; height: 72px; border-radius: 14px; border: 2px solid #cbd5e1;
      background: #f8fafc; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .rps-tie-btns button small { font-size: 10px; color: #475569; margin-top: 2px; }
    .rps-tie-btns button:hover { border-color: #2563eb; background: #eff6ff; }
    .rps-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .rps-legend { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--muted); justify-content: center; margin-top: 8px; }
  `;
  document.head.appendChild(s);
})();

// ── Panel markup ─────────────────────────────────────────────────────────────
(function rpsBuildPanel() {
  const root = document.getElementById('seasonal-game-rps');
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
          el('h2', { className: 'page-title' }, '„Papier, Kamień, Biuro G6" ✂️'),
          el('p', { className: 'page-sub' }, 'Pamiętasz RPS z ICQ? Wracamy. Czternastu pracowników na stronę, każdy w tajemnicy jest zszywaczem, fakturą albo niszczarką. Zdobądź flagę bota, zanim on zdobędzie Twoją.')),
        el('div', { className: 'bj-prizes', 'aria-label': 'Nagrody tygodniowe' },
          el('span', { className: 'bj-prize' }, '🥇 1000 🪙'),
          el('span', { className: 'bj-prize' }, '🥈 500 🪙'),
          el('span', { className: 'bj-prize' }, '🥉 200 🪙'))),
      el('div', { className: 'bj-rules' },
        el('div', { className: 'bj-rules-title' }, 'Jak grać'),
        el('ul', {},
          li('Najpierw kliknij na swoich dwóch rzędach, gdzie stoi ', el('strong', {}, '🚩 flaga'), ', a potem ', el('strong', {}, '🕳️ pułapka'), '. Resztę pionków serwer rozdaje losowo: po 4 z każdego rodzaju.'),
          li(el('strong', {}, '✊ Zszywacz'), ' bije ✌️ Niszczarkę, ', el('strong', {}, '✌️ Niszczarka'), ' bije ✋ Fakturę, ', el('strong', {}, '✋ Faktura'), ' bije ✊ Zszywacz.'),
          li('Kliknij swój pionek, potem pole obok (góra, dół, lewo, prawo). Wejście na wroga to pojedynek: oba pionki się odkrywają, przegrany znika. Przy remisie obaj wybieracie znak jeszcze raz.'),
          li('Kto wejdzie na pułapkę, ginie. Kto wejdzie na flagę, wygrywa. Flaga i pułapka nigdy się nie ruszają, bot wie o tym tak samo jak Ty. 👁 na Twoim pionku znaczy, że bot już go widział.'),
          li(el('strong', {}, 'Punkty:'), ' wygrana 1000 + 60 za każdego ocalałego + do 800 za tempo (−8 za ruch). Przegrana: 25 za każdego zbitego wroga. Liczy się najlepsza partia tygodnia.'))),
      el('div', { className: 'bj-stats' },
        stat('Wynik', 'rps-score', '0'),
        stat('Ruchy', 'rps-moves', '0'),
        stat('Zbici wrogowie', 'rps-kills', '0'),
        stat('Twoi w grze', 'rps-alive', '12')),
      el('div', { className: 'rps-stage', id: 'rps-stage' }, el('div', { className: 'rps-board', id: 'rps-board' })),
      el('div', { className: 'rps-legend' },
        el('span', {}, '✊ Zszywacz = kamień'), el('span', {}, '✋ Faktura = papier'), el('span', {}, '✌️ Niszczarka = nożyce')),
      el('div', { className: 'bj-actions rps-actions' },
        el('button', { className: 'btn-primary bj-start-btn', id: 'rps-start-btn' }, 'Start partii'),
        el('button', { className: 'btn-ghost', id: 'rps-random-btn' }, '🎲 Losuj flagę i pułapkę'),
        el('button', { className: 'btn-ghost hidden', id: 'rps-resign-btn' }, '🏳️ Poddaj się'),
        el('div', { className: 'bj-status', id: 'rps-status' }, 'Kliknij pole na dole, żeby postawić flagę.'))),
    el('aside', { className: 'bj-board-panel' },
      board('Ten tydzień', {}, 'rps-weekly-board', 'rps-week-label'),
      board('All-time', { text: 'rekordy' }, 'rps-alltime-board'),
      board('Ostatnie nagrody', { text: 'wypłata: po tygodniu', title: 'Top 3 z minionego tygodnia dostają nagrody w poniedziałek po zamknięciu tygodnia.' }, 'rps-awards'))));
})();

const rpsBoardEl  = document.getElementById('rps-board');
const rpsStageEl  = document.getElementById('rps-stage');
const rpsStartBtn = document.getElementById('rps-start-btn');
const rpsRandBtn  = document.getElementById('rps-random-btn');
const rpsResignBtn = document.getElementById('rps-resign-btn');
const rpsStatus   = document.getElementById('rps-status');

function newRpsRuntime() {
  return {
    playing: false,     // a server match is running
    busy: false,        // a request / fight animation is in flight
    round: null,        // server round payload { id, mode, status, score, board }
    flag: null, trap: null,   // setup picks
    sel: null,          // selected own cell
    last: [],           // cells of the last bot action, outlined
    overlay: null,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function rpsLegalTargets(board, from) {
  const c = board.cells[from];
  if (!c || c.o !== 0 || !'RPS'.includes(c.t || '-')) return [];
  const x = from % RPS_COLS, y = Math.floor(from / RPS_COLS);
  const out = [];
  if (y > 0) out.push(from - RPS_COLS);
  if (y < RPS_ROWS - 1) out.push(from + RPS_COLS);
  if (x > 0) out.push(from - 1);
  if (x < RPS_COLS - 1) out.push(from + 1);
  return out.filter(j => !board.cells[j] || board.cells[j].o !== 0);
}

function rpsToken(c, over) {
  const mine = c.o === 0;
  const isStatic = c.t === 'F' || c.t === 'T';
  const tok = el('div', { className: 'rps-tok ' + (mine ? 'me' : 'bot') + (isStatic ? ' static' : '') });
  if (c.t) tok.append(RPS_LOOK[c.t].emoji);
  else tok.append(el('span', { className: 'rps-q' }, '?'));
  if (mine && c.r && !over) tok.append(el('span', { className: 'rps-eye', title: 'Bot już zna ten pionek' }, '👁'));
  tok.title = c.t ? (mine ? 'Twój: ' : 'Wróg: ') + RPS_LOOK[c.t].name + ' (' + RPS_LOOK[c.t].kind + ')' : 'Nieznany pionek wroga' + (c.m ? '' : ' — jeszcze się nie ruszył');
  return tok;
}

function rpsRender() {
  const rt = rpsRuntime || (rpsRuntime = newRpsRuntime());
  if (!rpsBoardEl) return;
  const board = rt.round?.board;
  const cellsOut = [];
  const targets = board && rt.sel != null ? rpsLegalTargets(board, rt.sel) : [];
  const myTurn = board && board.turn === 0 && !board.pending && !board.result && !rt.busy;

  for (let i = 0; i < RPS_COLS * RPS_ROWS; i++) {
    const x = i % RPS_COLS, y = Math.floor(i / RPS_COLS);
    const node = el('button', { type: 'button', className: 'rps-cell' + ((x + y) % 2 ? ' alt' : '') });
    node.dataset.i = i;
    if (!board) {
      // Setup: the bot's rows are a wall of unknowns, yours are slots.
      if (i < 2 * RPS_COLS) node.append(rpsToken({ o: 1, t: null, m: false }));
      else if (i >= RPS_HOME_FIRST) {
        node.classList.add('home-pick');
        if (i === rt.flag) node.append(rpsToken({ o: 0, t: 'F' }));
        else if (i === rt.trap) node.append(rpsToken({ o: 0, t: 'T' }));
        else node.append(el('div', { className: 'rps-tok me', style: 'opacity:.45' }, el('span', { className: 'rps-q' }, '·')));
      }
    } else {
      const c = board.cells[i];
      if (c) node.append(rpsToken(c, !!board.result));
      if (myTurn && c && c.o === 0 && 'RPS'.includes(c.t) && rpsLegalTargets(board, i).length) node.classList.add('can-pick');
      if (rt.sel === i) node.classList.add('sel');
      if (targets.includes(i)) { node.classList.add('target'); if (c) node.classList.add('enemy'); }
      if (rt.last.includes(i)) node.classList.add('last');
    }
    cellsOut.push(node);
  }
  rpsBoardEl.replaceChildren(...cellsOut);
  rpsSetStats();
  rpsSetButtons();
}

function rpsSetStats() {
  const b = rpsRuntime?.round?.board;
  const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = String(v); };
  set('rps-score', rpsRuntime?.round?.score || 0);
  set('rps-moves', b ? b.moves[0] : 0);
  set('rps-kills', b ? b.kills[0] : 0);
  set('rps-alive', b ? b.cells.filter(c => c && c.o === 0 && 'RPS'.includes(c.t)).length : 12);
}

function rpsSetButtons() {
  const rt = rpsRuntime;
  const inMatch = !!rt?.playing;
  if (rpsStartBtn) {
    rpsStartBtn.classList.toggle('hidden', inMatch);
    rpsStartBtn.disabled = !!rt?.busy || rt?.flag == null || rt?.trap == null;
    rpsStartBtn.textContent = rt?.busy && !inMatch ? 'Ładuję...' : 'Start partii';
  }
  if (rpsRandBtn) rpsRandBtn.classList.toggle('hidden', inMatch);
  if (rpsResignBtn) { rpsResignBtn.classList.toggle('hidden', !inMatch); rpsResignBtn.disabled = !!rt?.busy; }
}

function rpsSetStatus(text) { if (rpsStatus) rpsStatus.textContent = text; }

function rpsOverlay(node) {
  const rt = rpsRuntime;
  if (rt.overlay) rt.overlay.remove();
  rt.overlay = node;
  if (node && rpsStageEl) rpsStageEl.appendChild(node);
}

// ── Fight playback ──────────────────────────────────────────────────────────

function rpsDuelCard(ev) {
  const mineAtt = ev.side === 0;
  const myT = mineAtt ? ev.a : ev.d;
  const theirT = mineAtt ? ev.d : ev.a;
  let title, text;
  if (ev.out === 'flag') {
    title = mineAtt ? '🏆 Flaga zdobyta!' : '💀 Bot zdobył Twoją flagę';
    text = mineAtt ? 'Partia wygrana.' : 'Partia przegrana.';
  } else if (ev.out === 'trap') {
    title = mineAtt ? '🕳️ Pułapka!' : '🕳️ Bot wpadł w Twoją pułapkę!';
    text = mineAtt ? 'Twój ' + RPS_LOOK[ev.a].name + ' przepada.' : 'Jego ' + RPS_LOOK[ev.a].name + ' przepada.';
  } else if (ev.out === 'tie') {
    title = '🤝 Remis!';
    text = 'Obaj wybieracie jeszcze raz.';
  } else {
    const iWon = (ev.out === 'att') === mineAtt;
    title = iWon ? '✅ Wygrywasz pojedynek' : '❌ Przegrywasz pojedynek';
    text = RPS_LOOK[iWon ? myT : theirT].name + ' bije ' + RPS_LOOK[iWon ? theirT : myT].name + '.';
  }
  const side = (t, who) => el('div', { className: 'rps-duel-side' }, RPS_LOOK[t].emoji, el('small', {}, who + ': ' + RPS_LOOK[t].name));
  return el('div', { className: 'rps-duel' }, el('div', { className: 'rps-card' },
    el('h3', {}, title),
    el('div', { className: 'rps-duel-row' }, side(myT, 'Ty'), el('span', { className: 'vs' }, 'VS'), side(theirT, 'Bot')),
    el('p', {}, text)));
}

async function rpsPlayEvents(events) {
  const rt = rpsRuntime;
  rt.last = [];
  for (const ev of events || []) {
    if (ev.side === 1) rt.last = [ev.from, ev.to];
    if (ev.k !== 'fight') continue;
    rpsOverlay(rpsDuelCard(ev));
    await new Promise(r => setTimeout(r, ev.out === 'flag' ? 1600 : RPS_FIGHT_MS));
    if (rpsRuntime !== rt) return;    // stopped meanwhile
  }
  rpsOverlay(null);
}

function rpsShowTie() {
  const pick = t => el('button', { type: 'button', onclick: () => rpsAct({ action: 'tie', choice: t }) },
    RPS_LOOK[t].emoji, el('small', {}, RPS_LOOK[t].name));
  rpsOverlay(el('div', { className: 'rps-tie' }, el('div', { className: 'rps-card' },
    el('h3', {}, '🤝 Remis — wybierz jeszcze raz'),
    el('p', {}, 'Bot wybiera w tym samym momencie. Twój pionek zostaje tym, co wybierzesz.'),
    el('div', { className: 'rps-tie-btns' }, pick('R'), pick('P'), pick('S')))));
}

function rpsShowEnd(round, summary) {
  const b = round.board;
  const won = b.result === 'won';
  const why = { flag: won ? 'Zdobyłeś flagę bota.' : 'Bot zdobył Twoją flagę.', stuck: won ? 'Bot nie ma już czym się ruszyć.' : 'Nie masz już czym się ruszyć.', resign: 'Poddałeś partię.', plies: 'Limit ruchów wyczerpany.' }[b.reason] || '';
  const score = summary?.score ?? round.score ?? 0;
  const saved = round.mode === 'arcade' ? 'Zapisano w rankingu arcade.' : 'Zapisano w rankingu tygodnia.';
  rpsOverlay(el('div', { className: 'rps-end' }, el('div', { className: 'rps-card' },
    el('h3', {}, won ? '🏆 Wygrana!' : '💼 Przegrana'),
    el('p', {}, why),
    el('p', {}, el('strong', {}, 'Wynik: ' + score), summary?.itemEffect ? ' (w tym +' + summary.itemEffect.bonus + ' z przedmiotu)' : ''),
    el('p', {}, saved + ' Plansza pokazuje teraz wszystkie pionki bota.'),
    el('button', { type: 'button', className: 'btn-primary rps-again', onclick: () => rpsNewSetup() }, 'Zagraj ponownie'))));
  rpsSetStatus((won ? 'Wygrana' : 'Przegrana') + ' · wynik ' + score + '.');
}

// ── Flow ────────────────────────────────────────────────────────────────────

function rpsNewSetup() {
  const keep = rpsRuntime;
  rpsRuntime = newRpsRuntime();
  if (keep?.overlay) keep.overlay.remove();
  rpsSetStatus('Kliknij pole na dole, żeby postawić 🚩 flagę.');
  rpsRender();
}

function stopRpsRound() {
  // The match itself lives on the server and survives leaving the tab; this
  // only drops the local view. loadRpsState() resumes it.
  if (rpsRuntime?.overlay) rpsRuntime.overlay.remove();
  rpsRuntime = newRpsRuntime();
  rpsRender();
}

function rpsRandomSetup() {
  const rt = rpsRuntime;
  if (rt.playing || rt.busy) return;
  const back = RPS_HOME_FIRST + RPS_COLS;
  rt.flag = back + Math.floor(Math.random() * RPS_COLS);
  const col = rt.flag % RPS_COLS;
  const guards = [rt.flag - RPS_COLS];
  if (col > 0) guards.push(rt.flag - 1);
  if (col < RPS_COLS - 1) guards.push(rt.flag + 1);
  rt.trap = Math.random() < 0.5 ? guards[Math.floor(Math.random() * guards.length)] : null;
  while (rt.trap == null || rt.trap === rt.flag) rt.trap = RPS_HOME_FIRST + Math.floor(Math.random() * 2 * RPS_COLS);
  rpsSetStatus('Gotowe. Możesz jeszcze przestawić, klikając pola, albo zaczynać.');
  rpsRender();
}

function rpsApplyRound(round) {
  const rt = rpsRuntime;
  rt.round = round;
  rt.playing = !!round && round.status === 'active';
  rt.sel = null;
}

function rpsStatusForBoard() {
  const b = rpsRuntime.round?.board;
  if (!b || b.result) return;
  if (b.pending) rpsSetStatus('Remis — wybierz znak.');
  else if (b.turn === 0) rpsSetStatus('Twój ruch. Kliknij swój pionek, potem pole obok.');
  else rpsSetStatus('Bot myśli...');
}

async function rpsStart() {
  const rt = rpsRuntime;
  if (rt.playing || rt.busy || rt.flag == null || rt.trap == null) return;
  rt.busy = true;
  rpsSetButtons();
  rpsSetStatus('Rozdaję pionki...');
  try {
    const data = await invokeRps({ action: 'start', flag: rt.flag, trap: rt.trap, mode: allGamesMode ? 'arcade' : 'season' });
    rpsApplyRound(data.round);
  } catch (err) {
    showToast('❌ ' + err.message);
    rpsSetStatus('Nie udało się rozpocząć partii.');
  } finally {
    rt.busy = false;
    rpsRender();
    rpsStatusForBoard();
  }
}

async function rpsAct(payload) {
  const rt = rpsRuntime;
  if (!rt.playing || rt.busy) return;
  rt.busy = true;
  rt.sel = null;
  rpsOverlay(null);
  rpsRender();
  try {
    const data = await invokeRps(payload);
    if (rpsRuntime !== rt) return;
    // Play the fights over the board as it stood, then show the result.
    await rpsPlayEvents(data.events);
    if (rpsRuntime !== rt) return;
    rpsApplyRound(data.round);
    rt.busy = false;
    rpsRender();
    const b = data.round.board;
    if (b.result) {
      rpsShowEnd(data.round, data.summary);
      if (data.round.mode === 'arcade') loadArcadeScores('rps');
      else if (data.weekly) rpsRenderState(data);
      if (data.summary) showToast((b.result === 'won' ? '🏆 ' : '💼 ') + 'Wynik zapisany: ' + data.summary.score);
    } else if (b.pending) {
      rpsShowTie();
      rpsStatusForBoard();
    } else rpsStatusForBoard();
  } catch (err) {
    showToast('❌ ' + err.message);
    rt.busy = false;
    rpsRender();
  }
}

function rpsOnCell(i) {
  const rt = rpsRuntime;
  if (rt.busy) return;
  if (!rt.playing) {
    if (rt.round) return;                       // finished board on display
    if (i < RPS_HOME_FIRST) return;
    if (i === rt.flag) rt.flag = null;
    else if (i === rt.trap) rt.trap = null;
    else if (rt.flag == null) rt.flag = i;
    else if (rt.trap == null) rt.trap = i;
    else rt.trap = i;                           // both set: move the trap
    rpsSetStatus(rt.flag == null ? 'Kliknij pole na dole, żeby postawić 🚩 flagę.'
      : rt.trap == null ? 'Teraz 🕳️ pułapka: najlepiej tam, gdzie bot będzie szukał flagi.'
      : 'Gotowe. Kliknij „Start partii".');
    rpsRender();
    return;
  }
  const b = rt.round.board;
  if (b.turn !== 0 || b.pending || b.result) return;
  const c = b.cells[i];
  if (rt.sel != null && rpsLegalTargets(b, rt.sel).includes(i)) {
    rpsAct({ action: 'move', from: rt.sel, to: i });
    return;
  }
  rt.sel = c && c.o === 0 && 'RPS'.includes(c.t) && rt.sel !== i ? i : null;
  rpsRender();
}

async function rpsResign() {
  if (!rpsRuntime.playing || rpsRuntime.busy) return;
  if (!confirm('Poddać partię? Liczy się jak przegrana.')) return;
  rpsAct({ action: 'resign' });
}

// ── Networking + leaderboards ───────────────────────────────────────────────

async function invokeRps(payload) {
  const { data, error } = await sb.functions.invoke('rps-action', { body: payload });
  if (error) throw new Error(error.message || 'Nie udało się połączyć z grą.');
  if (!data || data.ok === false) throw new Error(data?.error || 'Błąd gry.');
  return data;
}

async function loadRpsState(showSpinner = true) {
  if (!rpsRuntime) rpsRuntime = newRpsRuntime();
  rpsRender();
  const weeklyWrap  = document.getElementById('rps-weekly-board');
  const allTimeWrap = document.getElementById('rps-alltime-board');
  const awardsWrap  = document.getElementById('rps-awards');
  if (showSpinner) {
    if (weeklyWrap)  weeklyWrap.replaceChildren(makeSpinner());
    if (allTimeWrap) allTimeWrap.replaceChildren(makeSpinner());
    if (awardsWrap)  awardsWrap.replaceChildren();
  }
  try {
    const data = await invokeRps({ action: 'state' });
    rpsRenderState(data);
    // Resume a match left running (another tab, a reload).
    if (data.round && !rpsRuntime.busy && !rpsRuntime.playing) {
      rpsApplyRound(data.round);
      rpsRender();
      if (data.round.board.pending) rpsShowTie();
      rpsStatusForBoard();
    }
  } catch (err) {
    const msg = err.message || 'Nie udało się wczytać gry.';
    if (weeklyWrap)  weeklyWrap.replaceChildren(el('p', { className: 'bj-empty' }, msg));
    if (allTimeWrap) allTimeWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Brak danych.'));
    if (awardsWrap)  awardsWrap.replaceChildren(el('p', { className: 'bj-empty' }, 'Wdróż SQL i funkcję Edge, żeby aktywować grę.'));
  }
}

function rpsRenderState(data) {
  if (data.profile) { me.coins = data.profile.coins; setText(headerCoins, me.coins); }
  const weekLabel = document.getElementById('rps-week-label');
  if (weekLabel) weekLabel.textContent = whackBossWeekRange(data.weekStart)?.short || '';
  rpsRenderTable(document.getElementById('rps-weekly-board'), data.weekly || [], 'weekly');
  rpsRenderTable(document.getElementById('rps-alltime-board'), data.allTime || [], 'allTime');
  rpsRenderAwards(document.getElementById('rps-awards'), data.awards || []);
}

function rpsRenderTable(wrap, rows, mode) {
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
    lbScoreCell(row)));
  wrap.replaceChildren(el('table', { className: 'lb-table-compact' },
    el('thead', {}, el('tr', {},
      el('th', {}, '#'), el('th', {}, 'Nick'),
      el('th', { title: 'Wygrane / rozegrane partie' }, '🏆'),
      el('th', { title: 'Najlepszy wynik' }, 'Wynik'))),
    el('tbody', {}, ...bodyRows)));
}

function rpsRenderAwards(wrap, awards) {
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

if (rpsBoardEl) rpsBoardEl.addEventListener('click', evt => {
  const cell = evt.target.closest('.rps-cell');
  if (cell) rpsOnCell(Number(cell.dataset.i));
});
if (rpsStartBtn) rpsStartBtn.addEventListener('click', rpsStart);
if (rpsRandBtn) rpsRandBtn.addEventListener('click', rpsRandomSetup);
if (rpsResignBtn) rpsResignBtn.addEventListener('click', rpsResign);

if (!rpsRuntime) rpsRuntime = newRpsRuntime();
rpsRender();
