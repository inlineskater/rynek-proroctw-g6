// ════════════════════════════════════════════════════════════════════════════
//  🗳️ Pomysły + 🐞 Zgłoszenia („Głos Biura") — ideas, votes, bug tickets and
//  the public log. ONE module, TWO nav tabs (`community`, `bugs`), like
//  plinko.js serves Plinko and Koło Żubra. Backend: supabase/community.sql.
//
//  Everything comes from one call, community_state(). The writes are three
//  player RPCs (submit idea, toggle vote, submit ticket); everything that
//  decides — closing a week, marking an idea shipped, judging a ticket and
//  paying the reward — is done by the scheduled Claude Code runs described in
//  docs/community-automation.md, and arrives here through the public log.
// ════════════════════════════════════════════════════════════════════════════

let coState = null;
// Sub-view per nav tab.  community: ideas | winners | log
//                       bugs:      report | list | log
const coView = { community: 'ideas', bugs: 'report' };
let coLoading = null;
let coRefreshTimer = null;

const CO_IDEA_STATUS = {
  open:     ['🗳️', 'głosowanie'],
  won:      ['🏆', 'wygrał — czeka na budowę'],
  building: ['🛠️', 'w budowie'],
  shipped:  ['🚀', 'wdrożony'],
  rejected: ['❌', 'odrzucony'],
  lost:     ['·',  'nie wygrał'],
};
const CO_TICKET_STATUS = {
  new:        ['🆕', 'nowe — czeka na analizę'],
  confirmed:  ['✅', 'potwierdzony błąd'],
  fixing:     ['🛠️', 'w naprawie'],
  fixed:      ['🎉', 'naprawione'],
  not_a_bug:  ['🙅', 'to nie błąd'],
  wontfix:    ['⏸️', 'nie naprawiamy'],
  duplicate:  ['🔁', 'duplikat'],
  needs_info: ['❓', 'potrzeba więcej informacji'],
};
const CO_KINDS = { bug: '🐞 Błąd', problem: '😕 Problem', exploit: '🔒 Exploit / luka' };
const CO_ERRORS = {
  idea_limit:    'Możesz zgłosić najwyżej 2 pomysły w tygodniu.',
  too_fast:      'Chwila — odczekaj 30 sekund.',
  bad_title:     'Tytuł musi mieć 3–80 znaków.',
  body_too_long: 'Opis jest za długi.',
  voting_closed: 'Głosowanie na ten pomysł jest już zamknięte.',
  own_idea:      'Nie możesz głosować na własny pomysł.',
  ticket_limit:  'Najwyżej 5 zgłoszeń dziennie.',
};

(function communityCss() {
  const s = document.createElement('style');
  s.textContent = `
    #tab-community main, #tab-bugs main { max-width: 980px; }
    .co-head h2 { margin: 0 0 4px; font-size: 22px; }
    .co-lead { margin: 0 0 14px; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .co-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
    .co-tab { border: 1px solid var(--border); background: var(--card); border-radius: 999px; padding: 7px 14px; font: inherit; font-size: 13px; cursor: pointer; color: inherit; }
    .co-tab.on { background: var(--text, #111); color: var(--card, #fff); border-color: transparent; }
    .co-sec { border: 1px solid var(--border); border-radius: 14px; background: var(--card); padding: 14px 16px; margin: 0 0 12px; }
    .co-sec h3 { margin: 0 0 8px; font-size: 15px; }
    .co-muted { color: var(--muted); font-size: 12px; }
    .co-row { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid var(--border); }
    .co-row:last-child { border-bottom: 0; }
    .co-vote { flex: 0 0 auto; width: 54px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); padding: 6px 0; text-align: center; cursor: pointer; font: inherit; color: inherit; }
    .co-vote b { display: block; font-size: 16px; font-variant-numeric: tabular-nums; }
    .co-vote.on { border-color: #16a34a; background: rgba(22,163,74,.12); }
    .co-vote:disabled { cursor: default; opacity: .65; }
    .co-main { flex: 1; min-width: 0; }
    .co-title { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
    .co-body { font-size: 13px; margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .co-note { font-size: 12.5px; margin: 6px 0 0; padding: 6px 9px; border-radius: 8px; background: var(--surface); border-left: 3px solid #6366f1; overflow-wrap: anywhere; }
    .co-pill { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); margin-right: 6px; white-space: nowrap; }
    .co-bar { height: 6px; border-radius: 3px; background: var(--surface); overflow: hidden; margin-top: 6px; }
    .co-bar i { display: block; height: 100%; background: #16a34a; }
    .co-form { display: grid; gap: 8px; }
    .co-form input, .co-form textarea, .co-form select { font: inherit; font-size: 14px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: inherit; width: 100%; box-sizing: border-box; }
    .co-form textarea { min-height: 84px; resize: vertical; }
    .co-form button { justify-self: start; }
    .co-log-row { display: grid; grid-template-columns: 84px 1fr; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
    .co-log-row:last-child { border-bottom: 0; }
    .co-coins { color: #15803d; font-weight: 700; white-space: nowrap; }
    .co-filter { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 8px; }
    @media (max-width: 520px) { .co-log-row { grid-template-columns: 1fr; gap: 2px; } }
  `;
  document.head.append(s);
})();

function coErr(e) {
  const m = String(e?.message || e || '');
  const code = Object.keys(CO_ERRORS).find(k => m.includes(k));
  return code ? CO_ERRORS[code] : 'Nie udało się: ' + m;
}
function coN(n) { return Math.round(Number(n) || 0).toLocaleString('pl-PL'); }

function coTab() { return activeTab === 'bugs' ? 'bugs' : 'community'; }
function coShowing() { return activeTab === 'community' || activeTab === 'bugs'; }

async function loadCommunity() {
  if (window.communityOpenView) { coView[coTab()] = window.communityOpenView; window.communityOpenView = null; }
  renderCommunity();
  await coFetch();
}

async function coFetch() {
  if (coLoading) return coLoading;
  coLoading = (async () => {
    const { data, error } = await sb.rpc('community_state');
    if (error) {
      console.error('community_state', error);
      if (!coState) {
        const body = document.getElementById(coTab() + '-body');
        if (body) body.replaceChildren(el('p', { className: 'co-muted' }, 'Głos Biura nie jest jeszcze gotowy po stronie serwera. Spróbuj później.'));
      }
      return;
    }
    coState = data;
    if (coShowing()) renderCommunity();
  })();
  try { await coLoading; } finally { coLoading = null; }
}

// Called by the realtime handler in index.html for every idea/log change.
// State is only worth fetching while someone is looking at it.
function communityOnChange() {
  if (!coShowing()) { coState = null; return; }
  clearTimeout(coRefreshTimer);
  coRefreshTimer = setTimeout(coFetch, 400);
}

function coWeekEnds() {
  const ws = coState?.week_start;
  if (!ws) return '';
  const end = new Date(ws + 'T00:00:00');
  end.setDate(end.getDate() + 7);
  const ms = end - Date.now();
  if (ms <= 0) return 'głosowanie właśnie się kończy';
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5);
  return 'koniec głosowania za ' + (d ? d + ' d ' : '') + h + ' h (poniedziałek 00:00)';
}

function renderCommunity() {
  const tab = coTab();
  const body = document.getElementById(tab + '-body');
  if (!body) return;
  const reward = coState?.reward ?? 5000, bugReward = coState?.bug_reward ?? 500;
  const tabs = tab === 'bugs'
    ? [['report', '🐞 Zgłoś błąd'], ['list', '📋 Wszystkie zgłoszenia'], ['log', '📜 Dziennik']]
    : [['ideas', '💡 Pomysły'], ['winners', '🏆 Zwycięzcy'], ['log', '📜 Dziennik']];
  const view = coView[tab];
  const nav = el('div', { className: 'co-tabs' });
  tabs.forEach(([k, label]) => nav.append(el('button', {
    className: 'co-tab' + (view === k ? ' on' : ''),
    onclick: () => { coView[tab] = k; renderCommunity(); },
  }, label)));

  const head = tab === 'bugs'
    ? el('div', { className: 'co-head' },
        el('h2', {}, '🐞 Zgłoszenia'),
        el('p', { className: 'co-lead' },
          'Coś nie działa? Zgłoś to. Claude co noc analizuje każde zgłoszenie i naprawia potwierdzone błędy. '
          + 'Za prawdziwy błąd dostajesz ' + coN(bugReward) + ' 🪙 (tylko pierwsze zgłoszenie danego błędu; '
          + 'za „to nie błąd" — nic). Każda decyzja z uzasadnieniem jest jawna w 📜 Dzienniku.'))
    : el('div', { className: 'co-head' },
        el('h2', {}, '🗳️ Pomysły — Głos Biura'),
        el('p', { className: 'co-lead' },
          'Wy decydujecie, co powstanie na portalu. Zgłaszaj pomysły i głosuj — co poniedziałek pomysł z największą '
          + 'liczbą głosów jest budowany automatycznie przez Claude, a jego autor dostaje ' + coN(reward) + ' 🪙. '
          + 'Wszystkie decyzje są jawne w 📜 Dzienniku.'));

  const content = el('div', {});
  if (!coState) content.append(el('div', { className: 'loading-center' }, el('div', { className: 'spinner' })));
  else if (view === 'ideas') coRenderIdeas(content);
  else if (view === 'winners') coRenderWinners(content);
  else if (view === 'report') coRenderReport(content);
  else if (view === 'list') coRenderTickets(content);
  else coRenderLog(content, tab === 'bugs' ? 'ticket' : 'idea');
  body.replaceChildren(head, nav, content);
}

// ── 💡 Pomysły ─────────────────────────────────────────────────────────────
function coRenderIdeas(root) {
  const ideas = coState.ideas || [];
  const thr = coState.threshold || 2;
  const mine = ideas.filter(i => i.author_id === me.id).length;
  const left = Math.max(0, (coState.ideas_per_week || 2) - mine);

  const list = el('div', { className: 'co-sec' },
    el('h3', {}, 'Pomysły tego tygodnia'),
    el('div', { className: 'co-muted' }, 'Aby wygrać, pomysł potrzebuje co najmniej ' + thr + ' '
      + plCount(thr, 'głosu', 'głosów', 'głosów') + ' (połowa aktywnych graczy) · ' + coWeekEnds()));
  if (!ideas.length) list.append(el('p', { className: 'co-muted' }, 'Jeszcze nikt nic nie zgłosił. Bądź pierwszy!'));
  ideas.forEach(i => {
    const own = i.author_id === me.id;
    const open = i.status === 'open';
    const vote = el('button', {
      className: 'co-vote' + (i.my_vote ? ' on' : ''),
      disabled: own || !open,
      title: own ? 'Twój pomysł' : !open ? 'Głosowanie zamknięte' : i.my_vote ? 'Cofnij głos' : 'Zagłosuj',
      onclick: () => coVote(i.id, vote),
    }, el('b', {}, String(i.votes)), i.my_vote ? '✓' : '▲');
    const pct = Math.min(100, Math.round(100 * i.votes / thr));
    const st = CO_IDEA_STATUS[i.status] || ['', i.status];
    const main = el('div', { className: 'co-main' },
      el('div', { className: 'co-title' }, i.title),
      el('div', { className: 'co-muted' }, (i.author_nick || 'Gracz') + ' · ' + relTime(i.created_at)
        + (open ? '' : ' · ' + st[0] + ' ' + st[1])),
      i.body ? el('div', { className: 'co-body' }, i.body) : null,
      open ? el('div', { className: 'co-bar' }, el('i', { style: { width: pct + '%' } })) : null,
      i.note ? el('div', { className: 'co-note' }, '🤖 ' + i.note) : null);
    list.append(el('div', { className: 'co-row' }, vote, main));
  });

  const title = el('input', { type: 'text', maxLength: 80, placeholder: 'Krótko: co dodać lub zmienić?' });
  const desc = el('textarea', { maxLength: 1000, placeholder: 'Opisz pomysł: jak miałoby to działać, dlaczego będzie fajne…' });
  const btn = el('button', { className: 'btn btn-primary', disabled: !left }, '💡 Zgłoś pomysł');
  btn.onclick = async () => {
    btn.disabled = true;
    const { error } = await sb.rpc('community_submit_idea', { p_title: title.value, p_body: desc.value });
    if (error) { toast(coErr(error)); btn.disabled = false; return; }
    toast('Pomysł dodany — zbieraj głosy!');
    await coFetch();
  };
  const form = el('div', { className: 'co-sec' },
    el('h3', {}, 'Nowy pomysł'),
    el('div', { className: 'co-muted' }, left
      ? 'Zostało Ci ' + left + ' ' + plCount(left, 'zgłoszenie', 'zgłoszenia', 'zgłoszeń') + ' w tym tygodniu.'
      : 'Wykorzystałeś limit pomysłów na ten tydzień.'),
    el('div', { className: 'co-form' }, title, desc, btn),
    el('div', { className: 'co-muted' }, 'Pomysł, który wymaga zmiany salda graczy, nagród, stawek lub uprawnień, zostanie zbudowany dopiero po akceptacji właściciela.'));
  root.append(list, form);
}

async function coVote(id, btn) {
  btn.disabled = true;
  const { error } = await sb.rpc('community_toggle_vote', { p_idea: id });
  if (error) { toast(coErr(error)); btn.disabled = false; return; }
  await coFetch();
}

// ── 🏆 Zwycięzcy ───────────────────────────────────────────────────────────
function coRenderWinners(root) {
  const rows = coState.history || [];
  const sec = el('div', { className: 'co-sec' }, el('h3', {}, 'Zwycięskie pomysły'));
  if (!rows.length) sec.append(el('p', { className: 'co-muted' }, 'Jeszcze żaden tydzień się nie zakończył.'));
  rows.forEach(i => {
    const st = CO_IDEA_STATUS[i.status] || ['', i.status];
    sec.append(el('div', { className: 'co-row' }, el('div', { className: 'co-main' },
      el('div', { className: 'co-title' }, st[0] + ' ' + i.title),
      el('div', { className: 'co-muted' },
        'Tydzień od ' + String(i.week_start).slice(8, 10) + '.' + String(i.week_start).slice(5, 7)
        + ' · ' + (i.author_nick || 'Gracz') + ' · ' + i.votes + ' ' + plCount(i.votes, 'głos', 'głosy', 'głosów')
        + ' · ' + st[1] + (i.shipped_at ? ' ' + fmtDateTime(i.shipped_at) : '')
        + (i.commit_sha ? ' · commit ' + String(i.commit_sha).slice(0, 7) : '')),
      i.body ? el('div', { className: 'co-body' }, i.body) : null,
      i.note ? el('div', { className: 'co-note' }, '🤖 ' + i.note) : null)));
  });
  root.append(sec);
}

// ── 🐞 Zgłoś błąd ──────────────────────────────────────────────────────────
function coRenderReport(root) {
  const fromTab = window.communityReportFrom || '';
  const kind = el('select', {},
    ...Object.entries(CO_KINDS).map(([k, l]) => el('option', { value: k }, l)));
  const title = el('input', { type: 'text', maxLength: 120, placeholder: 'Co nie działa? (krótko)' });
  const desc = el('textarea', { maxLength: 2000, placeholder: 'Co zrobiłeś, co się stało, czego się spodziewałeś? Na którym urządzeniu?' });
  const where = el('input', { type: 'text', maxLength: 40, value: fromTab, placeholder: 'Gdzie? (np. farm, bank, czat)' });
  const btn = el('button', { className: 'btn btn-primary' }, '🐞 Wyślij zgłoszenie');
  btn.onclick = async () => {
    btn.disabled = true;
    const meta = {
      build: typeof BUILD_ID === 'string' ? BUILD_ID.slice(0, 12) : null,
      ua: navigator.userAgent.slice(0, 200),
      screen: window.innerWidth + 'x' + window.innerHeight,
      at: new Date().toISOString(),
    };
    const { error } = await sb.rpc('community_submit_ticket', {
      p_kind: kind.value, p_title: title.value, p_body: desc.value, p_tab: where.value, p_meta: meta,
    });
    if (error) { toast(coErr(error)); btn.disabled = false; return; }
    window.communityReportFrom = '';
    toast('Dzięki! Claude przeanalizuje zgłoszenie tej nocy.');
    coView.bugs = 'list';
    await coFetch();
  };
  const form = el('div', { className: 'co-sec' },
    el('h3', {}, 'Zgłoś błąd lub problem'),
    el('div', { className: 'co-form' }, kind, title, desc, where, btn),
    el('div', { className: 'co-muted' },
      'Za potwierdzony, prawdziwy błąd: ' + coN(coState.bug_reward ?? 500) + ' 🪙 — płatne tylko pierwszemu zgłaszającemu. '
      + 'Opis exploita (np. sposobu na darmowe monety) widzisz tylko Ty, dopóki nie zostanie naprawiony.'));
  root.append(form);
  const mine = (coState.tickets || []).filter(t => t.author_id === me.id);
  if (mine.length) {
    const sec = el('div', { className: 'co-sec' }, el('h3', {}, 'Twoje zgłoszenia'));
    mine.forEach(t => sec.append(coTicketRow(t)));
    root.append(sec);
  }
}

// ── 📋 Wszystkie zgłoszenia ────────────────────────────────────────────────
function coRenderTickets(root) {
  const list = el('div', { className: 'co-sec' }, el('h3', {}, 'Wszystkie zgłoszenia'));
  const tickets = coState.tickets || [];
  if (!tickets.length) list.append(el('p', { className: 'co-muted' }, 'Brak zgłoszeń.'));
  tickets.forEach(t => list.append(coTicketRow(t)));
  root.append(list);
}

function coTicketRow(t) {
    const st = CO_TICKET_STATUS[t.status] || ['', t.status];
    return el('div', { className: 'co-row' }, el('div', { className: 'co-main' },
      el('div', { className: 'co-title' }, st[0] + ' ' + t.title),
      el('div', { className: 'co-muted' },
        el('span', { className: 'co-pill' }, CO_KINDS[t.kind] || t.kind),
        el('span', { className: 'co-pill' }, st[1]),
        t.severity ? el('span', { className: 'co-pill' }, 'waga: ' + t.severity) : null,
        (t.author_nick || 'Gracz') + ' · ' + relTime(t.created_at) + (t.tab ? ' · ' + t.tab : ''),
        t.rewarded_at ? el('span', { className: 'co-coins' }, ' · +' + coN(coState.bug_reward ?? 500) + ' 🪙') : null),
      t.body ? el('div', { className: 'co-body' }, t.body)
        : t.kind === 'exploit' ? el('div', { className: 'co-muted' }, '🔒 Szczegóły ukryte do czasu naprawy.') : null,
      t.note ? el('div', { className: 'co-note' }, '🤖 ' + t.note) : null));
}

// ── 📜 Dziennik ────────────────────────────────────────────────────────────
function coRenderLog(root, kind) {
  // The ideas log also carries week closures; each tab shows only its own half.
  const rows = (coState.log || []).filter(r => kind === 'ticket' ? r.ref_kind === 'ticket' : r.ref_kind !== 'ticket');
  const sec = el('div', { className: 'co-sec' },
    el('h3', {}, (kind === 'ticket' ? 'Dziennik zgłoszeń' : 'Dziennik pomysłów') + ' — każda decyzja i wypłata'),
    el('div', { className: 'co-muted' }, '🤖 = decyzja automatu (Claude), 👤 = akcja gracza.'));
  if (!rows.length) sec.append(el('p', { className: 'co-muted' }, 'Pusto.'));
  rows.forEach(r => {
    const what = r.event === 'submitted' ? (r.ref_kind === 'idea' ? '💡 zgłosił pomysł' : '🐞 wysłał zgłoszenie')
      : r.event === 'won' ? '🏆 pomysł wygrał tydzień'
      : r.event === 'lost' ? '· pomysł nie wygrał'
      : r.event === 'closed' ? '🗓️ tydzień zamknięty'
      : r.event === 'reward' ? '💰 wypłata'
      : (r.ref_kind === 'idea' ? (CO_IDEA_STATUS[r.status] || ['', r.status]).join(' ')
                               : (CO_TICKET_STATUS[r.status] || ['', r.status]).join(' '));
    sec.append(el('div', { className: 'co-log-row' },
      el('div', { className: 'co-muted', title: fmtDateTime(r.created_at) }, relTime(r.created_at)),
      el('div', {},
        (r.actor === 'player' ? '👤 ' : '🤖 '), el('b', {}, r.nick || ''), (r.nick ? ' · ' : ''), what,
        r.title ? ': „' + r.title + '”' : '',
        r.coins ? el('span', { className: 'co-coins' }, ' +' + coN(r.coins) + ' 🪙') : null,
        r.note ? el('div', { className: 'co-muted' }, r.note) : null)));
  });
  root.append(sec);
}
