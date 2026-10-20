// ════════════════════════════════════════════════════════════════════════════
//  📦 Archiwum — read-only history of the tabs archived on 2026-10-20
//  (ARCHIVED_TABS in index.html). Lazy module: TAB_MODULES.archive.
//
//  Everything comes from one call, archive_summary() (supabase/archive.sql),
//  plus the canvas pixels and the lottery draw, which every player could
//  already read. Nothing here
//  writes — there is no button that bets, trades or paints. To bring a tab
//  back, delete its name from ARCHIVED_TABS; its own code is still inline.
// ════════════════════════════════════════════════════════════════════════════

const ARC_CLOSED_ON = '20.10.2026';
const ARC_CASINO = {
  roulette: { icon: '🎲', name: 'Ruletka' },
  crash:    { icon: '🚀', name: 'Rakieta' },
  slots:    { icon: '🎰', name: 'Sloty' },
  mines:    { icon: '💣', name: 'Miny G6' },
  wheel:    { icon: '🦬', name: 'Koło Żubra' },
};
let arcData = null;      // archive_summary() payload — it never changes, so one fetch a session
let arcLoading = null;

(function archiveCss() {
  const s = document.createElement('style');
  s.textContent = `
    #tab-archive main { max-width: 1100px; }
    .arc-head h2 { margin: 0 0 4px; font-size: 22px; }
    .arc-lead { margin: 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    .arc-sec { border: 1px solid var(--border); border-radius: 14px; background: var(--card); padding: 14px 16px; margin: 0 0 14px; }
    .arc-sec h3 { margin: 0 0 2px; font-size: 16px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .arc-when { font-size: 12px; font-weight: 500; color: var(--muted); }
    .arc-kpis { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
    .arc-kpi { font-size: 12px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); }
    .arc-kpi b { font-variant-numeric: tabular-nums; }
    .arc-note { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
    .arc-table-wrap { overflow-x: auto; margin-top: 8px; }
    .arc-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .arc-table th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11px; padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
    .arc-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
    .arc-table tr:last-child td { border-bottom: 0; }
    .arc-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .arc-table .nw { white-space: nowrap; }
    .arc-pos { color: #15803d; } .arc-neg { color: #b91c1c; }
    .arc-res { font-weight: 700; white-space: nowrap; }
    .arc-canvas-wrap { margin-top: 10px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: #e2e8f0; aspect-ratio: 192 / 108; }
    .arc-canvas-wrap canvas { display: block; width: 100%; height: 100%; image-rendering: pixelated; }
    .arc-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
    .arc-two > .arc-sec { margin: 0; }
  `;
  document.head.append(s);
})();

function arcN(n) { return Math.round(Number(n) || 0).toLocaleString('pl-PL'); }
function arcDate(iso) { return iso ? String(iso).slice(8, 10) + '.' + String(iso).slice(5, 7) + '.' + String(iso).slice(0, 4) : '—'; }
function arcSpan(a, b) { return arcDate(a) + ' – ' + arcDate(b); }
function arcSigned(n) {
  const v = Math.round(Number(n) || 0);
  return el('span', { className: v > 0 ? 'arc-pos' : v < 0 ? 'arc-neg' : '' }, (v > 0 ? '+' : '') + arcN(v) + ' 🪙');
}
function arcKpi(label, value) { return el('span', { className: 'arc-kpi' }, label + ': ', el('b', {}, value)); }
function arcTable(head, rows) {
  const t = el('table', { className: 'arc-table' });
  const hr = el('tr', {});
  const cls = h => h.num ? 'num' : h.nw ? 'nw' : '';
  head.forEach(h => hr.append(el('th', { className: cls(h) }, h.label)));
  t.append(el('thead', {}, hr));
  const tb = el('tbody', {});
  rows.forEach(cells => {
    const tr = el('tr', {});
    cells.forEach((c, i) => {
      const td = el('td', { className: cls(head[i]) });
      td.append(c == null ? '—' : c);
      tr.append(td);
    });
    tb.append(tr);
  });
  t.append(tb);
  return el('div', { className: 'arc-table-wrap' }, t);
}
function arcSec(icon, title, when) {
  return el('section', { className: 'arc-sec' },
    el('h3', {}, icon + ' ' + title, when ? el('span', { className: 'arc-when' }, when) : ''));
}

async function loadArchive() {
  const body = document.getElementById('archive-body');
  if (!body) return;
  if (!arcData) {
    try {
      arcLoading = arcLoading || sb.rpc('archive_summary');
      const { data, error } = await arcLoading;
      if (error) throw error;
      arcData = data;
    } catch (e) {
      arcLoading = null;
      console.error('archive', e);
      body.replaceChildren(el('div', { className: 'farm-empty' }, 'Nie udało się wczytać archiwum. Spróbuj ponownie.'));
      return;
    }
  }
  renderArchive(body, arcData);
}

function renderArchive(body, d) {
  body.replaceChildren();
  body.append(el('div', { className: 'arc-head' },
    el('h2', {}, '📦 Archiwum'),
    el('p', { className: 'arc-lead' },
      'Te zakładki zamknęliśmy ' + ARC_CLOSED_ON + ' — od ponad miesiąca nikt z nich nie korzystał. ',
      'Nie da się w nich już grać ani obstawiać, ale cała historia zostaje tutaj do wglądu. ',
      'Twoje dawne wyniki nadal widać też w 📈 Statystykach.')));

  body.append(arcCanvasSection(d.canvas));
  body.append(arcMarketsSection(d.markets || []));
  body.append(arcFootballSection(d.football));
  body.append(arcLotterySection());
  body.append(arcCasinoSection(d.casino || []));
  body.append(arcPokerSection(d.poker));
}

// ── 🎨 Wspólne Płótno: the final picture, as the office left it ──────────────
function arcCanvasSection(c) {
  const sec = arcSec('🎨', 'Wspólne Płótno', c ? arcSpan(c.first_at, c.last_at) : '');
  if (c) {
    sec.append(el('div', { className: 'arc-kpis' },
      arcKpi('Pomalowanych pikseli', arcN(c.paints)), arcKpi('Malarzy', arcN(c.painters))));
    const top = (c.ranking || []).slice(0, 3).map((r, i) => ['🥇', '🥈', '🥉'][i] + ' ' + r.nick + ' (' + arcN(r.n) + ')').join('   ');
    if (top) sec.append(el('div', { className: 'arc-note' }, 'Najpracowitsi: ' + top));
  }
  const cv = el('canvas', { width: CANVAS_W, height: CANVAS_H, 'aria-label': 'Ostatni stan Wspólnego Płótna' });
  sec.append(el('div', { className: 'arc-canvas-wrap' }, cv));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  fetchAllCanvasPixels().then(px => {
    px.forEach(p => { ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 1, 1); });
  }).catch(e => console.warn('archive canvas', e));
  return sec;
}

// ── 📊 Rynki: every market and how it ended ──────────────────────────────────
function arcMarketsSection(list) {
  const first = list.length ? list[list.length - 1].created_at : null;
  const last = list.length ? list[0].created_at : null;
  const sec = arcSec('📊', 'Rynki', list.length ? arcSpan(first, last) : '');
  const pot = list.reduce((a, m) => a + Number(m.pot || 0), 0);
  sec.append(el('div', { className: 'arc-kpis' }, arcKpi('Rynków', arcN(list.length)), arcKpi('Postawiono łącznie', arcN(pot) + ' 🪙')));
  const res = r => r === 'YES' ? el('span', { className: 'arc-res arc-pos' }, 'TAK') : r === 'NO' ? el('span', { className: 'arc-res arc-neg' }, 'NIE') : 'nierozstrzygnięty';
  sec.append(arcTable(
    [{ label: 'Pytanie' }, { label: 'Wynik' }, { label: 'Pula', num: true }, { label: 'Graczy', num: true }, { label: 'Autor', nw: true }, { label: 'Założony', nw: true }],
    list.map(m => [(m.icon ? m.icon + ' ' : '') + m.title, res(m.resolution), arcN(m.pot) + ' 🪙', arcN(m.traders), m.creator || '—', arcDate(m.created_at)])));
  return sec;
}

// ── ⚽ Mundial 2026 ──────────────────────────────────────────────────────────
function arcFootballSection(f) {
  const sec = arcSec('⚽', 'Mundial 2026', f ? arcSpan(f.first_at, f.last_at) : '');
  if (!f) return sec;
  sec.append(el('div', { className: 'arc-kpis' },
    arcKpi('Meczów', arcN(f.matches)), arcKpi('Zakładów', arcN(f.bets)), arcKpi('Typujących', arcN(f.players)),
    arcKpi('Postawiono', arcN(f.staked) + ' 🪙'), arcKpi('Wypłacono', arcN(f.paid) + ' 🪙'),
    el('span', { className: 'arc-kpi' }, 'Wynik banku: ', arcSigned(Number(f.staked) - Number(f.paid)))));
  if (f.best_win) sec.append(el('div', { className: 'arc-note' },
    '🏆 Największa wygrana: ' + f.best_win.nick + ' — ' + arcN(f.best_win.payout) + ' 🪙 (' + f.best_win.match + ', kurs ' +
    Number(f.best_win.odds).toFixed(2).replace('.', ',') + ')'));
  sec.append(arcTable(
    [{ label: '#' }, { label: 'Gracz', nw: true }, { label: 'Typy', num: true }, { label: 'Trafione', num: true }, { label: 'Bilans', num: true }],
    (f.ranking || []).map((r, i) => [String(i + 1), r.nick, arcN(r.bets), arcN(r.hits), arcSigned(r.net)])));
  return sec;
}

// ── 🎟️ Loteria po Mundialu: the one draw, read straight from lottery_draws ──
// (public SELECT; the section fills in when the query lands).
const ARC_MEDAL = ['🥇', '🥈', '🥉'];
function arcLotterySection() {
  const sec = arcSec('🎟️', 'Loteria po Mundialu', '');
  const slot = el('div', { className: 'arc-note' }, 'Ładowanie…');
  sec.append(slot);
  sb.from('lottery_draws')
    .select('pool, total_tickets, player_count, dividend_each, paid_total, drawn_at, winners')
    .eq('status', 'drawn').order('drawn_at', { ascending: false })
    .then(({ data, error }) => {
      if (error || !data?.length) { slot.textContent = error ? 'Nie udało się wczytać losowania.' : 'Losowanie się nie odbyło.'; return; }
      const dr = data[0];
      sec.querySelector('h3').append(el('span', { className: 'arc-when' }, 'losowanie ' + arcDate(dr.drawn_at)));
      slot.replaceWith(
        el('div', { className: 'arc-kpis' },
          arcKpi('Pula', arcN(dr.pool) + ' 🪙'), arcKpi('Losów', arcN(dr.total_tickets)), arcKpi('Uczestników', arcN(dr.player_count)),
          arcKpi('Dywidenda dla każdego', arcN(dr.dividend_each) + ' 🪙'), arcKpi('Wypłacono', arcN(dr.paid_total) + ' 🪙')),
        arcTable(
          [{ label: 'Miejsce' }, { label: 'Gracz', nw: true }, { label: 'Losów', num: true }, { label: 'Nagroda', num: true }],
          (dr.winners || []).slice().sort((a, b) => a.place - b.place)
            .map(w => [(ARC_MEDAL[w.place - 1] || '') + ' ' + w.place + '.', w.nick, arcN(w.tickets), arcN(w.prize) + ' 🪙'])));
    });
  return sec;
}

// ── 🎰 Kasyno: the five archived house games ─────────────────────────────────
function arcCasinoSection(rows) {
  const sec = arcSec('🎰', 'Kasyno', '');
  sec.append(el('div', { className: 'arc-note' }, 'Wynik kasyna = postawione minus wypłacone (na minusie, gdy gracze wygrali więcej, niż postawili).'));
  sec.append(arcTable(
    [{ label: 'Gra', nw: true }, { label: 'Rund', num: true }, { label: 'Graczy', num: true }, { label: 'Postawiono', num: true },
     { label: 'Wynik kasyna', num: true }, { label: 'Największa wygrana', nw: true }, { label: 'Najlepszy gracz', nw: true }, { label: 'Okres', nw: true }],
    rows.map(g => {
      const meta = ARC_CASINO[g.game] || { icon: '🎲', name: g.game };
      return [meta.icon + ' ' + meta.name, arcN(g.rounds), arcN(g.players), arcN(g.bet) + ' 🪙',
        arcSigned(Number(g.bet) - Number(g.won)),
        g.best_win ? g.best_win.nick + ' — ' + arcN(g.best_win.won) + ' 🪙' : null,
        g.top ? el('span', {}, g.top.nick + ' ', arcSigned(g.top.net)) : null,
        arcSpan(g.first_at, g.last_at)];
    })));
  return sec;
}

// ── ♠️ Poker ─────────────────────────────────────────────────────────────────
function arcPokerSection(p) {
  const sec = arcSec('♠️', 'Poker', p ? arcSpan(p.first_at, p.last_at) : '');
  if (!p) return sec;
  sec.append(el('div', { className: 'arc-kpis' },
    arcKpi('Rozdań', arcN(p.hands)), arcKpi('Graczy', arcN(p.players)), arcKpi('Wejść do stołu', arcN(p.buy_ins))));
  sec.append(arcTable(
    [{ label: '#' }, { label: 'Gracz' }, { label: 'Bilans (wypłaty − wpisowe)', num: true }],
    (p.ranking || []).map((r, i) => [String(i + 1), r.nick, arcSigned(r.net)])));
  return sec;
}
