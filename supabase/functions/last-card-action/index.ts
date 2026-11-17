// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://inlineskater.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const databaseUrl = Deno.env.get("SUPABASE_DB_URL");
const db = databaseUrl
  ? postgres(databaseUrl, { prepare: false, max: 4, idle_timeout: 20 })
  : null;

// „Ostatnia Karta G6" (last_card) — a shedding card game for one player and
// three office bots (🤖 Kadry, 🤖 Księgowość, 🤖 IT). Głos Biura's first
// winning idea (2026-11-09: „gra sezonowa: uno").
//
// 108 cards: four colours (r/y/g/b), each with one 0, two of 1–9, two ⏭️
// Urlop (skip), two 🔁 Zmiana kierunku (reverse) and two +2 Nadgodziny; plus
// four 🌈 Zmiana priorytetów (wild) and four +4 Deadline (wild draw four).
// Seven cards each. On your turn play a card matching the colour or the
// symbol of the top card, or a wild; otherwise draw one — if it fits you may
// play it at once, else the turn passes. Going down to one card you must call
// „Ostatnia!", or you draw two. First to empty their hand wins.
//
// SERVER-AUTHORITATIVE, like rps/Filler/Miny: the deck and the bots' hands
// live in last_card_round_secrets (no client grants); the client only ever
// receives viewFor(). There is no parity contract. The bots use only what a
// player could know: their own hand, the top card, and everyone's card count.
//
// Ranking (voted with the idea): a WIN ranks by the fewest of your turns at
// the table — turns lost to ⏭️ / +2 / +4 count, a turn is a turn — and every
// win beats every non-win; below that, by the best place in the match.
// Encoded in one integer so the shared `score DESC, submitted_at ASC` stack
// works unchanged (lcScore below; index.html lcScoreLabel() decodes it).

// Card codes are two characters: colour + value. Values 0–9, S skip,
// R reverse, D draw two; wilds are colour 'w' with W (wild) or F (draw four).
// The wild values are letters on purpose: 'w4' would "match" a yellow 4.
const LC_SEATS = 4;
const LC_HAND = 7;
const LC_COLORS = ["r", "y", "g", "b"];
const LC_MAX_PLIES = 900;            // all seats together; hitting it ends the match on card counts
const LC_TURN_CAP = 200;             // a win slower than this still scores the 1000 floor
const LC_DAILY_SEASON_MATCHES = 30;  // limits re-dealing for a dream hand (Warsaw day)
const ROUND_EXPIRES_SECONDS = 3600;
const PRIZES = [1000, 500, 200];

// Win: 1000 + 10 per turn under 200 (7 turns → 2930). Otherwise
// (5 − place) × 100 + up to 49 for fewer cards left: 2nd 300–349, 3rd
// 200–249, 4th 100–149 (a plies-cap 1st without a win: 400–449). Resign: 0.
function lcScore(st) {
  if (st.reason === "resign") return 0;
  if (st.result === "won") return 1000 + 10 * Math.max(0, LC_TURN_CAP - st.turns);
  return (5 - st.place) * 100 + Math.max(0, 49 - st.hands[0].length);
}

// ── Randomness (crypto; the bias of % on a 32-bit draw is negligible here) ───
function rnd(n) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Cards ────────────────────────────────────────────────────────────────────
const isWild = (c) => c[0] === "w";
const isNumber = (c) => c[1] >= "0" && c[1] <= "9";
const cardPoints = (c) => (isWild(c) ? 50 : isNumber(c) ? Number(c[1]) : 20);
const LC_ORDER = "0123456789SRDWF";

function buildDeck() {
  const d = [];
  for (const c of LC_COLORS) {
    d.push(c + "0");
    for (const v of "123456789SRD") d.push(c + v, c + v);
  }
  for (let k = 0; k < 4; k++) d.push("wW", "wF");
  return shuffle(d);
}

function sortHand(h) {
  const ci = (c) => (isWild(c) ? 9 : LC_COLORS.indexOf(c[0]));
  return [...h].sort((a, b) => ci(a) - ci(b) || LC_ORDER.indexOf(a[1]) - LC_ORDER.indexOf(b[1]));
}

const topCard = (st) => st.discard[st.discard.length - 1];

function fits(st, c) {
  if (isWild(c)) return true;
  const top = topCard(st);
  return c[0] === st.color || (!isWild(top) && c[1] === top[1]);
}

const nextSeat = (st, from) => (((from + st.dir) % LC_SEATS) + LC_SEATS) % LC_SEATS;

function newState() {
  const deck = buildDeck();
  const hands = [[], [], [], []];
  for (let k = 0; k < LC_HAND; k++) for (let s = 0; s < LC_SEATS; s++) hands[s].push(deck.pop());
  // The starting card is always a plain number: no first-turn actions.
  const i = deck.findIndex((c) => !isWild(c) && isNumber(c));
  const [top] = deck.splice(i, 1);
  return {
    deck,
    discard: [top],
    hands,
    color: top[0],
    dir: 1,            // 1: 0 → 1 → 2 → 3 (you → Kadry → Księgowość → IT)
    turn: 0,           // the player always opens
    drawn: null,       // card the player just drew and may still play
    turns: 0,          // the player's turns at the table (incl. skipped ones)
    played: 0,         // ...of which the player played a card
    plies: 0,
    result: null,      // 'won' | 'lost'
    reason: null,      // 'out' | 'plies' | 'resign'
    winner: null,
    place: null,
  };
}

// Draws up to n for `seat`, reshuffling the discard (all but the top) into
// the deck when it runs out. Returns the cards drawn.
function drawCards(st, seat, n, events) {
  const got = [];
  for (let k = 0; k < n; k++) {
    if (!st.deck.length) {
      if (st.discard.length <= 1) break;
      const top = st.discard.pop();
      st.deck = shuffle(st.discard);
      st.discard = [top];
      events.push({ k: "shuffle" });
    }
    got.push(st.deck.pop());
  }
  st.hands[seat].push(...got);
  return got;
}

function finish(st, winner, reason) {
  st.result = winner === 0 ? "won" : "lost";
  st.reason = reason;
  st.winner = winner;
  st.turn = -1;
  st.drawn = null;
  if (reason === "resign") { st.place = LC_SEATS; return; }
  // Place = 1 + the seats strictly ahead of you: the winner, then fewer
  // cards, then fewer card points. Ties go your way.
  const key = (s) => [s === winner ? 0 : 1, st.hands[s].length, st.hands[s].reduce((a, c) => a + cardPoints(c), 0)];
  const mine = key(0);
  let ahead = 0;
  for (let s = 1; s < LC_SEATS; s++) {
    const k = key(s);
    const cmp = k[0] - mine[0] || k[1] - mine[1] || k[2] - mine[2];
    if (cmp < 0) ahead++;
  }
  st.place = 1 + ahead;
}

// After `seat` finished its turn (having played `card`, or null for a
// draw/pass), applies the card's effect and hands the turn on.
function endTurn(st, seat, card, events) {
  st.drawn = null;
  let skip = false;
  if (card) {
    const v = card[1];
    if (v === "R") { st.dir = -st.dir; events.push({ k: "rev", dir: st.dir }); }
    if (v === "S") skip = true;
    if (v === "D" || v === "F") {
      const victim = nextSeat(st, seat);
      const got = drawCards(st, victim, v === "D" ? 2 : 4, events);
      events.push({ k: "draw", seat: victim, n: got.length, why: v, ...(victim === 0 ? { cards: got } : {}) });
      skip = true;
    }
  }
  let nxt = nextSeat(st, seat);
  if (skip) {
    events.push({ k: "skip", seat: nxt });
    if (nxt === 0) st.turns++;           // a lost turn is still a turn
    nxt = nextSeat(st, nxt);
  }
  st.turn = nxt;
  if (st.plies >= LC_MAX_PLIES) {
    finish(st, null, "plies");
    events.push({ k: "end", reason: "plies" });
  }
}

function playCard(st, seat, card, color, called, events) {
  const hand = st.hands[seat];
  hand.splice(hand.indexOf(card), 1);
  st.discard.push(card);
  st.color = isWild(card) ? color : card[0];
  st.plies++;
  events.push({ k: "play", seat, card, color: st.color });
  if (!hand.length) {
    finish(st, seat, "out");
    events.push({ k: "end", reason: "out", winner: seat });
    return;
  }
  if (hand.length === 1) {
    if (called) events.push({ k: "last", seat });
    else {
      const got = drawCards(st, seat, 2, events);
      events.push({ k: "draw", seat, n: got.length, why: "forgot", ...(seat === 0 ? { cards: got } : {}) });
    }
  }
  endTurn(st, seat, card, events);
}

// Draw for the turn. Returns true when the drawn card fits and may be played.
function drawForTurn(st, seat, events) {
  st.plies++;
  const got = drawCards(st, seat, 1, events);
  events.push({ k: "draw", seat, n: got.length, why: "turn", ...(seat === 0 ? { cards: got } : {}) });
  if (got.length && fits(st, got[0])) { st.drawn = got[0]; return true; }
  endTurn(st, seat, null, events);
  return false;
}

// ── Bots ─────────────────────────────────────────────────────────────────────
// Each bot sees its own hand, the top card/colour and the card counts. It
// keeps wilds for when nothing else fits, dumps high-point cards, sticks to
// the colour it holds most of, and turns aggressive (⏭️ / +2 / +4) on a
// neighbour close to going out.
function bestColor(hand) {
  const n = { r: 0, y: 0, g: 0, b: 0 };
  for (const c of hand) if (!isWild(c)) n[c[0]] += 1 + cardPoints(c) / 40;
  const max = Math.max(...Object.values(n));
  const top = LC_COLORS.filter((c) => n[c] === max);
  return top[rnd(top.length)];
}

function botPick(st, s) {
  const hand = st.hands[s];
  const options = [...new Set(hand.filter((c) => fits(st, c)))];
  if (!options.length) return null;
  const nextCount = st.hands[nextSeat(st, s)].length;
  const danger = nextCount <= 2;
  const mine = (col) => hand.filter((c) => c[0] === col).length;
  let best = null;
  let bestScore = -Infinity;
  for (const c of options) {
    let score = rnd(6) + cardPoints(c) / 2;
    if (isWild(c)) score -= c[1] === "F" ? 45 : 35;
    else score += 3 * mine(c[0]);
    if (danger) {
      if (c[1] === "F") score += 90;
      if (c[1] === "D") score += 70;
      if (c[1] === "S") score += 55;
      if (c[1] === "R") score += 25;
    }
    if (hand.length === 2 && isWild(c)) score += 40;   // a wild as the last-but-one card is a sure exit
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

function botTurn(st, s, events) {
  const pick = botPick(st, s);
  if (pick) {
    playCard(st, s, pick, bestColor(st.hands[s].filter((c) => c !== pick)), true, events);
    return;
  }
  if (drawForTurn(st, s, events)) {
    const c = st.drawn;
    playCard(st, s, c, bestColor(st.hands[s].filter((x) => x !== c)), true, events);
  }
}

// Runs bot turns until it is the player's turn again or the match ends.
function runBots(st, events) {
  let guard = 0;
  while (!st.result && st.turn !== 0 && guard++ < LC_MAX_PLIES * 2) botTurn(st, st.turn, events);
}

// ── What the client may see ─────────────────────────────────────────────────
function viewFor(st) {
  const over = !!st.result;
  return {
    hand: sortHand(st.hands[0]),
    counts: st.hands.map((h) => h.length),
    top: topCard(st),
    color: st.color,
    dir: st.dir,
    turn: st.turn,
    drawn: st.drawn,
    deck: st.deck.length,
    turns: st.turns,
    plies: st.plies,
    maxPlies: LC_MAX_PLIES,
    result: st.result,
    reason: st.reason,
    winner: st.winner,
    place: st.place,
    hands: over ? st.hands.map(sortHand) : null,   // every hand is shown once it's over
  };
}

// ── Plumbing ────────────────────────────────────────────────────────────────
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function gameError(message) {
  const err = new Error(message);
  err.isGame = true;
  return err;
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function requireUser(req) {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) throw gameError("Musisz być zalogowany.");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) throw new Error("Missing Supabase environment.");

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) throw gameError("Sesja wygasła. Zaloguj się ponownie.");
  return data.user;
}

function mapRows(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    place: asInt(row.place),
    turns: asInt(row.turns),
    cards_left: asInt(row.cards_left),
    wins: asInt(row.wins),
    duration_ms: asInt(row.duration_ms),
    rounds_played: asInt(row.rounds_played),
    accuracy: asNumber(row.accuracy),
  }));
}

function mapAwards(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    duration_ms: asInt(row.duration_ms),
    prize_coins: asInt(row.prize_coins),
  }));
}

function roundPayload(round, secret) {
  if (!round) return null;
  return {
    id: round.id,
    mode: round.mode,
    status: round.status,
    score: asInt(round.score),
    table: viewFor(secret.state),
  };
}

// Active round of this user, locked; an expired one is closed as abandoned.
async function lockActiveRound(tx, userId) {
  const [round] = await tx`
    select * from public.last_card_rounds
    where user_id = ${userId} and status = 'active'
    for update
  `;
  if (!round) return null;
  if (new Date(round.expires_at).getTime() < Date.now()) {
    await tx`update public.last_card_rounds set status = 'abandoned', finished_at = now() where id = ${round.id}`;
    return null;
  }
  const [secret] = await tx`select state from public.last_card_round_secrets where round_id = ${round.id}`;
  if (!secret) return null;
  if (typeof secret.state === "string") secret.state = JSON.parse(secret.state);
  return { round, secret };
}

async function seasonMatchesToday(q, userId) {
  const [row] = await q`
    select count(*)::int as n from public.last_card_rounds
    where user_id = ${userId} and mode = 'season'
      and created_at >= (date_trunc('day', now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw')
  `;
  return asInt(row?.n);
}

async function loadBoards(userId) {
  const [weekRow] = await db`select public.last_card_week_start(now()) as week_start`;
  const weekly = await db`select * from public.last_card_current_week order by rank limit 20`;
  const allTime = await db`select * from public.last_card_all_time order by rank limit 20`;
  const awards = await db`select * from public.last_card_recent_awards order by week_start desc, rank asc limit 12`;
  const [myWeekly] = await db`select * from public.last_card_current_week where user_id = ${userId}`;
  return {
    weekStart: weekRow?.week_start,
    prizes: PRIZES,
    weekly: mapRows(weekly),
    allTime: mapRows(allTime),
    awards: mapAwards(awards),
    myWeekly: myWeekly ? mapRows([myWeekly])[0] : null,
    seasonToday: await seasonMatchesToday(db, userId),
    seasonDailyCap: LC_DAILY_SEASON_MATCHES,
  };
}

async function loadState(userId) {
  if (!db) throw new Error("Database is not configured.");
  const [profile] = await db`select id, nick, coins from public.profiles where id = ${userId}`;
  if (!profile) throw gameError("Profil nie istnieje.");
  const active = await db.begin((tx) => lockActiveRound(tx, userId));
  return {
    profile: { id: profile.id, nick: profile.nick, coins: asInt(profile.coins) },
    ...(await loadBoards(userId)),
    round: active ? roundPayload(active.round, active.secret) : null,
  };
}

async function startRound(userId, body) {
  if (!db) throw new Error("Database is not configured.");
  const mode = body.mode === "arcade" ? "arcade" : "season";

  const result = await db.begin(async (tx) => {
    const [profile] = await tx`select id, nick from public.profiles where id = ${userId} for update`;
    if (!profile) throw gameError("Profil nie istnieje.");
    if (mode === "season" && (await seasonMatchesToday(tx, userId)) >= LC_DAILY_SEASON_MATCHES) {
      throw gameError(`Limit ${LC_DAILY_SEASON_MATCHES} partii rankingowych na dziś wyczerpany. Jutro kolejne — a w „Wszystkich Grach" możesz grać bez limitu.`);
    }
    // One active match per user: starting a new one forfeits the old (no score).
    await tx`
      update public.last_card_rounds set status = 'abandoned', finished_at = now()
      where user_id = ${userId} and status = 'active'
    `;
    const state = newState();
    const [round] = await tx`
      insert into public.last_card_rounds (user_id, nick_snapshot, mode, expires_at)
      values (${userId}, ${profile.nick}, ${mode}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
      returning *
    `;
    await tx`insert into public.last_card_round_secrets (round_id, state) values (${round.id}, ${db.json(state)})`;
    return { round, secret: { state } };
  });

  return { round: roundPayload(result.round, result.secret), events: [] };
}

// Writes the finished match: the round row, and either the seasonal score or
// the free-arcade score (service role, like rps/Filler — the result is
// server-derived and needs no client-callable RPC). No hero-item bonus: the
// voted ranking is turns and places, which a flat bonus would muddle.
async function settle(tx, round, st, userId) {
  const scoreValue = lcScore(st);
  const durationMs = Math.max(0, Math.min(2147483647, Date.now() - new Date(round.started_at).getTime()));
  const cardsLeft = st.hands[0].length;
  const accuracy = st.turns > 0 ? Math.round((st.played / st.turns) * 10000) / 100 : 0;
  const won = st.result === "won";

  if (round.mode === "season") {
    await tx`
      insert into public.last_card_scores
        (round_id, user_id, nick_snapshot, week_start, score, won, place, turns, cards_left, duration_ms, accuracy, client_meta)
      values (
        ${round.id}, ${userId}, ${round.nick_snapshot}, public.last_card_week_start(now()), ${scoreValue},
        ${won}, ${st.place}, ${st.turns}, ${cardsLeft}, ${durationMs}, ${Math.min(100, accuracy)},
        ${db.json({ server_validated: true, base_score: scoreValue, reason: st.reason, plies: st.plies })}
      )
      on conflict (round_id) do nothing
    `;
  } else {
    await tx`
      insert into public.arcade_scores (user_id, game_type, score, coins_paid, client_meta)
      values (${userId}, 'last_card', ${scoreValue}, 0, ${db.json({ won, place: st.place, turns: st.turns })})
    `;
  }

  await tx`
    update public.last_card_rounds
    set status = ${st.result}, score = ${scoreValue}, turns = ${st.turns}, finished_at = now()
    where id = ${round.id}
  `;
  return { score: scoreValue, won, place: st.place, turns: st.turns, cardsLeft };
}

async function playAction(userId, body, action) {
  if (!db) throw new Error("Database is not configured.");

  const out = await db.begin(async (tx) => {
    const active = await lockActiveRound(tx, userId);
    if (!active) throw gameError("Nie masz trwającej partii.");
    const { round } = active;
    const st = active.secret.state;
    const events = [];

    if (action === "resign") {
      finish(st, null, "resign");
    } else {
      if (st.turn !== 0) throw gameError("To nie twój ruch.");
      if (action === "play") {
        const card = String(body.card ?? "");
        if (!st.hands[0].includes(card)) throw gameError("Nie masz takiej karty.");
        if (st.drawn && card !== st.drawn) throw gameError("Po dobraniu możesz zagrać tylko dobraną kartę.");
        if (!fits(st, card)) throw gameError("Ta karta nie pasuje do stosu.");
        const color = String(body.color ?? "");
        if (isWild(card) && !LC_COLORS.includes(color)) throw gameError("Wybierz kolor.");
        if (!st.drawn) st.turns++;
        st.played++;
        playCard(st, 0, card, color, body.last === true, events);
      } else if (action === "draw") {
        if (st.drawn) throw gameError("Już dobrałeś — zagraj dobraną kartę albo pasuj.");
        st.turns++;
        drawForTurn(st, 0, events);
      } else if (action === "pass") {
        if (!st.drawn) throw gameError("Pasować można dopiero po dobraniu karty.");
        endTurn(st, 0, null, events);
      } else {
        throw gameError("Nieznana akcja.");
      }
      runBots(st, events);
    }

    let summary = null;
    if (st.result) summary = await settle(tx, round, st, userId);
    else await tx`update public.last_card_rounds set turns = ${st.turns} where id = ${round.id}`;
    await tx`update public.last_card_round_secrets set state = ${db.json(st)}, updated_at = now() where round_id = ${round.id}`;

    const status = st.result || "active";
    return {
      round: { id: round.id, mode: round.mode, status, score: summary?.score ?? 0, table: viewFor(st) },
      events,
      summary,
    };
  });

  if (out.summary && out.round.mode === "season") {
    return { ...out, ...(await loadBoards(userId)) };
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "state");

    let result;
    if (action === "state") result = await loadState(user.id);
    else if (action === "start") result = await startRound(user.id, body);
    else if (["play", "draw", "pass", "resign"].includes(action)) result = await playAction(user.id, body, action);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
