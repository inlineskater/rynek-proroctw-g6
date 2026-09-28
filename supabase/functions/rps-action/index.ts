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

// „Papier, Kamień, Biuro G6" (rps) — a remake of ICQ's „RPS Online".
//
// A 7×6 board. Each side has 14 pieces on its two home rows: 12 fighters that
// are secretly ✊ kamień / ✋ papier / ✌️ nożyce (4 of each), one 🚩 flag and
// one 🕳️ trap. You see only what has been revealed in a fight. A fighter moves
// one square orthogonally; stepping onto an enemy is a fight in which both are
// revealed, rock-paper-scissors decides, the loser leaves the board. A tie
// makes both sides pick again in secret. Stepping onto a trap kills the
// attacker; stepping onto the flag wins the game.
//
// SERVER-AUTHORITATIVE, like Filler and Miny: the whole board lives in
// rps_round_secrets (no client grants) and the client only ever receives the
// sanitized view from viewFor(). There is no parity contract — the client
// highlights legal moves for convenience, the server re-checks every one.
// The opponent is always the server's bot (variant A: a seasonal week must be
// playable by one person alone), and the bot only uses what the player could
// also know: its own pieces and the player's REVEALED pieces.

const RPS_W = 7;
const RPS_H = 6;
const RPS_N = RPS_W * RPS_H;
const RPS_HOME_ROWS = 2;
const RPS_FIGHTERS = ["R", "P", "S"];
const RPS_BEATS = { R: "S", S: "P", P: "R" };   // key beats value
const RPS_MAX_PLIES = 400;                       // both sides together; hitting it is a loss
const RPS_MAX_SCORE = 3000;                      // mirrored by the CHECK-free cap below and by the UI
const RPS_ITEM_SCORE_PER_POINT = 20;
const ROUND_EXPIRES_SECONDS = 3600;
const PRIZES = [1000, 500, 200];

// Score: a win is worth 1000, +60 per own fighter still standing, + a tempo
// bonus that decays 8/move from 800. A loss still counts 25 per enemy fighter
// you took, so a close loss beats a quick one — but never beats a win.
function rpsScore(st) {
  const survivors = st.cells.filter((c) => c && c.o === 0 && RPS_FIGHTERS.includes(c.t)).length;
  if (st.result === "won") {
    return Math.min(RPS_MAX_SCORE, 1000 + 60 * survivors + Math.max(0, 800 - 8 * st.moves[0]));
  }
  return Math.min(RPS_MAX_SCORE, 25 * st.kills[0]);
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

// ── Board ────────────────────────────────────────────────────────────────────
// cells[i] = null | { o: 0 player / 1 bot, t: 'R'|'P'|'S'|'F'|'T', r: revealed,
// m: has moved }. Row 0 is the bot's back row, row 5 the player's.
const xy = (i) => [i % RPS_W, Math.floor(i / RPS_W)];
const idx = (x, y) => y * RPS_W + x;

function neighbors(i) {
  const [x, y] = xy(i);
  const out = [];
  if (y > 0) out.push(idx(x, y - 1));
  if (y < RPS_H - 1) out.push(idx(x, y + 1));
  if (x > 0) out.push(idx(x - 1, y));
  if (x < RPS_W - 1) out.push(idx(x + 1, y));
  return out;
}

function playerHome(i) {
  return Number.isInteger(i) && i >= (RPS_H - RPS_HOME_ROWS) * RPS_W && i < RPS_N;
}

function fighterMix() {
  const per = (RPS_W * RPS_HOME_ROWS - 2) / 3;
  const out = [];
  for (const t of RPS_FIGHTERS) for (let k = 0; k < per; k++) out.push(t);
  return shuffle(out);
}

function newState(flag, trap) {
  const cells = new Array(RPS_N).fill(null);

  const mine = fighterMix();
  for (let i = (RPS_H - RPS_HOME_ROWS) * RPS_W; i < RPS_N; i++) {
    const t = i === flag ? "F" : i === trap ? "T" : mine.pop();
    cells[i] = { o: 0, t, r: false, m: false };
  }

  // Bot layout: flag on its back row; the trap guards it (next to the flag)
  // most of the time, so "the piece beside the one that never moves" is a
  // real read rather than a sure thing.
  const botFlag = rnd(RPS_W);
  let botTrap;
  const guards = neighbors(botFlag).filter((i) => i < RPS_HOME_ROWS * RPS_W);
  if (rnd(100) < 60) botTrap = guards[rnd(guards.length)];
  else {
    do { botTrap = rnd(RPS_HOME_ROWS * RPS_W); } while (botTrap === botFlag);
  }
  const theirs = fighterMix();
  for (let i = 0; i < RPS_HOME_ROWS * RPS_W; i++) {
    const t = i === botFlag ? "F" : i === botTrap ? "T" : theirs.pop();
    cells[i] = { o: 1, t, r: false, m: false };
  }

  return {
    cells,
    turn: 0,
    pending: null,     // { from, to, att } while a tie waits for the player's pick
    moves: [0, 0],
    kills: [0, 0],     // fighters each side has taken (traps count for the trap's owner)
    fights: [0, 0],    // [fights the player won, fights the player was in]
    plies: 0,
    result: null,      // 'won' | 'lost'
    reason: null,
  };
}

function legalMoves(st, side) {
  const out = [];
  st.cells.forEach((c, i) => {
    if (!c || c.o !== side || !RPS_FIGHTERS.includes(c.t)) return;
    for (const j of neighbors(i)) {
      const d = st.cells[j];
      if (!d || d.o !== side) out.push([i, j]);
    }
  });
  return out;
}

function finish(st, result, reason) {
  st.result = result;
  st.reason = reason;
  st.turn = -1;
  st.pending = null;
}

// Resolves a fight between cells[from] (attacker) and cells[to]. Returns
// 'tie' when both must pick again; anything else means the ply is complete.
function resolveFight(st, from, to, events) {
  const a = st.cells[from];
  const d = st.cells[to];
  const s = a.o;
  a.r = true;

  if (d.t === "F") {
    d.r = true;
    st.cells[to] = a;
    st.cells[from] = null;
    events.push({ k: "fight", from, to, a: a.t, d: "F", out: "flag", side: s });
    finish(st, s === 0 ? "won" : "lost", "flag");
    return "done";
  }
  if (d.t === "T") {
    d.r = true;
    st.cells[from] = null;
    st.kills[1 - s]++;
    st.fights[1]++;                     // every fight involves the player
    if (s === 1) st.fights[0]++;
    events.push({ k: "fight", from, to, a: a.t, d: "T", out: "trap", side: s });
    return "done";
  }

  d.r = true;
  if (a.t === d.t) {
    st.pending = { from, to, att: s };
    events.push({ k: "fight", from, to, a: a.t, d: d.t, out: "tie", side: s });
    return "tie";
  }
  st.fights[1]++;
  if (RPS_BEATS[a.t] === d.t) {
    st.cells[to] = a;
    st.cells[from] = null;
    st.kills[s]++;
    if (s === 0) st.fights[0]++;
    events.push({ k: "fight", from, to, a: a.t, d: d.t, out: "att", side: s });
  } else {
    st.cells[from] = null;
    st.kills[1 - s]++;
    if (s === 1) st.fights[0]++;
    events.push({ k: "fight", from, to, a: a.t, d: d.t, out: "def", side: s });
  }
  return "done";
}

function applyMove(st, side, from, to, events) {
  const a = st.cells[from];
  a.m = true;
  st.moves[side]++;
  st.plies++;
  if (!st.cells[to]) {
    st.cells[to] = a;
    st.cells[from] = null;
    events.push({ k: "move", from, to, side });
    return "done";
  }
  return resolveFight(st, from, to, events);
}

// After a completed ply by `side`, hand the turn over — or end the game if
// the next side cannot move, or the ply ceiling is reached.
function passTurn(st, side) {
  if (st.result) return;
  if (st.plies >= RPS_MAX_PLIES) { finish(st, "lost", "plies"); return; }
  const next = 1 - side;
  if (!legalMoves(st, next).length) {
    finish(st, next === 0 ? "lost" : "won", "stuck");
    return;
  }
  st.turn = next;
}

// ── Bot ──────────────────────────────────────────────────────────────────────
// Scores every legal move from the information it is allowed to have: its own
// pieces, and the player's pieces only where revealed. Unknown player pieces
// are a gamble it takes more readily on the player's back row (flag country)
// and on pieces that have never moved (flags and traps never do — but it
// cannot tell a flag from a trap, exactly like the player).
function botPick(st) {
  const moves = legalMoves(st, 1);
  const myFlag = st.cells.findIndex((c) => c && c.o === 1 && c.t === "F");
  const threatsOnFlag = myFlag >= 0
    ? neighbors(myFlag).filter((j) => st.cells[j] && st.cells[j].o === 0)
    : [];

  const threatenedBy = (cell, t) => neighbors(cell).some((j) => {
    const p = st.cells[j];
    return p && p.o === 0 && p.r && RPS_BEATS[p.t] === t;
  });

  let best = null;
  let bestScore = -Infinity;
  for (const [from, to] of moves) {
    const me = st.cells[from];
    const target = st.cells[to];
    const [, fy] = xy(from);
    const [, ty] = xy(to);
    let score = rnd(16);

    if (target) {
      if (target.r) {
        if (target.t === "T") score -= 1000;
        else if (RPS_BEATS[me.t] === target.t) score += 120;
        else if (RPS_BEATS[target.t] === me.t) score -= 150;
        else score += 5;
      } else {
        score += 25 + (ty === RPS_H - 1 ? 20 : 0) + (target.m ? 0 : 10);
      }
      if (threatsOnFlag.includes(to)) score += 90;
    } else {
      score += (ty - fy) * 8;                      // advance
      if (threatenedBy(to, me.t)) score -= me.r ? 90 : 25;
      if (me.r && threatenedBy(from, me.t) && !threatenedBy(to, me.t)) score += 60;
      // Keep one fighter at home: stepping off the back row near the flag is
      // mildly discouraged while that side of the board is still quiet.
      if (myFlag >= 0 && neighbors(myFlag).includes(from) && fy < 2) score -= 12;
    }

    if (score > bestScore) { bestScore = score; best = [from, to]; }
  }
  return best;
}

// Runs bot plies until it is the player's turn again, the game ends, or a tie
// waits on the player.
function runBot(st, events) {
  while (!st.result && st.turn === 1 && !st.pending) {
    const pick = botPick(st);
    if (!pick) { finish(st, "won", "stuck"); return; }
    const res = applyMove(st, 1, pick[0], pick[1], events);
    if (res === "tie") return;
    passTurn(st, 1);
  }
}

// ── What the client may see ─────────────────────────────────────────────────
function viewFor(st) {
  const over = !!st.result;
  return {
    w: RPS_W,
    h: RPS_H,
    cells: st.cells.map((c) => {
      if (!c) return null;
      const visible = c.o === 0 || c.r || over;   // the whole board is shown once it's over
      return { o: c.o, t: visible ? c.t : null, r: c.r, m: c.m };
    }),
    turn: st.turn,
    pending: st.pending,
    moves: st.moves,
    kills: st.kills,
    plies: st.plies,
    maxPlies: RPS_MAX_PLIES,
    result: st.result,
    reason: st.reason,
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

const SEASONAL_SCORE_BONUS_GAMES = ['whack_boss', 'bug_jumper', 'flappy_pants', 'snake', 'invoice_horde', 'var_patrol', 'egg_catch', 'super_mariusz', 'popup_panic', 'tetris', 'bubble_breaker', 'saper', 'arkanoid', 'rps'];

async function getStrongestHeroEffect(tx, userId, game) {
  try {
    const rows = await tx`
      select d.slug, d.name, d.emoji, d.effect_game, d.effect_type, d.effect_value
      from public.hero_item_instances i
      join public.hero_item_defs d on d.id = i.item_def_id
      where i.owner_id = ${userId}
        and d.is_active = true
        and (i.expires_at is null or i.expires_at > now())
        and (
          d.effect_game = ${game}
          or (d.effect_type = 'score_bonus' and d.effect_game = any(${SEASONAL_SCORE_BONUS_GAMES}::text[]))
        )
      order by d.effect_value desc, d.price desc, d.slug
      limit 1
    `;
    return rows[0] ?? null;
  } catch (err) {
    console.warn("Hero item effects unavailable:", err?.message ?? err);
    return null;
  }
}

function mapRows(rows) {
  return (rows || []).map((row) => ({
    ...row,
    rank: asInt(row.rank),
    score: asInt(row.score),
    base_score: asInt(row.base_score, asInt(row.score)),
    item_bonus: asInt(row.item_bonus),
    survivors: asInt(row.survivors),
    kills: asInt(row.kills),
    moves: asInt(row.moves),
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
    board: viewFor(secret.state),
  };
}

// Active round of this user, locked; an expired one is closed as abandoned.
async function lockActiveRound(tx, userId) {
  const [round] = await tx`
    select * from public.rps_rounds
    where user_id = ${userId} and status = 'active'
    for update
  `;
  if (!round) return null;
  if (new Date(round.expires_at).getTime() < Date.now()) {
    await tx`update public.rps_rounds set status = 'abandoned', finished_at = now() where id = ${round.id}`;
    return null;
  }
  const [secret] = await tx`select state from public.rps_round_secrets where round_id = ${round.id}`;
  if (!secret) return null;
  return { round, secret };
}

async function loadBoards(userId) {
  const [weekRow] = await db`select public.rps_week_start(now()) as week_start`;
  const weekly = await db`select * from public.rps_current_week order by rank limit 20`;
  const allTime = await db`select * from public.rps_all_time order by rank limit 20`;
  const awards = await db`select * from public.rps_recent_awards order by week_start desc, rank asc limit 12`;
  const [myWeekly] = await db`select * from public.rps_current_week where user_id = ${userId}`;
  return {
    weekStart: weekRow?.week_start,
    prizes: PRIZES,
    weekly: mapRows(weekly),
    allTime: mapRows(allTime),
    awards: mapAwards(awards),
    myWeekly: myWeekly ? mapRows([myWeekly])[0] : null,
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
  const flag = asInt(body.flag, -1);
  const trap = asInt(body.trap, -1);
  if (!playerHome(flag) || !playerHome(trap) || flag === trap) {
    throw gameError("Ustaw flagę i pułapkę na dwóch różnych polach swoich dwóch rzędów.");
  }
  const mode = body.mode === "arcade" ? "arcade" : "season";

  const result = await db.begin(async (tx) => {
    const [profile] = await tx`select id, nick from public.profiles where id = ${userId} for update`;
    if (!profile) throw gameError("Profil nie istnieje.");
    // One active match per user: starting a new one forfeits the old (no score).
    await tx`
      update public.rps_rounds set status = 'abandoned', finished_at = now()
      where user_id = ${userId} and status = 'active'
    `;
    const state = newState(flag, trap);
    const [round] = await tx`
      insert into public.rps_rounds (user_id, nick_snapshot, mode, expires_at)
      values (${userId}, ${profile.nick}, ${mode}, now() + (${ROUND_EXPIRES_SECONDS} || ' seconds')::interval)
      returning *
    `;
    await tx`insert into public.rps_round_secrets (round_id, state) values (${round.id}, ${JSON.stringify(state)}::jsonb)`;
    return { round, secret: { state } };
  });

  return { round: roundPayload(result.round, result.secret), events: [] };
}

// Writes the finished match: the round row, and either the seasonal score or
// the free-arcade score (written as service role, like Filler, since the
// result is server-derived and needs no client-callable RPC).
async function settle(tx, round, st, userId) {
  const baseScore = rpsScore(st);
  let scoreValue = baseScore;
  let itemEffect = null;
  const durationMs = Math.max(0, Math.min(2147483647, Date.now() - new Date(round.started_at).getTime()));
  const survivors = st.cells.filter((c) => c && c.o === 0 && RPS_FIGHTERS.includes(c.t)).length;
  const accuracy = st.fights[1] > 0 ? Math.round((st.fights[0] / st.fights[1]) * 10000) / 100 : 0;

  if (round.mode === "season") {
    const effect = await getStrongestHeroEffect(tx, userId, "rps");
    const bonus = effect?.effect_type === "score_bonus" && baseScore > 0
      ? Math.max(0, asInt(effect.effect_value, 0)) * RPS_ITEM_SCORE_PER_POINT
      : 0;
    scoreValue = Math.min(RPS_MAX_SCORE, baseScore + bonus);
    if (scoreValue > baseScore) {
      itemEffect = { slug: effect.slug, name: effect.name, type: effect.effect_type, value: Number(effect.effect_value), bonus: scoreValue - baseScore };
    }
    await tx`
      insert into public.rps_scores
        (round_id, user_id, nick_snapshot, week_start, score, won, survivors, kills, moves, duration_ms, accuracy, client_meta)
      values (
        ${round.id}, ${userId}, ${round.nick_snapshot}, public.rps_week_start(now()), ${scoreValue},
        ${st.result === "won"}, ${survivors}, ${st.kills[0]}, ${st.moves[0]}, ${durationMs}, ${accuracy},
        ${JSON.stringify({ server_validated: true, base_score: baseScore, item_effect: itemEffect, reason: st.reason })}::jsonb
      )
      on conflict (round_id) do nothing
    `;
  } else {
    await tx`
      insert into public.arcade_scores (user_id, game_type, score, coins_paid, client_meta)
      values (${userId}, 'rps', ${scoreValue}, 0, ${JSON.stringify({ won: st.result === "won", kills: st.kills[0], moves: st.moves[0] })}::jsonb)
    `;
  }

  await tx`
    update public.rps_rounds
    set status = ${st.result}, score = ${scoreValue}, finished_at = now()
    where id = ${round.id}
  `;
  return { score: scoreValue, baseScore, itemEffect, won: st.result === "won", survivors, kills: st.kills[0], moves: st.moves[0] };
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
      finish(st, "lost", "resign");
    } else if (action === "move") {
      if (st.pending) throw gameError("Najpierw rozstrzygnij remis.");
      if (st.turn !== 0) throw gameError("To nie twój ruch.");
      const from = asInt(body.from, -1);
      const to = asInt(body.to, -1);
      const legal = legalMoves(st, 0).some(([f, t]) => f === from && t === to);
      if (!legal) throw gameError("Niedozwolony ruch.");
      const res = applyMove(st, 0, from, to, events);
      if (res !== "tie") { passTurn(st, 0); runBot(st, events); }
    } else if (action === "tie") {
      if (!st.pending) throw gameError("Nie ma remisu do rozstrzygnięcia.");
      const choice = String(body.choice ?? "");
      if (!RPS_FIGHTERS.includes(choice)) throw gameError("Wybierz kamień, papier albo nożyce.");
      const { from, to, att } = st.pending;
      const mineAt = att === 0 ? from : to;
      const theirsAt = att === 0 ? to : from;
      st.cells[mineAt].t = choice;
      st.cells[theirsAt].t = RPS_FIGHTERS[rnd(3)];   // drawn independently of the player's pick
      st.pending = null;
      const res = resolveFight(st, from, to, events);
      if (res !== "tie") { passTurn(st, att); runBot(st, events); }
    } else {
      throw gameError("Nieznana akcja.");
    }

    let summary = null;
    if (st.result) summary = await settle(tx, round, st, userId);
    else {
      await tx`update public.rps_rounds set moves = ${st.moves[0]} where id = ${round.id}`;
    }
    await tx`update public.rps_round_secrets set state = ${JSON.stringify(st)}::jsonb where round_id = ${round.id}`;

    const status = st.result || "active";
    return {
      round: { id: round.id, mode: round.mode, status, score: summary?.score ?? 0, board: viewFor(st) },
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
    else if (action === "move" || action === "tie" || action === "resign") result = await playAction(user.id, body, action);
    else throw gameError("Nieznana akcja.");

    return json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err?.isGame ? err.message : "Błąd serwera." });
  }
});
